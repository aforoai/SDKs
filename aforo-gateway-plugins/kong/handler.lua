-- Aforo Metering Plugin for Kong Gateway
-- Runs in `access` and `log` phases to capture API usage events and
-- forward them to Aforo's usage ingestor service.
--
-- access phase: stashes W3C trace context + the request body (MCP/GraphQL
--               detectors), then the optional JWT / rate-limit / margin-guard
--               checks (all off by default)
-- log phase: detects MCP / gRPC / GraphQL / WebSocket / plain HTTP, builds the
--            event payload and buffers it for batch flush
--
-- SINGLE SOURCE: this file is the canonical copy. aforo-nextgen-docker
-- (kong/plugins/aforo-metering/) ships byte-identical copies, enforced by
-- that repo's kong/scripts/check-plugin-sync.sh. Change it HERE, then run
-- `check-plugin-sync.sh --sync` in the docker repo. Never edit the deploy copy.
--
-- Zero latency impact on the critical path: metering runs in post-response log phase.
-- Batched: buffers events in shared memory, flushes from a timer.
-- Retry: transient failures (network, 5xx, 408, 429 with Retry-After) are
-- retried and re-buffered; a permanent 4xx is dropped and counted. Every
-- attempt re-sends the buffered bytes, so idempotency keys never change.

local http = require("resty.http")
local cjson = require("cjson.safe")
-- Sibling plugin modules.
--
-- These were previously required by bare filename, which resolves only when the
-- process happens to have this directory on package.path. Under a real Kong
-- install it does not, so the plugin died at load with
-- "module 'rate-limit-enforce' not found" and never registered.
--
-- Installed via the rockspec, the siblings live at
-- kong.plugins.aforo-metering.*; running busted from this source directory they
-- resolve as bare filenames (the repo keeps the .lua files flat rather than in a
-- kong/plugins/aforo-metering/ tree). Try the installed path first and fall back
-- to the source-tree name so the one file works in both.
local function require_sibling(name)
    local ok, mod = pcall(require, "kong.plugins.aforo-metering." .. name)
    if ok then
        return mod
    end
    return require(name)
end

local rate_limit = require_sibling("rate-limit-enforce")
local margin_guard = require_sibling("margin-guard")
local preflight_quota = require_sibling("preflight-quota")

-- ────────────────────────────────────────────────────────────
-- JWT Validation helpers
-- ────────────────────────────────────────────────────────────

-- Extract Bearer token from Authorization header
local function extract_bearer_token()
    local auth_header = kong.request.get_header("Authorization")
    if not auth_header then return nil end
    local _, _, token = string.find(auth_header, "^[Bb]earer%s+(.+)$")
    return token
end

-- Decode base64url to bytes
local function base64url_decode(str)
    str = str:gsub("-", "+"):gsub("_", "/")
    local pad = 4 - (#str % 4)
    if pad < 4 then str = str .. string.rep("=", pad) end
    return ngx.decode_base64(str)
end

-- Parse a JWT into {header, claims, parts} without crypto verification.
-- Returns (claims_table, parts_array) on success, or (nil, err_string) on failure.
local function parse_jwt_claims(token)
    local parts = {}
    for part in token:gmatch("([^.]+)") do
        table.insert(parts, part)
    end
    if #parts ~= 3 then return nil, "invalid_jwt_format" end

    local payload_json = base64url_decode(parts[2])
    if not payload_json then return nil, "invalid_jwt_encoding" end

    local ok, claims = pcall(cjson.decode, payload_json)
    if not ok or type(claims) ~= "table" then return nil, "invalid_jwt_payload" end

    return claims, parts
end

-- Shared dict backing the event buffer and the warning throttle below.
-- Declared here, above its first use: as a local defined further down it was
-- invisible to warn_throttled, which then silently resolved a nil global and
-- fell back to logging every time -- the throttle looked applied and did nothing.
local BUFFER_DICT = "aforo_buffer"

-- Rate-limit a repeating warning to once per interval (2026-09-03).
--
-- The revocation checks run on every request, so an unreachable Redis emitted
-- two WARN lines per request -- 24 lines for a dozen page loads. That is not a
-- cosmetic problem: it buried the CORS-preflight lines that explained why events
-- were being rejected, and made a real fault invisible inside its own noise.
--
-- Throttled through the shared dict rather than a per-worker variable so the
-- interval holds across all workers; add() is atomic and expires on its own, so
-- the first caller in each window logs and the rest stay silent. Falls back to
-- logging when the dict is unavailable: losing a warning entirely is worse than
-- repeating it.
local function warn_throttled(key, ttl, ...)
    local dict = ngx.shared[BUFFER_DICT]
    if not dict then
        kong.log.warn(...)
        return
    end
    if dict:add("aforo:warn:" .. key, 1, ttl or 60) then
        kong.log.warn(...)
    end
end

-- Check jti blocklist in Redis.  Fail-open: returns false on any Redis error.
local function is_jti_blocked(jti, redis_host, redis_port)
    if not jti or jti == "" then return false end
    local red = require("resty.redis"):new()
    red:set_timeout(500)
    local ok, err = red:connect(redis_host or "127.0.0.1", redis_port or 6379)
    if not ok then
        warn_throttled("redis_jti", 60,
            "[aforo-metering] Redis unreachable for jti-blocklist check at ",
            redis_host or "127.0.0.1", ":", redis_port or 6379, " (", err, "). ",
            "Failing OPEN -- revoked tokens are NOT being rejected. ",
            "Set jwt_redis_host/jwt_redis_port. Repeats suppressed for 60s.")
        return false  -- fail-open: do not block legitimate requests on Redis failure
    end
    local val = red:get("jti:blocked:" .. jti)
    red:set_keepalive(10000, 10)
    return val ~= nil and val ~= ngx.null
end

-- Check client-level revocation via key_id.  Fail-open.
local function is_client_revoked(key_id, redis_host, redis_port)
    if not key_id or key_id == "" then return false end
    local red = require("resty.redis"):new()
    red:set_timeout(500)
    local ok, err = red:connect(redis_host or "127.0.0.1", redis_port or 6379)
    if not ok then
        warn_throttled("redis_revocation", 60,
            "[aforo-metering] Redis unreachable for client-revocation check at ",
            redis_host or "127.0.0.1", ":", redis_port or 6379, " (", err, "). ",
            "Failing OPEN -- revoked API keys are NOT being rejected. ",
            "Set jwt_redis_host/jwt_redis_port. Repeats suppressed for 60s.")
        return false
    end
    local val = red:get("jti:client:" .. key_id)
    red:set_keepalive(10000, 10)
    return val ~= nil and val ~= ngx.null
end

-- ────────────────────────────────────────────────────────────
-- In-plugin RS256 verification (jwt_validation_enabled)
-- ────────────────────────────────────────────────────────────
--
-- FAIL-CLOSED. A token's claims (exp, iss, jti, key_id, customer_id) are only
-- worth reading once its signature has been checked, so a token that cannot be
-- verified is rejected. Before 2.1.0 a missing JWT library or a missing
-- jwt_public_key returned "valid", which let any caller mint a token naming an
-- arbitrary customer_id (fixed by Gowtham, 2026-09-01).
--
-- Uses resty.openssl, which ships with Kong and is OpenSSL 3 native.
-- lua-resty-jwt is not used: it depends on lua-resty-hmac, whose FFI binding
-- does not load against OpenSSL 3.
--
-- What is checked, in this order, before any claim is trusted:
--   1. size cap (MAX_JWT_LENGTH) and three-part structure
--   2. header alg == "RS256" exactly. The verifier below always runs
--      RSA-SHA256 against the configured key, so an alg=none / HS256 token can
--      never verify; the explicit check makes that a named rejection instead
--      of a signature failure and keeps it true if the verifier ever changes.
--   3. RS256 signature against conf.jwt_public_key (PEM, public key only)
--   4. exp (required, numeric) and nbf (when present), with
--      JWT_CLOCK_SKEW_SECONDS of leeway
--   5. iss, when conf.jwt_issuer is set
--   6. jti / key_id revocation (Redis, fail-open, as before)
--
-- Keys come from config only. jwt_jwks_uri is accepted by the schema for
-- compatibility but no JWKS fetch is implemented, so nothing here makes a
-- network call for key material.
--
-- jwt_allow_unverified_signature = true (2.1.0 opt-out) keeps its meaning for
-- ACCESS: a token this plugin cannot verify is let through, for deployments
-- that verify upstream. It no longer supplies IDENTITY: the claims of a token
-- nothing on this gateway verified are not used for customerId or keyId (see
-- resolve_customer_id). If Kong's own `jwt` plugin verified the same token on
-- this request, it counts as verified.
local MAX_JWT_LENGTH = 8192
local JWT_CLOCK_SKEW_SECONDS = 60

-- Parsed public keys, per worker. Parsing a PEM on every request is wasted
-- work; the key object is immutable. Bounded: one entry per distinct PEM in
-- use, reset if it ever grows past a handful (a config with churning keys).
local pkey_cache = {}
local pkey_cache_size = 0
local PKEY_CACHE_MAX = 16

local function load_public_key(pem)
    local cached = pkey_cache[pem]
    if cached then return cached end

    local ok, pkey = pcall(require, "resty.openssl.pkey")
    if not ok then
        return nil, "resty.openssl unavailable: " .. tostring(pkey)
    end
    local pk, perr = pkey.new(pem)
    if not pk then
        return nil, "jwt_public_key could not be parsed: " .. tostring(perr)
    end
    -- A private key verifies too (it contains the public half), but a private
    -- key sitting in gateway config is a leak, not a configuration.
    if type(pk.is_private) == "function" then
        local okp, is_private = pcall(pk.is_private, pk)
        if okp and is_private then
            return nil, "jwt_public_key holds a PRIVATE key; configure the issuer's public key"
        end
    end

    if pkey_cache_size >= PKEY_CACHE_MAX then
        pkey_cache = {}
        pkey_cache_size = 0
    end
    pkey_cache[pem] = pk
    pkey_cache_size = pkey_cache_size + 1
    return pk
end

-- Header of a compact JWS, or nil.
local function parse_jwt_header(token)
    local dot = string.find(token, ".", 1, true)
    if not dot or dot < 2 then return nil end
    local json = base64url_decode(string.sub(token, 1, dot - 1))
    if not json then return nil end
    local ok, header = pcall(cjson.decode, json)
    if not ok or type(header) ~= "table" then return nil end
    return header
end

-- true when Kong's bundled `jwt` plugin verified exactly this token on this
-- request (it stores the raw token only after signature + registered claims
-- checked out; a client cannot write to kong.ctx).
local function kong_verified_same_token(token)
    local verified = kong.ctx.shared and kong.ctx.shared.authenticated_jwt_token
    if verified == nil and ngx and ngx.ctx then
        verified = ngx.ctx.authenticated_jwt_token  -- Kong < 3 kept it here
    end
    return type(verified) == "string" and verified ~= "" and verified == token
end

-- Returns (true, "verified") when the RS256 signature checked out,
-- (true, "unverified") when it could not be checked and the operator opted
-- out with jwt_allow_unverified_signature, or (false, reason).
local function verify_rs256_signature(token, conf)
    local allow_unverified = conf.jwt_allow_unverified_signature == true

    if not conf.jwt_public_key or conf.jwt_public_key == "" then
        if allow_unverified then return true, "unverified" end
        kong.log.err("[aforo-metering] No jwt_public_key configured -- RS256 signature CANNOT ",
            "be verified (jwt_jwks_uri is accepted but not implemented). Set jwt_public_key ",
            "to the issuer's PEM public key, or verify the token with Kong's jwt plugin and ",
            "use customer_id_jwt_claim.")
        return false, "INVALID_SIGNATURE"
    end

    local header = parse_jwt_header(token)
    if not header or header.alg ~= "RS256" then
        -- Never falls back to "unverified": a key IS configured, so a token
        -- that names another algorithm is a bad token, not an unverifiable one.
        return false, "UNSUPPORTED_ALGORITHM"
    end

    local pk, kerr = load_public_key(conf.jwt_public_key)
    if not pk then
        -- A broken key or library is an operator error. Never honour
        -- allow_unverified here: a typo in the PEM must not open the gate.
        kong.log.err("[aforo-metering] RS256 signature CANNOT be verified: ", kerr)
        return false, "INVALID_SIGNATURE"
    end

    local dot1 = string.find(token, ".", 1, true)
    local dot2 = dot1 and string.find(token, ".", dot1 + 1, true)
    if not dot2 or string.find(token, ".", dot2 + 1, true) then
        return false, "MALFORMED_TOKEN"
    end

    local signing_input = string.sub(token, 1, dot2 - 1)
    local signature = base64url_decode(string.sub(token, dot2 + 1))
    if not signature or #signature == 0 then
        return false, "INVALID_SIGNATURE"
    end

    local okv, verified, verr = pcall(pk.verify, pk, signature, signing_input, "sha256")
    if not okv or verr then
        kong.log.err("[aforo-metering] RS256 verification error: ", tostring(okv and verr or verified))
        return false, "INVALID_SIGNATURE"
    end
    if verified ~= true then
        return false, "INVALID_SIGNATURE"
    end
    return true, "verified"
end

local function string_claim(v)
    if type(v) ~= "string" then return "" end
    return v
end

-- Main JWT validation entry point.
-- Returns {valid=bool, reason=string, signature_verified=bool, customer_id,
-- tenant_id, key_id, scopes, ...}
local function validate_jwt(token, conf)
    if type(token) ~= "string" or #token > MAX_JWT_LENGTH then
        return { valid = false, reason = "MALFORMED_TOKEN" }
    end

    -- 1. Structure + encoding
    local claims = parse_jwt_claims(token)
    if not claims then
        return { valid = false, reason = "MALFORMED_TOKEN" }
    end

    -- 2. Signature. Before exp / iss / revocation: those are claims, and a
    -- claim means nothing until the signature over it has been checked.
    local sig_ok, sig_mode = verify_rs256_signature(token, conf)
    if not sig_ok then
        return { valid = false, reason = sig_mode or "INVALID_SIGNATURE" }
    end
    local signature_verified = (sig_mode == "verified") or kong_verified_same_token(token)
    if not signature_verified then
        warn_throttled("jwt_unverified", 300,
            "[aforo-metering] jwt_allow_unverified_signature=true: a token was let through ",
            "WITHOUT signature verification. Its claims are not used for customerId or keyId. ",
            "Verify it with Kong's jwt plugin (then set customer_id_jwt_claim) or set ",
            "jwt_public_key. Repeats suppressed for 300s.")
    end

    -- 3. Expiry / not-before
    local now = ngx.time()
    local exp = tonumber(claims.exp)
    if not exp or now > exp then
        return { valid = false, reason = "TOKEN_EXPIRED" }
    end
    if claims.nbf ~= nil then
        local nbf = tonumber(claims.nbf)
        if not nbf or now + JWT_CLOCK_SKEW_SECONDS < nbf then
            return { valid = false, reason = "TOKEN_NOT_YET_VALID" }
        end
    end

    -- 4. Issuer check
    if conf.jwt_issuer and conf.jwt_issuer ~= "" and claims.iss ~= conf.jwt_issuer then
        kong.log.warn("[aforo-metering] JWT issuer mismatch: got '", tostring(claims.iss),
            "', expected '", conf.jwt_issuer, "'")
        return { valid = false, reason = "INVALID_ISSUER" }
    end

    -- Resolve Redis coords for jti blocklist checks.
    -- Prefer dedicated jwt_redis_* config; fall back to rate_limit_redis_*.
    local redis_host = (conf.jwt_redis_host and conf.jwt_redis_host ~= "" and conf.jwt_redis_host)
                       or conf.rate_limit_redis_host or "127.0.0.1"
    local redis_port = conf.jwt_redis_port or conf.rate_limit_redis_port or 6379

    -- 5. jti blocklist (revoked individual token)
    local jti = string_claim(claims.jti)
    if is_jti_blocked(jti, redis_host, redis_port) then
        return { valid = false, reason = "TOKEN_REVOKED" }
    end

    -- 6. Client-level revocation (all tokens for this key_id revoked)
    local key_id = string_claim(claims.key_id)
    if is_client_revoked(key_id, redis_host, redis_port) then
        return { valid = false, reason = "CLIENT_REVOKED" }
    end

    -- 7. Return validated claims
    local customer_id = string_claim(claims.customer_id)
    if customer_id == "" then customer_id = string_claim(claims.sub) end
    return {
        valid        = true,
        signature_verified = signature_verified,
        customer_id  = customer_id,
        tenant_id    = string_claim(claims.tenant_id),
        key_id       = key_id,
        scopes       = type(claims.scopes) == "table"
                           and table.concat(claims.scopes, " ")
                           or string_claim(claims.scopes),
        environment  = string_claim(claims.environment) ~= ""
                           and claims.environment or "live",
        offering_ids = claims.offering_ids,
        jti          = jti,
    }
end

local AforoMeteringHandler = {
    PRIORITY = 5,    -- Run after most other plugins
    VERSION  = "2.2.0",
}

-- Shared memory buffer (kong.conf: lua_shared_dict aforo_buffer 10m).
--
-- The buffer is a shared-dict LIST, one JSON-encoded event per element
-- (Gowtham, 2026-09-21). It used to be a single JSON array under one key,
-- appended by get -> decode -> insert -> set and drained by get -> delete.
-- Neither sequence is atomic and every nginx worker runs them concurrently, so
-- two workers appending at once each wrote back their own copy and the other's
-- event vanished. rpush / lpop are single atomic operations.
--
-- A new key name on purpose: rpush against the old key ("events"), if it still
-- held the legacy string after a hot reload, fails with "value not a list".
local BUFFER_KEY = "aforo:events"
local MAX_BUFFER_SIZE = 10000

-- The ingestor refuses a batch of more than 1000 events, so a backlog is
-- drained in slices no larger than this.
local MAX_BATCH_SIZE = 1000

-- Longest Retry-After (seconds) honoured on a 429 before the next attempt.
-- The flush runs in a timer, never on a request; past this the batch is
-- re-buffered for a later flush instead of sleeping through this one.
local MAX_RETRY_AFTER_SECONDS = 30

-- Single-flight guards for flush timers (shared across workers). Without them
-- every request arriving while the buffer sits at flush_count schedules its
-- own timer -- during an ingestor outage that is one timer per request.
local FLUSH_NOW_KEY = "aforo:flush_now"
local FLUSH_TIMED_KEY = "aforo:flush_timed"
local FLUSH_GUARD_TTL = 300

-- productType is REQUIRED by the ingestor in production, and some types carry
-- fields of their own. An event missing them is refused by the ingestor, so it
-- is skipped here, where the loss is one event and is logged.
local DEFAULT_PRODUCT_TYPE = "API"
local PRODUCT_TYPE_REQUIRED_FIELDS = {
    API           = {},
    AGENTIC_API   = {},
    AI_AGENT      = { "agentId", "sessionId" },
    MCP_SERVER    = { "toolName", "agentId" },
    GRPC_API      = { "grpcService", "grpcMethod" },
    GRAPHQL_API   = { "gqlOperationType" },
    WEBSOCKET_API = { "wsConnectionId" },
    MQTT_BROKER   = { "mqttTopic" },
}

-- conf.product_type trimmed and upper-cased; "API" when unset or blank.
local function normalize_product_type(value)
    if type(value) ~= "string" then return DEFAULT_PRODUCT_TYPE end
    local v = value:match("^%s*(.-)%s*$"):upper()
    if v == "" then return DEFAULT_PRODUCT_TYPE end
    return v
end

-- Required fields this event's productType lacks, or nil when complete.
local function missing_required_fields(event)
    local required = PRODUCT_TYPE_REQUIRED_FIELDS[event.productType]
    if not required then return nil end
    local missing = {}
    for _, field in ipairs(required) do
        local v = event[field]
        if v == nil or v == "" then
            missing[#missing + 1] = field
        end
    end
    return #missing > 0 and missing or nil
end

-- ────────────────────────────────────────────────────────────
-- Drop metric (2026-07-05 — A+ delivery-guarantee prompt 3)
--
-- Permanent event loss (buffer overflow, flush-retry exhaustion) was
-- previously visible ONLY as log lines. record_drop() makes it
-- alarmable, without touching the happy path or retry counts:
--   1. Cumulative per-reason counters in the shared dict
--      ("aforo_dropped:<reason>" keys in lua_shared_dict aforo_buffer)
--      — always on, zero dependencies, readable from any worker.
--   2. A Prometheus counter
--      `aforo_metering_dropped_events_total{reason}` registered against
--      Kong's bundled prometheus plugin WHEN that plugin is loaded.
--      Every touch is pcall-guarded: deployments without the prometheus
--      plugin (or with an incompatible exporter API) silently fall back
--      to the shared-dict counter + logs. A metrics failure must never
--      break metering or request handling.
-- The existing WARN/ERR drop logs are retained and now also carry the
-- cumulative total, so log pipelines keep working unchanged.
-- ────────────────────────────────────────────────────────────

local DROP_KEY_PREFIX = "aforo_dropped:"

local prometheus_drop_counter  -- nil = not yet resolved; false = unavailable

local function get_prometheus_drop_counter()
    if prometheus_drop_counter ~= nil then
        return prometheus_drop_counter or nil
    end
    local ok, exporter = pcall(require, "kong.plugins.prometheus.exporter")
    if ok and type(exporter) == "table" and type(exporter.get_prometheus) == "function" then
        local got, prom = pcall(exporter.get_prometheus)
        if got and prom and type(prom.counter) == "function" then
            local reg, counter = pcall(prom.counter, prom,
                "aforo_metering_dropped_events_total",
                "Usage events permanently dropped by the aforo-metering plugin",
                { "reason" })
            if reg and counter then
                prometheus_drop_counter = counter
                return counter
            end
        end
    end
    prometheus_drop_counter = false
    return nil
end

-- Records `count` permanently-dropped events under `reason`
-- ("buffer_overflow" | "rejected" | "ingestor_rejected" | "invalid_metric" |
-- "missing_fields"). Returns the new cumulative
-- total for that reason, or nil when the shared dict is unavailable.
-- Safe in both request (log phase) and timer (flush) contexts.
local function record_drop(reason, count)
    local total
    local dict = ngx.shared[BUFFER_DICT]
    if dict then
        total = dict:incr(DROP_KEY_PREFIX .. reason, count, 0)
    end
    local counter = get_prometheus_drop_counter()
    if counter then
        pcall(counter.inc, counter, count, { reason })
    end
    return total
end

-- ────────────────────────────────────────────────────────────
-- Helpers
-- ────────────────────────────────────────────────────────────

local function should_exclude_path(path, exclude_paths)
    if not exclude_paths then return false end
    for _, excluded in ipairs(exclude_paths) do
        if path == excluded or string.sub(path, 1, #excluded) == excluded then
            return true
        end
    end
    return false
end

local function should_exclude_status(status, exclude_status_codes)
    if not exclude_status_codes then return false end
    for _, excluded in ipairs(exclude_status_codes) do
        if status == excluded then
            return true
        end
    end
    return false
end

-- ────────────────────────────────────────────────────────────
-- Central metric mappings, fetched from Aforo (conf.mappings_url)
-- ────────────────────────────────────────────────────────────
--
-- Two rules govern this code:
--   * It never blocks a request. Refresh runs in a timer with a timeout; the
--     request path only reads the shared-dict cache.
--   * A stale table beats no table. If the catalog is unreachable the last
--     table keeps being served and a warning is logged; clearing it would
--     silently re-attribute live traffic to default_metric.
--
-- Cached in the existing aforo_buffer dict so no second lua_shared_dict has to
-- be declared.
local MAPPINGS_KEY = "aforo:gateway_mappings"
local MAPPINGS_FETCHED_AT_KEY = "aforo:gateway_mappings_at"
local MAPPINGS_INFLIGHT_KEY = "aforo:gateway_mappings_inflight"
local MAPPINGS_TTL_KEY = "aforo:gateway_mappings_ttl"
local MAX_MAPPINGS_BODY_BYTES = 1024 * 1024
local MAX_MAPPING_RULES = 5000
local MIN_MAPPINGS_TTL_SECONDS = 30

-- Cache keys carry the tenant: one gateway can run plugin instances for more
-- than one tenant, and they share the dict.
local function mappings_key(base, conf)
    return base .. ":" .. tostring(conf and conf.tenant_id or "")
end

local function fetch_mappings(premature, conf)
    if premature then return end

    local dict = ngx.shared[BUFFER_DICT]
    if not dict then return end

    local httpc = http.new()
    httpc:set_timeout(conf.mappings_timeout_ms or 3000)

    local url = conf.mappings_url .. "?tenantId=" .. ngx.escape_uri(conf.tenant_id or "")
    local res, err = httpc:request_uri(url, {
        method = "GET",
        headers = { ["Accept"] = "application/json" },
    })

    dict:delete(mappings_key(MAPPINGS_INFLIGHT_KEY, conf))
    -- Stamp the attempt, successful or not, so an unreachable catalog is asked
    -- once per refresh interval rather than on every request.
    dict:set(mappings_key(MAPPINGS_FETCHED_AT_KEY, conf), ngx.now())

    if not res or res.status < 200 or res.status >= 300 then
        -- Keep whatever is cached. Do not clear it.
        kong.log.warn("[aforo-metering] Could not refresh metric mappings from ", conf.mappings_url,
            " (status=", res and res.status or "no response", ", err=", err or "none",
            "). Continuing with the cached table.")
        return
    end

    if type(res.body) ~= "string" or #res.body > MAX_MAPPINGS_BODY_BYTES then
        kong.log.err("[aforo-metering] Metric mappings response missing or larger than ",
            MAX_MAPPINGS_BODY_BYTES, " bytes; keeping the cached table.")
        return
    end

    local ok, body = pcall(cjson.decode, res.body)
    -- Aforo services wrap 2xx bodies as {success, data, meta}; accept both.
    if ok and type(body) == "table" and type(body.data) == "table" and body.mappings == nil then
        body = body.data
    end
    if not ok or type(body) ~= "table" or type(body.mappings) ~= "table" then
        kong.log.err("[aforo-metering] Metric mappings response was not usable JSON; ",
            "keeping the cached table.")
        return
    end
    if #body.mappings > MAX_MAPPING_RULES then
        kong.log.err("[aforo-metering] Metric mappings response has more than ",
            MAX_MAPPING_RULES, " rules; keeping the cached table.")
        return
    end

    dict:set(mappings_key(MAPPINGS_KEY, conf), cjson.encode(body.mappings))
    local ttl = tonumber(body.cacheTtlSeconds)
    if ttl then
        if ttl < MIN_MAPPINGS_TTL_SECONDS then ttl = MIN_MAPPINGS_TTL_SECONDS end
        dict:set(mappings_key(MAPPINGS_TTL_KEY, conf), ttl)
    end
    kong.log.info("[aforo-metering] Loaded ", #body.mappings, " metric mappings for tenant ",
        conf.tenant_id or "?")
end

-- Spawn a refresh when the cache is older than its TTL. Called from the request
-- path, but only ever schedules work -- it does not wait for it.
local function maybe_refresh_mappings(conf)
    if not conf.mappings_url or conf.mappings_url == "" then return end

    local dict = ngx.shared[BUFFER_DICT]
    if not dict then return end

    local fetched_at = dict:get(mappings_key(MAPPINGS_FETCHED_AT_KEY, conf))
    local ttl = dict:get(mappings_key(MAPPINGS_TTL_KEY, conf)) or conf.mappings_refresh_seconds or 300
    if fetched_at and (ngx.now() - fetched_at) < ttl then return end

    -- One worker fetches; the rest carry on with the cache. add() is atomic, so
    -- a burst of concurrent requests cannot stampede the catalog.
    local claimed = dict:add(mappings_key(MAPPINGS_INFLIGHT_KEY, conf), 1, 30)
    if not claimed then return end

    local ok, err = ngx.timer.at(0, fetch_mappings, conf)
    if not ok then
        dict:delete(mappings_key(MAPPINGS_INFLIGHT_KEY, conf))
        kong.log.warn("[aforo-metering] Could not schedule mappings refresh: ", err)
    end
end

-- Match a path against one cached rule. Plain string comparisons, never a
-- pattern: the catalog serves EXACT / PREFIX / CONTAINS so the same rule means
-- the same thing in every gateway.
local function mapping_matches(path, rule)
    if type(rule) ~= "table" then return false end
    local value = rule.value
    if type(value) ~= "string" or value == "" or not path then return false end
    local kind = rule.matchType or "EXACT"
    if kind == "EXACT" then
        return path == value
    elseif kind == "PREFIX" then
        return string.sub(path, 1, #value) == value
    elseif kind == "CONTAINS" then
        return string.find(path, value, 1, true) ~= nil
    end
    return false
end

-- Decoded rule tables, per worker: the log phase does not decode the JSON on
-- every request, only when the cached bytes change.
local decoded_rules = {}   -- cache key -> { raw = <json string>, rules = <table> }

local function metric_from_cached_mappings(conf, path)
    if not conf.mappings_url or conf.mappings_url == "" then return nil end
    local dict = ngx.shared[BUFFER_DICT]
    if not dict then return nil end
    local key = mappings_key(MAPPINGS_KEY, conf)
    local raw = dict:get(key)
    if not raw then return nil end
    local entry = decoded_rules[key]
    if not entry or entry.raw ~= raw then
        local ok, decoded = pcall(cjson.decode, raw)
        if not ok or type(decoded) ~= "table" then return nil end
        entry = { raw = raw, rules = decoded }
        decoded_rules[key] = entry
    end
    local rules = entry.rules
    -- The catalog returns them already ordered; first match wins.
    for _, rule in ipairs(rules) do
        if mapping_matches(path, rule) then
            return rule.metricName
        end
    end
    return nil
end

-- The legacy default. Kept as a sentinel so "operator left it alone" can be
-- told apart from "operator chose a template".
local DEFAULT_METRIC_PATTERN = "{method} {path}"

local MAX_METRIC_NAME_LENGTH = 255  -- ingestor: metricName @Size(max = 255)

-- Resolve the metric this request is billed against. First match wins:
--   1. upstream RESPONSE header (conf.metric_header) -- set by the backend, so
--      a client cannot forge it
--   2. central mappings fetched from Aforo (conf.mappings_url)
--   3. conf.metric_mappings -- local rules; also the fallback while the
--      catalog is unreachable and nothing is cached
--   4. conf.metric_name_pattern -- only when set to something other than the
--      old default "{method} {path}" (a fixed name such as "platform_api_calls"
--      or a template)
--   5. conf.default_metric ("api_calls")
--
-- The old default produced one metric name per endpoint ("GET /api/products"),
-- which the ingestor rejects unless every endpoint is registered as its own
-- catalog metric.
local function resolve_metric_name(conf, method, path, service_name, route_name,
                                   consumer_name, header_metric)
    if type(header_metric) == "string" and header_metric ~= "" then
        return header_metric
    end

    local central = metric_from_cached_mappings(conf, path)
    if type(central) == "string" and central ~= "" then
        return central
    end

    if type(conf.metric_mappings) == "table" then
        for _, rule in ipairs(conf.metric_mappings) do
            local method_ok = (rule.method == nil or rule.method == ""
                               or string.upper(rule.method) == string.upper(method or ""))
            if method_ok and rule.path_pattern and rule.path_pattern ~= "" then
                local ok, matched = pcall(string.find, path or "", rule.path_pattern)
                if not ok then
                    -- A malformed pattern must not take metering down for
                    -- every request; skip the rule and name it.
                    kong.log.err("[aforo-metering] Invalid path_pattern '", tostring(rule.path_pattern),
                        "' in metric_mappings -- rule skipped.")
                elseif matched then
                    return rule.metric_name
                end
            end
        end
    end

    local pattern = conf.metric_name_pattern
    if pattern and pattern ~= "" and pattern ~= DEFAULT_METRIC_PATTERN then
        -- Function replacements: a "%" in a path must not be read as a
        -- gsub capture reference.
        local result = pattern
        result = string.gsub(result, "{method}", function() return method or "UNKNOWN" end)
        result = string.gsub(result, "{path}", function() return path or "/" end)
        result = string.gsub(result, "{service}", function() return service_name or "" end)
        result = string.gsub(result, "{route}", function() return route_name or "" end)
        result = string.gsub(result, "{consumer}", function() return consumer_name or "" end)
        return result
    end

    return conf.default_metric or "api_calls"
end

-- A metric name the ingestor would refuse on shape alone. (Whether the name
-- exists in the tenant's catalog is only known to the ingestor; those are
-- reported per event in its batch response and counted by send_batch.)
local function valid_metric_name(name)
    if type(name) ~= "string" then return false end
    local trimmed = name:match("^%s*(.-)%s*$")
    return trimmed ~= "" and #name <= MAX_METRIC_NAME_LENGTH
end

-- Resolve the quantity to bill. header_quantity comes from the upstream
-- RESPONSE (conf.quantity_header) and wins when it parses to a positive
-- number; it carries values only the backend knows (minutes, tokens, bytes).
local function resolve_quantity(conf, response_size, header_quantity)
    if header_quantity and header_quantity ~= "" then
        local n = tonumber(header_quantity)
        -- n == n rejects NaN; the upper bound rejects inf and values the
        -- ingestor's @Digits(integer = 14) would refuse.
        if n and n == n and n > 0 and n < 1e14 then
            return n
        end
        kong.log.warn("[aforo-metering] Ignoring non-positive/unparseable ",
            conf.quantity_header or "quantity", " header: '", tostring(header_quantity), "'")
    end

    local source = conf.quantity_source or "1"
    if source == "1" then
        return 1
    elseif source == "response_size" then
        return response_size or 0
    else
        return tonumber(source) or 1
    end
end

-- verified_jwt_claims
--
-- Claims of the JWT that Kong's bundled `jwt` plugin verified on this
-- request, or nil. That plugin stores the raw token in
-- kong.ctx.shared.authenticated_jwt_token only after the signature and the
-- registered claims (exp, ...) checked out; a client cannot write to
-- kong.ctx. No token there means no verified identity: the Authorization
-- header is never parsed here.
local function verified_jwt_claims()
    local token = kong.ctx.shared and kong.ctx.shared.authenticated_jwt_token
    if token == nil and ngx and ngx.ctx then
        token = ngx.ctx.authenticated_jwt_token  -- Kong < 3 kept it here
    end
    if type(token) ~= "string" or token == "" then return nil end
    local ok, claims = pcall(parse_jwt_claims, token)
    if not ok or type(claims) ~= "table" then return nil end
    return claims
end

local MAX_CUSTOMER_ID_LENGTH = 64  -- ingestor: customerId @Size(max = 64)

-- A claim is "set" when it is present and not false / "" / JSON null.
local function claim_is_set(v)
    if v == nil or v == false or v == "" then return false end
    if cjson.null ~= nil and v == cjson.null then return false end
    return true
end

-- A usable customer id: a non-blank string of at most 64 characters, trimmed.
local function usable_customer_id(value)
    if type(value) ~= "string" then return nil end
    value = value:match("^%s*(.-)%s*$")
    if value == "" or #value > MAX_CUSTOMER_ID_LENGTH then return nil end
    return value
end

-- resolve_customer_id
--
-- Three identity models, chosen by configuration. Every one of them reads a
-- value some component on this gateway verified; none reads a request header,
-- a query parameter, or a token nothing verified.
--
--   A. conf.customer_id_jwt_claim is set -> that claim of the JWT verified by
--      Kong's bundled `jwt` plugin. This is the ONLY source in that mode: on a
--      jwt-protected route the Kong consumer is the token ISSUER, shared by
--      every caller, so falling back to it would bill everyone as one
--      customer. A token carrying any of conf.customer_id_jwt_exclude_claims
--      (e.g. staff impersonation) resolves to nil.
--
--   B. conf.jwt_validation_enabled -> the customer_id (else sub) claim of the
--      Aforo JWT this plugin verified itself (RS256, exp) in the access phase.
--      Used only when the signature was actually verified
--      (signature_verified); a token let through by
--      jwt_allow_unverified_signature supplies no identity. When the verified
--      token names no customer, C applies.
--
--   C. The Kong consumer (custom_id, else username, else id), bound to the
--      credential Kong authenticated (key-auth, basic-auth, ...).
--
-- When A and B are both configured, A decides (Kong verified that token) and
-- B contributes nothing. Returns nil when no source resolves; the log phase
-- then records no event.
--
-- IMPORTANT: the `headers` argument is kept for call-site backwards
-- compatibility but is NEVER consulted. Client-settable request headers
-- (X-Customer-Id, X-Tenant-Id, ?customer_id=) are not trusted sources.
local function resolve_customer_id(conf, consumer, headers)  -- luacheck: ignore 212
    local claim_name = conf and conf.customer_id_jwt_claim
    if claim_name and claim_name ~= "" then
        local claims = verified_jwt_claims()
        if not claims then return nil end
        for _, excluded in ipairs(conf.customer_id_jwt_exclude_claims or {}) do
            if claim_is_set(claims[excluded]) then return nil end
        end
        return usable_customer_id(claims[claim_name])
    end

    local jwt_claims = kong.ctx.shared and kong.ctx.shared.aforo_jwt_claims
    if type(jwt_claims) == "table" and jwt_claims.signature_verified == true then
        local from_jwt = usable_customer_id(jwt_claims.customer_id)
        if from_jwt then return from_jwt end
    end

    if consumer then
        return usable_customer_id(consumer.custom_id)
            or usable_customer_id(consumer.username)
            or usable_customer_id(consumer.id)
    end
    return nil
end

-- Lua gotcha: "" is TRUTHY. An empty client-supplied header must be
-- treated as absent — otherwise it shadows the next identity in the
-- fallback chain and feeds a blank/shared component into idempotency
-- keys (the prefixed MCP/compound keys would collide ACROSS requests →
-- the ingestor silently dedups real events as replays — revenue loss).
local function nonempty(v)
    if v == nil or v == "" then return nil end
    return v
end

-- resty.jit-uuid is bundled with OpenResty/Kong. Loaded lazily + pcall-guarded so this
-- module still loads under the plain-Lua unit tests (which have no OpenResty). Replaces a
-- broken PDK uuid call: the `kong` global exposes no `tools` field on Kong 3.x, so it
-- raised "attempt to index field 'tools' (a nil value)" and crashed the log phase — every
-- request lacking an X-Request-Id then emitted ZERO events (silent total loss).
local _jit_uuid
local function random_uuid()
    if _jit_uuid == nil then
        local ok, mod = pcall(require, "resty.jit-uuid")
        _jit_uuid = (ok and type(mod) == "table" and mod) or false
    end
    if _jit_uuid and _jit_uuid.generate_v4 then
        return _jit_uuid.generate_v4()
    end
    return nil
end

-- ISO-8601 UTC with milliseconds ("2026-09-30T15:48:29.554Z"), the format the
-- ingestor's occurredAt (java.time.Instant) expects and the other four gateways
-- send. A bare number is read as epoch SECONDS by Jackson, so the old
-- ngx.now() * 1000 (epoch millis) parsed as the year 58717 and every event
-- failed the ingestor's future-timestamp check.
local function iso8601_utc(t)
    local sec = math.floor(t)
    local ms = math.floor((t - sec) * 1000 + 0.5)
    if ms >= 1000 then
        sec = sec + 1
        ms = ms - 1000
    end
    return os.date("!%Y-%m-%dT%H:%M:%S", sec) .. string.format(".%03dZ", ms)
end

local function generate_idempotency_key(request_id)
    return request_id or random_uuid()
end

-- ────────────────────────────────────────────────────────────
-- W3C Trace Context extraction
-- Captures traceparent, tracestate, x-trace-id, x-request-id
-- from inbound request headers. Returns nil for absent headers.
-- ────────────────────────────────────────────────────────────

local function extract_trace_context()
    return {
        traceparent = kong.request.get_header("traceparent"),
        tracestate  = kong.request.get_header("tracestate"),
        xTraceId    = kong.request.get_header("x-trace-id"),
        xRequestId  = kong.request.get_header("x-request-id"),
    }
end

-- ────────────────────────────────────────────────────────────
-- Flush buffered events to Aforo ingestor
-- ────────────────────────────────────────────────────────────

-- Take up to `max` events off the head of the buffer. Each lpop is atomic, so
-- concurrent flushes in different workers take disjoint events.
local function pop_batch(dict, max)
    local batch = {}
    for i = 1, max do
        local item, err = dict:lpop(BUFFER_KEY)
        if not item then
            if err then
                kong.log.err("[aforo-metering] Could not read buffer: ", err)
            end
            break
        end
        batch[i] = item
    end
    return batch
end

-- Put a failed batch back at the head of the buffer, oldest first, and trim
-- the tail back to MAX_BUFFER_SIZE. Returns how many events were dropped.
-- The re-buffered strings are the same bytes that were sent, so every later
-- attempt carries the same idempotency keys (Rule #21).
local function rebuffer(dict, batch)
    local dropped = 0
    for i = #batch, 1, -1 do
        local len, err = dict:lpush(BUFFER_KEY, batch[i])
        if not len then
            kong.log.err("[aforo-metering] Could not re-buffer event: ", err)
            dropped = dropped + 1
        end
    end
    local len = dict:llen(BUFFER_KEY) or 0
    while len > MAX_BUFFER_SIZE do
        if not dict:rpop(BUFFER_KEY) then break end
        dropped = dropped + 1
        len = len - 1
    end
    return dropped
end

-- 4xx other than 408 / 429: the ingestor understood the batch and refused it.
local function is_permanent_rejection(status)
    return status ~= nil and status >= 400 and status < 500
        and status ~= 408 and status ~= 429
end

-- The ingestor answers 2xx for a batch it only partly accepted and reports
-- the refused events in the body ({success, data: {accepted, duplicates,
-- failed, errors: [{index, message}]}}). An unknown metric name, for example,
-- lands here -- so count and log it, or it is lost without a trace.
local function report_partial_failures(res, batch_size)
    if not res or type(res.body) ~= "string" or res.body == "" then return end
    local ok, body = pcall(cjson.decode, res.body)
    if not ok or type(body) ~= "table" then return end
    local data = type(body.data) == "table" and body.data or body
    local failed = tonumber(data.failed)
    if not failed or failed <= 0 then return end

    local total = record_drop("ingestor_rejected", failed)
    local first = ""
    if type(data.errors) == "table" then
        local parts = {}
        for i = 1, math.min(#data.errors, 3) do
            local e = data.errors[i]
            if type(e) == "table" then
                parts[#parts + 1] = "#" .. tostring(e.index) .. ": " .. tostring(e.message)
            end
        end
        first = table.concat(parts, "; ")
    end
    warn_throttled("ingestor_rejected", 60,
        "[aforo-metering] Ingestor refused ", failed, " of ", batch_size,
        " event(s) in an accepted batch (", string.sub(first, 1, 500), "). These are NOT ",
        "retried. A metric name that is not in the Aforo catalog is the usual cause: check ",
        "metric_mappings / default_metric / metric_name_pattern. Cumulative: ",
        total or "?", ". Repeats suppressed for 60s.")
end

-- POST one batch. Returns "sent", "rejected" (permanent -- dropped, do not
-- retry) or "failed" (transient -- the caller keeps the events).
local function send_batch(conf, batch)
    local httpc = http.new()
    httpc:set_timeout(10000)

    -- Each element is already a JSON-encoded event, so the body is assembled
    -- rather than decoded and re-encoded: the bytes sent are the bytes
    -- buffered, on every attempt.
    local body = '{"events":[' .. table.concat(batch, ",") .. ']}'

    local max_retries = 3
    local last_status, last_body
    for attempt = 1, max_retries do
        local res, err = httpc:request_uri(conf.aforo_endpoint, {
            method  = "POST",
            body    = body,
            -- X-API-Key alone, never Authorization: Bearer. An API key in a
            -- Bearer header is parsed as a JWT and refused 401.
            headers = {
                ["Content-Type"]  = "application/json",
                ["X-API-Key"]     = conf.api_key or "",
                ["X-Tenant-Id"]   = conf.tenant_id or "",
            },
        })

        if res and res.status >= 200 and res.status < 300 then
            kong.log.info("[aforo-metering] Flushed ", #batch, " events to Aforo (status=", res.status, ")")
            report_partial_failures(res, #batch)
            return "sent"
        end

        local status = res and res.status or "no response"
        last_status = res and res.status or nil
        last_body = res and res.body or nil
        kong.log.warn("[aforo-metering] Flush attempt ", attempt, "/", max_retries,
            " failed (status=", status, ", err=", err or "none", ")")

        -- OpenSSL error 20 against an https endpoint almost always means
        -- lua_ssl_verify_depth (default 1) is too shallow for the chain, not a
        -- missing CA bundle.
        if attempt == max_retries and err and string.find(err, "unable to get local issuer certificate", 1, true) then
            kong.log.err("[aforo-metering] TLS verification failed for ", conf.aforo_endpoint, ". ",
                "This is usually lua_ssl_verify_depth, which Kong defaults to 1 -- too shallow for a ",
                "leaf/intermediate/root chain. Set lua_ssl_verify_depth = 3 in kong.conf (or ",
                "KONG_LUA_SSL_VERIFY_DEPTH=3).")
        end

        -- A permanent rejection gets the same answer on every attempt.
        if is_permanent_rejection(last_status) then
            break
        end

        if attempt < max_retries then
            local wait = 2 ^ (attempt - 1)
            -- Honour the ingestor's Retry-After on 429 (delta-seconds form).
            -- Longer than MAX_RETRY_AFTER_SECONDS: stop here and let the
            -- caller re-buffer, rather than sleep through the flush. This is a
            -- timer, not a request: the sleep delays no API call.
            if last_status == 429 and type(res.headers) == "table" then
                local ra = tonumber(res.headers["Retry-After"] or res.headers["retry-after"])
                if ra and ra >= 0 then
                    if ra > MAX_RETRY_AFTER_SECONDS then
                        break
                    end
                    wait = ra
                end
            end
            ngx.sleep(wait)
        end
    end

    -- 4xx means the server understood the batch and refused it; retrying sends
    -- the same bytes to the same judgement, and would hold every well-formed
    -- event queued behind it. 408 and 429 invite a retry; 5xx, timeouts and
    -- connection errors are transient.
    if is_permanent_rejection(last_status) then
        local total = record_drop("rejected", #batch)
        kong.log.err("[aforo-metering] Ingestor rejected the batch with ", last_status,
            " -- dropping ", #batch, " event(s) rather than retrying them forever. ",
            "Cumulative rejected: ", total or "?", ". Response: ",
            string.sub(tostring(last_body or ""), 1, 500))
        return "rejected"
    end

    return "failed"
end

local flush_buffer  -- forward declaration (schedule_flush <-> flush_buffer)

-- Schedule a flush unless one guarded by `guard_key` is already pending or
-- running. The guard expires on its own, so a worker that died holding it
-- cannot stop flushing for good.
local function schedule_flush(conf, delay, guard_key)
    local dict = ngx.shared[BUFFER_DICT]
    if not dict then return end
    if not dict:add(guard_key, 1, delay + FLUSH_GUARD_TTL) then return end
    local ok, err = ngx.timer.at(delay, flush_buffer, conf, guard_key)
    if not ok then
        dict:delete(guard_key)
        kong.log.warn("[aforo-metering] Failed to schedule flush: ", err)
    end
end

local function drain(dict, conf)
    -- Drain in slices of MAX_BATCH_SIZE. Bounded so one flush cannot chase a
    -- buffer that live traffic refills as fast as it drains.
    for _ = 1, math.ceil(MAX_BUFFER_SIZE / MAX_BATCH_SIZE) do
        local batch = pop_batch(dict, MAX_BATCH_SIZE)
        if #batch == 0 then return end

        local outcome = send_batch(conf, batch)

        if outcome == "failed" then
            -- Transient failure: the events were taken off the buffer before
            -- the first attempt, so put them back for a later flush and stop
            -- draining -- the next slice would fail the same way.
            local dropped = rebuffer(dict, batch)
            if dropped > 0 then
                local total = record_drop("buffer_overflow", dropped)
                kong.log.err("[aforo-metering] All flush attempts failed. ",
                    #batch, " events re-buffered for retry; ", dropped,
                    " dropped (buffer at MAX_BUFFER_SIZE=", MAX_BUFFER_SIZE,
                    "). Cumulative overflow drops: ", total or "?",
                    ". Raise lua_shared_dict aforo_buffer if this recurs.")
            else
                kong.log.err("[aforo-metering] All flush attempts failed. ",
                    #batch, " events re-buffered for retry on the next flush.")
            end
            return
        end

        if #batch < MAX_BATCH_SIZE then return end
    end
end

flush_buffer = function(premature, conf, guard_key)
    local dict = ngx.shared[BUFFER_DICT]
    if not dict then
        if not premature then
            kong.log.err("[aforo-metering] Shared dict '", BUFFER_DICT, "' not found")
        end
        return
    end
    if premature then
        if guard_key then dict:delete(guard_key) end
        return
    end

    local ok, err = pcall(drain, dict, conf)
    if guard_key then dict:delete(guard_key) end
    if not ok then
        kong.log.err("[aforo-metering] Flush failed: ", tostring(err))
    end

    -- Anything still buffered (a failed batch put back, or events that arrived
    -- during the flush) needs a flush of its own: the log phase only schedules
    -- one on the first event and at flush_count, so a short re-buffered batch
    -- would otherwise wait for traffic to push it over the threshold.
    if (dict:llen(BUFFER_KEY) or 0) > 0 then
        schedule_flush(conf, (conf.flush_interval_ms or 5000) / 1000, FLUSH_TIMED_KEY)
    end
end

-- ────────────────────────────────────────────────────────────
-- AGENTIC_API Detection
-- Per descriptor eventSchema.inferenceRule = HAS_TRACE (agentic_api.json),
-- a request with a resolvable trace id classifies as AGENTIC_API.
-- Preferred source is the W3C traceparent header (parsed for its 32-hex
-- trace_id field); fallback is x-trace-id per descriptor
-- tracing.allowFallback = true (non-OTel callers). MCP JSON-RPC still
-- wins the productType when both signals are present — the log-phase
-- caller checks MCP first and only consults this helper in the else
-- branch. Malformed traceparent falls through cleanly; never invent a
-- productType from an unparseable header.
-- ────────────────────────────────────────────────────────────

local function extract_agentic_trace_id(trace)
    if not trace then return nil end

    local traceparent = trace.traceparent
    if traceparent then
        -- W3C format: version-trace_id-parent_id-flags (hex widths 2-32-16-2).
        -- Invalid per spec: version=="ff", trace_id all zeros, parent_id all zeros.
        local v, tid, pid, f = string.match(
            traceparent, "^(%x%x)%-(%x+)%-(%x+)%-(%x%x)$"
        )
        if v and tid and pid and f
            and v:lower() ~= "ff"
            and #tid == 32 and tid:match("[^0]")   -- 32 hex + not all zeros
            and #pid == 16 and pid:match("[^0]")   -- 16 hex + not all zeros
        then
            return tid:lower()
        end
    end

    local x_trace = trace.xTraceId
    if x_trace then
        -- Non-OTel fallback. Descriptor types trace_id as String, not UUID —
        -- no shape check beyond non-empty after trim.
        local trimmed = x_trace:gsub("^%s+", ""):gsub("%s+$", "")
        if #trimmed > 0 then
            return trimmed
        end
    end

    return nil
end

-- ────────────────────────────────────────────────────────────
-- Outcome classification (OUTCOME_BASED pricing)
-- ────────────────────────────────────────────────────────────
-- Maps the upstream HTTP status to the server's executionStatus value
-- space. OUTCOME_BASED rate plans bill each event at a per-status
-- weight; every other pricing model ignores the field. Shared rule —
-- identical in all five gateway plugins (see README "Execution status
-- mapping"). Default table (policy locked 2026-09-30, option C):
--   2xx/3xx -> SUCCESS, 408/504 -> TIMEOUT, 499 -> CANCELLED,
--   400/422 -> VALIDATION_FAILED, 401/403/429 -> BLOCKED,
--   every other 4xx and 5xx (404 included) -> ERROR,
--   unknown / 0 / 1xx / non-numeric / out of range -> nil (field omitted).
-- `overrides` is the plugin's `status_outcomes` config: an exact status
-- code ("200".."599") -> one of the 11 canonical statuses. An override
-- wins over the default; an invalid entry is ignored (the schema rejects
-- it at config time, this is the runtime backstop).
-- Never returns an empty string — callers assign the result directly
-- and a nil leaves the key out of the encoded JSON.
local OUTCOME_STATUSES = {
    SUCCESS = true, PARTIAL = true, TIMEOUT = true, ERROR = true,
    VALIDATION_FAILED = true, FAILED = true, FAILURE = true,
    CANCELLED = true, PENDING = true, BLOCKED = true, HITL_REQUIRED = true,
}

local function outcome_from_status(status, overrides)
    local s = tonumber(status)
    if not s or s < 200 or s > 599 then return nil end
    s = math.floor(s)
    if type(overrides) == "table" then
        local o = overrides[tostring(s)]
        if type(o) == "string" then
            local up = string.upper(o)
            if OUTCOME_STATUSES[up] then return up end
        end
    end
    if s < 400 then return "SUCCESS" end
    if s == 408 or s == 504 then return "TIMEOUT" end
    if s == 499 then return "CANCELLED" end
    if s == 400 or s == 422 then return "VALIDATION_FAILED" end
    if s == 401 or s == 403 or s == 429 then return "BLOCKED" end
    return "ERROR"
end

-- ────────────────────────────────────────────────────────────
-- gRPC Detection
-- Detects gRPC calls via Content-Type header and extracts
-- service/method from the HTTP/2 path (e.g., /pkg.Service/Method).
-- Falls through to standard HTTP metering for non-gRPC requests.
-- ────────────────────────────────────────────────────────────

local function detect_grpc_call(content_type, path, path_prefix)
    if not content_type then return nil end
    if not (string.find(content_type, "application/grpc", 1, true) or
            string.find(content_type, "application/grpc-web", 1, true)) then
        return nil
    end
    if not path or path == "" then return nil end

    -- Strip optional Kong route prefix so /grpc/pkg.Service/Method → /pkg.Service/Method
    local effective_path = path
    if path_prefix and path_prefix ~= "" then
        if string.sub(path, 1, #path_prefix) == path_prefix then
            effective_path = string.sub(path, #path_prefix + 1)
            if effective_path == "" or string.sub(effective_path, 1, 1) ~= "/" then
                effective_path = "/" .. effective_path
            end
        end
    end

    -- gRPC HTTP/2 path format: /fully.qualified.Service/Method
    local service, method = string.match(effective_path, "^/([^/]+)/([^/?#]+)")
    if not service or not method then return nil end

    -- Unary by default; the Grpc-Call-Type header can override it.
    local call_type = kong.request.get_header("Grpc-Call-Type") or "UNARY"

    return {
        grpc_service   = service,
        grpc_method    = method,
        grpc_call_type = string.upper(call_type),
        is_grpc_web    = string.find(content_type, "application/grpc-web", 1, true) ~= nil,
    }
end

-- Maps gRPC trailer grpc-status integer (0-16) to descriptor enum label.
local GRPC_STATUS_LABELS = {
    [0]  = "OK",                   [1]  = "CANCELLED",
    [2]  = "UNKNOWN",              [3]  = "INVALID_ARGUMENT",
    [4]  = "DEADLINE_EXCEEDED",    [5]  = "NOT_FOUND",
    [6]  = "ALREADY_EXISTS",       [7]  = "PERMISSION_DENIED",
    [8]  = "RESOURCE_EXHAUSTED",   [9]  = "FAILED_PRECONDITION",
    [10] = "ABORTED",              [11] = "OUT_OF_RANGE",
    [12] = "UNIMPLEMENTED",        [13] = "INTERNAL",
    [14] = "UNAVAILABLE",          [15] = "DATA_LOSS",
    [16] = "UNAUTHENTICATED",
}

-- gRPC reports its real result in `grpc-status`, usually as an HTTP/2
-- TRAILER on a 200 response; only "trailers-only" error responses carry
-- it as a header. Read, in order: the response header, then the upstream
-- trailer ($upstream_trailer_grpc_status, set by nginx's grpc_pass), then
-- the trailer sent to the client ($sent_trailer_grpc_status). nil when
-- none is readable (e.g. a gRPC-Web upstream that encodes the status in
-- the body frame) — callers then fall back to the HTTP status.
local function read_grpc_status_code()
    local candidates = {
        kong.response.get_header("grpc-status"),
        ngx.var and ngx.var.upstream_trailer_grpc_status,
        ngx.var and ngx.var.sent_trailer_grpc_status,
    }
    for i = 1, 3 do
        local n = tonumber(candidates[i])
        -- Any non-negative integer counts. A code outside 0-16 (a proxy
        -- or a newer gRPC runtime) is still a failure: grpc_outcome maps
        -- it to ERROR instead of falling back to the 200 -> SUCCESS path.
        if n and n >= 0 and n == math.floor(n) then return n end
    end
    return nil
end

local function extract_grpc_status(http_status, grpc_code)
    if grpc_code then
        return GRPC_STATUS_LABELS[grpc_code] or "UNKNOWN"
    end
    -- No readable grpc-status: transport-level failure — derive from HTTP.
    if http_status >= 200 and http_status < 300 then return "OK" end
    if http_status == 401 or http_status == 403 then return "PERMISSION_DENIED" end
    if http_status == 404 then return "NOT_FOUND" end
    if http_status == 408 then return "DEADLINE_EXCEEDED" end
    if http_status == 429 then return "RESOURCE_EXHAUSTED" end
    if http_status >= 500 then return "INTERNAL" end
    return "UNKNOWN"
end

-- grpc-status -> the HTTP status whose outcome it should share, so gRPC
-- follows the same table (and the same `status_outcomes` overrides) as
-- HTTP: UNAUTHENTICATED behaves like 401, PERMISSION_DENIED like 403,
-- RESOURCE_EXHAUSTED like 429. Every code has its own HTTP equivalent so a
-- per-code override (e.g. {"404": ...}) reaches the gRPC code that means
-- the same thing; 2/13/15 and codes outside 0-16 are 500 (ERROR).
local GRPC_OUTCOME_HTTP_EQUIV = {
    [0] = 200,   -- OK                  -> SUCCESS
    [1] = 499,   -- CANCELLED           -> CANCELLED
    [3] = 400,   -- INVALID_ARGUMENT    -> VALIDATION_FAILED
    [4] = 504,   -- DEADLINE_EXCEEDED   -> TIMEOUT
    [5] = 404,   -- NOT_FOUND           -> ERROR
    [6] = 409,   -- ALREADY_EXISTS      -> ERROR
    [7] = 403,   -- PERMISSION_DENIED   -> BLOCKED
    [8] = 429,   -- RESOURCE_EXHAUSTED  -> BLOCKED
    [9] = 400,   -- FAILED_PRECONDITION -> VALIDATION_FAILED
    [10] = 409,  -- ABORTED             -> ERROR
    [11] = 400,  -- OUT_OF_RANGE        -> VALIDATION_FAILED
    [12] = 501,  -- UNIMPLEMENTED       -> ERROR
    [14] = 503,  -- UNAVAILABLE         -> ERROR
    [16] = 401,  -- UNAUTHENTICATED     -> BLOCKED
}

-- executionStatus for a gRPC call. A 200 carrying grpc-status 13 is a
-- failure, so the grpc-status wins whenever it is readable; without it,
-- the HTTP mapping applies.
local function grpc_outcome(grpc_code, http_status, overrides)
    if grpc_code then
        return outcome_from_status(GRPC_OUTCOME_HTTP_EQUIV[grpc_code] or 500, overrides)
    end
    return outcome_from_status(http_status, overrides)
end

-- ────────────────────────────────────────────────────────────
-- GraphQL Detection
-- GraphQL operations arrive as HTTP POST with application/json body
-- containing {"query": "...", "operationName": "...", "variables": {...}}.
-- We extract operation type + name. Real complexity scoring happens
-- in the @aforo/graphql-metering SDK; Kong's Lua is intentionally cheap.
-- ────────────────────────────────────────────────────────────

local function detect_graphql_call(raw_body, content_type, path, path_pattern)
    if not raw_body or raw_body == "" then return nil end
    if not content_type or not string.find(content_type, "application/json", 1, true) then
        return nil
    end

    -- Fast-path: require the URL to match the configured pattern (default "graphql" or "gql")
    local pattern = path_pattern or "graphql"
    if not string.find(path or "", pattern, 1, true) and
       not string.find(path or "", "gql", 1, true) then
        return nil
    end

    local ok, parsed = pcall(cjson.decode, raw_body)
    if not ok or not parsed or type(parsed) ~= "table" or type(parsed.query) ~= "string" then
        return nil
    end

    local query = parsed.query
    local operation_name = parsed.operationName
    if type(operation_name) ~= "string" then operation_name = nil end

    -- Operation type from the first keyword. Query is the default per the GraphQL spec.
    local trimmed = string.gsub(query, "^%s+", "")
    local op_type = "QUERY"
    if string.find(trimmed, "^mutation") then
        op_type = "MUTATION"
    elseif string.find(trimmed, "^subscription") then
        op_type = "SUBSCRIPTION"
    end

    -- No operationName: try the document itself (query MyName { ... }).
    if not operation_name or operation_name == "" then
        operation_name = string.match(trimmed, "^%w+%s+([%w_]+)")
    end

    -- Rough complexity heuristic (opening braces). Real scoring lives in the SDK;
    -- this only guarantees the event always carries a value.
    local _, brace_count = string.gsub(query, "{", "")

    return {
        gql_operation_type = op_type,
        gql_operation_name = operation_name or "anonymous",
        gql_complexity     = brace_count or 0,
    }
end

-- ────────────────────────────────────────────────────────────
-- WebSocket Upgrade Detection
-- WebSocket billing entry-point: the HTTP upgrade handshake. After the
-- 101 response Kong cannot see individual frames in the log phase, so
-- frame-level metering lives in @aforo/ws-metering. This branch emits
-- one CONNECTION_OPENED event per successful handshake.
-- ────────────────────────────────────────────────────────────

local function detect_websocket_upgrade(upgrade_header, status, request_id)
    if not upgrade_header then return nil end
    if string.lower(upgrade_header) ~= "websocket" then return nil end
    -- Successful handshake = HTTP 101. Other statuses = failed upgrade → skip.
    if status ~= 101 then return nil end

    local connection_id = nonempty(kong.request.get_header("Sec-WebSocket-Key"))
        or request_id
        or random_uuid()
    if not connection_id then return nil end

    return {
        ws_connection_id = connection_id,
        ws_direction     = "SERVER_TO_CLIENT",
    }
end

-- ────────────────────────────────────────────────────────────
-- MCP JSON-RPC Detection
-- ────────────────────────────────────────────────────────────

local function detect_mcp_tool_call(raw_body)
    if not raw_body or raw_body == "" then return nil end

    local ok, parsed = pcall(cjson.decode, raw_body)
    if not ok or not parsed then return nil end

    if parsed.jsonrpc ~= "2.0" then return nil end
    if parsed.method ~= "tools/call" then return nil end

    local params = parsed.params or {}
    local tool_name = params.name
    if not tool_name then return nil end

    local agent_id = nil
    if params._meta and params._meta.agent_id then
        agent_id = params._meta.agent_id
    end

    return {
        tool_name = tool_name,
        agent_id = agent_id,
    }
end

-- ────────────────────────────────────────────────────────────
-- Access phase handler (runs before proxying to upstream)
-- Stashes trace context and (for MCP / GraphQL) the request body, then runs
-- the optional checks, all off by default: JWT validation, rate limit,
-- pre-flight quota, margin guard.
-- ────────────────────────────────────────────────────────────

function AforoMeteringHandler:access(conf)
    kong.ctx.shared.aforo_trace = extract_trace_context()

    -- Only ever schedules a background refresh; never waits on one.
    maybe_refresh_mappings(conf)

    -- ── Capture the request body for the log phase ──
    -- kong.request.get_raw_body() may only read the body in the
    -- rewrite/access phases. By the log phase nginx has already
    -- discarded the unbuffered body, so calling it there raises a
    -- phase error / returns nil (the silent-fail mode flagged in the
    -- 2026-04-20 audit). Read it once here and stash it so the
    -- log-phase MCP detector + request-size accounting get a real
    -- string — same access→log handoff pattern used for aforo_trace
    -- above. Gated on the two body-inspecting detectors (MCP, GraphQL)
    -- so other routes never force nginx to buffer (or spill to a temp
    -- file) a large upload just to size it.
    -- pcall-guarded: the body is legitimately unavailable for streamed or
    -- oversized requests, and that must not fail the request.
    if conf.mcp_enabled or conf.graphql_enabled then
        local ok, body = pcall(kong.request.get_raw_body)
        kong.ctx.shared.aforo_raw_body = ok and body or nil
    end

    -- ── JWT Validation (runs first — all subsequent checks depend on validated identity) ──
    if conf.jwt_validation_enabled then
        local token = extract_bearer_token()
        if not token then
            return kong.response.exit(401, {
                error             = "unauthorized",
                error_description = "Bearer token required",
            })
        end

        local result = validate_jwt(token, conf)
        if not result.valid then
            kong.log.warn("[aforo-metering] JWT rejected (", result.reason, ")")
            return kong.response.exit(401, {
                error             = "invalid_token",
                error_description = result.reason,
            })
        end

        -- Stash validated identity for log phase and downstream use
        kong.ctx.shared.aforo_jwt_claims = result

        -- Propagate verified claims as trusted downstream headers
        -- (overwrite any client-supplied headers — these come from the validated JWT)
        kong.service.request.set_header("X-Customer-Id", result.customer_id)
        kong.service.request.set_header("X-Tenant-Id",   result.tenant_id)
        kong.service.request.set_header("X-Key-Id",      result.key_id)
        kong.service.request.set_header("X-Scopes",      result.scopes)
        if result.environment then
            kong.service.request.set_header("X-Environment", result.environment)
        end
    end

    -- Rate limit enforcement (reads policy from Redis, returns 429 on HARD breach)
    rate_limit.enforce(conf)

    -- See resolve_customer_id for the identity models. Never reads request
    -- headers or query params — those sources were removed 2026-04-23.
    local consumer = kong.client.get_consumer()
    local customer_id = resolve_customer_id(conf, consumer)

    -- Pre-flight quota check against the ingestor. Off unless
    -- preflight_quota_enabled; fails open by default; see preflight-quota.lua.
    -- The metric is resolved the way the log phase will bill it, minus the
    -- upstream response header, which does not exist yet.
    if conf.preflight_quota_enabled then
        local service = kong.router.get_service()
        local route = kong.router.get_route()
        local metric = resolve_metric_name(conf, kong.request.get_method(), kong.request.get_path(),
            service and service.name or "", route and route.name or "",
            consumer and (consumer.username or consumer.custom_id) or "", nil)
        if preflight_quota.check(conf, customer_id, metric) then
            return  -- answered 429/503; skip the remaining checks
        end
    end

    -- Margin guard pre-flight check (calls pricing-service quick-check, returns 429 on L2/L3).
    margin_guard.check(conf, conf.tenant_id, customer_id)
end

-- ────────────────────────────────────────────────────────────
-- Log phase handler (runs after response is sent to client)
-- ────────────────────────────────────────────────────────────

function AforoMeteringHandler:log(conf)
    local method = kong.request.get_method()
    local path = kong.request.get_path()
    local status = kong.response.get_status()

    if should_exclude_path(path, conf.exclude_paths) then return end
    if should_exclude_status(status, conf.exclude_status_codes) then return end

    -- Never meter a CORS preflight. It is a browser protocol detail, not an
    -- API call, and it carries no credentials, so it has no customer.
    if method == "OPTIONS" and kong.request.get_header("Access-Control-Request-Method") then
        return
    end

    local consumer = kong.client.get_consumer()
    local headers = kong.request.get_headers()
    local service = kong.router.get_service()
    local route = kong.router.get_route()
    local latency = kong.response.get_header("X-Kong-Proxy-Latency")
    -- Read from the access-phase stash — get_raw_body() cannot be called
    -- here (log phase). nil when mcp_enabled is off; MCP detection then
    -- no-ops and metering falls through to the standard HTTP path.
    local raw_body = kong.ctx.shared.aforo_raw_body
    -- Prefer the exact buffered-body length; fall back to the Content-Length
    -- request header when the body wasn't buffered (mcp disabled), so
    -- request_size stays accurate without forcing a body read on every route.
    local request_size = (raw_body and #raw_body)
        or tonumber(kong.request.get_header("Content-Length"))
        or 0
    local response_size = tonumber(kong.response.get_header("Content-Length")) or 0
    local request_id = nonempty(kong.request.get_header("X-Request-Id"))
        or nonempty(kong.request.get_header("X-Kong-Request-Id"))
    local session_id = kong.request.get_header("Mcp-Session-Id")

    local service_name = service and service.name or ""
    local route_name = route and route.name or ""
    local consumer_name = consumer and (consumer.username or consumer.custom_id) or ""
    local customer_id = resolve_customer_id(conf, consumer, headers)

    -- No verified identity -> no event. The ingestor requires customerId, so
    -- a null one was rejected there anyway; sending it only cost a call and
    -- a failed row. Nothing is buffered, so no idempotency key is minted.
    if customer_id == nil or customer_id == "" then
        kong.log.debug("[aforo-metering] no verified customer identity for ",
            method, " ", path, " - request not metered")
        return
    end

    -- W3C trace context (prefer access-phase stash, fallback to re-extraction)
    local trace = kong.ctx.shared.aforo_trace or extract_trace_context()

    -- A body detector is on but the log phase has no body: usually another
    -- plugin aborted the access phase before ours ran. Warn loudly instead of
    -- silently producing zero MCP/GraphQL events.
    if (conf.mcp_enabled or conf.graphql_enabled) and method == "POST"
       and (not raw_body or raw_body == "") then
        kong.log.warn("[aforo-metering] MCP/GraphQL detection enabled but ",
            "request body is empty in log phase. Either no body was sent ",
            "or another plugin consumed it before our access handler ran. ",
            "MCP/GraphQL events for this request WILL be skipped — ",
            "falling back to standard HTTP metering.")
    end

    -- MCP Detection
    local mcp_info = nil
    if conf.mcp_enabled and method == "POST" then
        mcp_info = detect_mcp_tool_call(raw_body)
    end

    -- gRPC Detection
    local grpc_info = nil
    if conf.grpc_enabled and not mcp_info then
        local content_type = headers["content-type"] or kong.response.get_header("Content-Type")
        grpc_info = detect_grpc_call(content_type, path, conf.grpc_path_prefix)
    end

    -- GraphQL Detection
    local gql_info = nil
    if conf.graphql_enabled and not mcp_info and not grpc_info and method == "POST" then
        gql_info = detect_graphql_call(raw_body, headers["content-type"], path,
            conf.graphql_path_pattern)
    end

    -- WebSocket Upgrade Detection
    local ws_info = nil
    if conf.websocket_enabled and not mcp_info and not grpc_info and not gql_info then
        ws_info = detect_websocket_upgrade(headers["upgrade"], status, request_id)
    end

    -- Build usage event
    --
    -- Idempotency keys on EVERY branch are built from stable per-request
    -- identity only (Rule #21): X-Request-Id / X-Kong-Request-Id, the
    -- WebSocket handshake key, or — when the request carries none — one
    -- random UUID materialized into the buffered event and re-sent
    -- verbatim by flush_buffer's retry loop. NEVER add a clock
    -- (ngx.now / os.time / os.clock) to a key: a re-evaluation would mint
    -- a new key, defeat ingest dedup and bill the request twice.
    local event = {}

    if mcp_info then
        event.customerId     = customer_id
        event.metricName     = "mcp_server.tool_invocations"
        event.quantity       = 1
        -- Idempotency key FROZEN (post-P0-5 self-review, 2026-07-12 —
        -- matches Apigee/AWS/Azure/MuleSoft discipline; same class as
        -- the A+ delivery-guarantee prompt 4 concern that Rule #21
        -- codifies for the compound path). The previous form appended
        -- tostring(ngx.now()) — a per-evaluation clock component that
        -- would make any log-phase re-evaluation for the same request
        -- produce a different key. Under a hypothetical redelivery
        -- path (Kong-level retry, higher-layer replay), the drifted
        -- key would defeat ingest dedup and double-bill. request_id
        -- comes from a stable header (X-Request-Id or X-Kong-Request-Id);
        -- the generated-uuid fallback is materialized once into the
        -- flush buffer and re-sent verbatim by flush_buffer's 3-retry
        -- loop, so within-invocation retries are byte-identical. NEVER
        -- reintroduce a clock (ngx.now / os.time / os.clock) here.
        event.idempotencyKey = "mcp:" .. (conf.tenant_id or "") .. ":" ..
                               (request_id or random_uuid()) .. ":" ..
                               mcp_info.tool_name
        event.occurredAt     = iso8601_utc(ngx.now())
        event.toolName       = mcp_info.tool_name
        event.agentId        = mcp_info.agent_id or headers["x-agent-id"]
        event.sessionId      = session_id
        -- MCP_SERVER requires toolName AND agentId. A tool call with no agent
        -- id keeps the configured product_type rather than being sent as an
        -- MCP_SERVER event the ingestor must refuse.
        if nonempty(event.toolName) and nonempty(event.agentId) then
            event.productType = "MCP_SERVER"
        else
            event.productType = normalize_product_type(conf.product_type)
        end
        -- Shared outcome table: 2xx stays SUCCESS; non-2xx now follows
        -- the table (504 -> TIMEOUT instead of ERROR). Kong does not
        -- buffer the upstream response body, so a JSON-RPC `error`
        -- object inside a 2xx response cannot be detected here.
        event.executionStatus = outcome_from_status(status, conf.status_outcomes)
        event.executionDurationMs = tonumber(latency) or 0
    elseif grpc_info then
        event.customerId     = customer_id
        event.metricName     = "grpc_api.rpc_calls"
        event.quantity       = 1
        event.idempotencyKey = "grpc:" .. (conf.tenant_id or "") .. ":" ..
                               (request_id or random_uuid()) .. ":" ..
                               grpc_info.grpc_service .. "/" .. grpc_info.grpc_method
        event.occurredAt     = iso8601_utc(ngx.now())
        event.productType    = "GRPC_API"
        event.grpcService    = grpc_info.grpc_service
        event.grpcMethod     = grpc_info.grpc_method
        local grpc_code = read_grpc_status_code()
        -- exclude_status_codes is in HTTP terms. gRPC auth and rate-limit
        -- failures arrive on HTTP 200, so check the gRPC code's HTTP
        -- equivalent too — otherwise UNAUTHENTICATED bills as BLOCKED while
        -- the same failure over plain HTTP (401) is dropped.
        if grpc_code and should_exclude_status(
                GRPC_OUTCOME_HTTP_EQUIV[grpc_code] or 500, conf.exclude_status_codes) then
            return
        end
        event.grpcStatusCode = extract_grpc_status(status, grpc_code)
        event.grpcCallType   = grpc_info.grpc_call_type
        event.messageCount   = tonumber(kong.request.get_header("Grpc-Message-Count")) or 1
        event.dataBytes      = (request_size or 0) + (response_size or 0)
        event.executionStatus = grpc_outcome(grpc_code, status, conf.status_outcomes)
        event.executionDurationMs = tonumber(latency) or 0
    elseif gql_info then
        event.customerId     = customer_id
        event.metricName     = "graphql_api.operations"
        event.quantity       = 1
        event.idempotencyKey = "gql:" .. (conf.tenant_id or "") .. ":" ..
                               (request_id or random_uuid()) .. ":" ..
                               gql_info.gql_operation_name
        event.occurredAt     = iso8601_utc(ngx.now())
        event.productType    = "GRAPHQL_API"
        event.gqlOperationType = gql_info.gql_operation_type
        event.gqlOperationName = gql_info.gql_operation_name
        event.gqlComplexity  = gql_info.gql_complexity
        event.gqlHasErrors   = (status >= 400)
        event.dataBytes      = (request_size or 0) + (response_size or 0)
        event.executionStatus = outcome_from_status(status, conf.status_outcomes)
        event.executionDurationMs = tonumber(latency) or 0
    elseif ws_info then
        -- One event per successful handshake. The handshake key is unique per
        -- connection, so the key needs no other component.
        event.customerId     = customer_id
        event.metricName     = "websocket_api.connection_opened"
        event.quantity       = 1
        event.idempotencyKey = "ws:" .. (conf.tenant_id or "") .. ":" .. ws_info.ws_connection_id
        event.occurredAt     = iso8601_utc(ngx.now())
        event.productType    = "WEBSOCKET_API"
        event.wsConnectionId = ws_info.ws_connection_id
        event.wsDirection    = ws_info.ws_direction
        event.wsFrameType    = "TEXT"   -- no frames yet; the SDK meters frames
        event.messageCount   = 0
        event.dataBytes      = 0
        -- 101 is not a final outcome, so executionStatus is left unset.
        event.executionDurationMs = tonumber(latency) or 0
    else
        -- The ingestor's prod profile rejects an event without a productType,
        -- so plain HTTP events carry the configured one (default "API");
        -- AGENTIC_API overrides it below when a trace id is present.
        event.productType    = normalize_product_type(conf.product_type)
        event.customerId     = customer_id
        -- Upstream-supplied overrides, read from the RESPONSE so a client
        -- cannot forge them.
        local header_metric = nonempty(conf.metric_header)
            and kong.response.get_header(conf.metric_header) or nil
        local header_quantity = nonempty(conf.quantity_header)
            and kong.response.get_header(conf.quantity_header) or nil
        event.metricName     = resolve_metric_name(conf, method, path, service_name,
                                                   route_name, consumer_name, header_metric)
        event.quantity       = resolve_quantity(conf, response_size, header_quantity)
        event.idempotencyKey = generate_idempotency_key(request_id)
        event.occurredAt     = iso8601_utc(ngx.now())

        -- AGENTIC_API classification — stamped only when a trace id is
        -- resolvable (per descriptor eventSchema.inferenceRule = HAS_TRACE).
        -- Fields go top-level so SchemaBasedEventValidator.getTopLevelField
        -- reads them via the P0-6 DTO-first lookup — metadata is not
        -- searched for descriptor requiredFields (endpoint/method/
        -- status_code/trace_id).
        local agentic_trace_id = extract_agentic_trace_id(trace)
        if agentic_trace_id then
            event.productType = "AGENTIC_API"
            event.traceId     = agentic_trace_id
        end

        -- Outcome for OUTCOME_BASED pricing (standard API + AGENTIC_API).
        -- nil when the status is not determinable -> key omitted.
        event.executionStatus = outcome_from_status(status, conf.status_outcomes)
    end

    -- Top-level HTTP fields (hoisted from metadata for fast ClickHouse queries)
    event.endpointPath    = path
    event.httpMethod      = method
    event.statusCode      = status
    event.responseTimeMs  = tonumber(latency) or 0

    -- W3C trace context (null when absent — fidelity, not synthetic)
    event.trace = trace

    -- Metadata (kept for backward compat — HTTP fields will be removed here in a follow-up)
    if conf.include_metadata then
        event.metadata = {
            gateway       = "kong",
            method        = method,
            path          = path,
            status        = status,
            latency       = tonumber(latency) or 0,
            endpoint_path = path,
            http_method   = method,
            status_code   = status,
            response_time_ms = tonumber(latency) or 0,
            requestSize   = request_size,
            responseSize  = response_size,
            service       = service_name,
            route         = route_name,
            consumer      = consumer_name,
        }
    end

    -- Billing-hierarchy identity. usage-ingestor's BillingHierarchyEnricher
    -- resolves team / member / subscription from an identity in metadata;
    -- key_id is the Aforo API-key id carried by the JWT this plugin verified.
    -- Set outside the include_metadata block: include_metadata=false turns off
    -- diagnostic metadata, not billing attribution. Only from a token whose
    -- signature was verified.
    local jwt_claims = kong.ctx.shared and kong.ctx.shared.aforo_jwt_claims
    if type(jwt_claims) == "table" and jwt_claims.signature_verified == true
       and nonempty(jwt_claims.key_id) then
        event.metadata = event.metadata or {}
        event.metadata.keyId = jwt_claims.key_id
    end

    -- quantity must be > 0 (e.g. quantity_source=response_size with an empty
    -- body). The ingestor refuses anything else.
    if type(event.quantity) ~= "number" or event.quantity <= 0 then
        kong.log.debug("[aforo-metering] Skipping ", method, " ", path,
            " -- quantity is not > 0.")
        return
    end

    -- A metric name the ingestor would refuse on shape (blank or > 255
    -- characters, e.g. a {path} template on a very long URL, or a blank
    -- mapping). Dropped here and counted, so it is visible. A well-formed name
    -- that is not in the tenant's catalog is refused by the ingestor per
    -- event; send_batch counts those as "ingestor_rejected".
    if not valid_metric_name(event.metricName) then
        local total = record_drop("invalid_metric", 1)
        warn_throttled("invalid_metric", 60,
            "[aforo-metering] Skipping ", method, " ", path, " -- resolved metric name is blank ",
            "or longer than ", MAX_METRIC_NAME_LENGTH, " characters. Check metric_mappings / ",
            "metric_name_pattern / the ", tostring(conf.metric_header), " response header. ",
            "Cumulative: ", total or "?", ". Repeats suppressed for 60s.")
        return
    end

    -- An event its productType makes invalid (e.g. product_type=AI_AGENT on an
    -- HTTP route, which has no agentId) is refused by the ingestor; skip it
    -- here and say why.
    local missing = missing_required_fields(event)
    if missing then
        local total = record_drop("missing_fields", 1)
        warn_throttled("missing_fields_" .. tostring(event.productType), 300,
            "[aforo-metering] Skipping events: product_type ", tostring(event.productType),
            " requires ", table.concat(missing, ", "), ", which this request did not ",
            "supply (e.g. ", method, " ", path, "). Cumulative: ", total or "?",
            ". Repeats suppressed for 300s.")
        return
    end

    -- Buffer the event
    local dict = ngx.shared[BUFFER_DICT]
    if not dict then
        kong.log.err("[aforo-metering] Shared dict '", BUFFER_DICT, "' not available. ",
            "Add 'lua_shared_dict aforo_buffer 10m;' to kong.conf")
        return
    end

    local encoded, enc_err = cjson.encode(event)
    if not encoded then
        kong.log.err("[aforo-metering] Could not encode event for ", method, " ", path,
            ": ", tostring(enc_err), ". Event not metered.")
        return
    end

    -- One atomic append; the returned length is this event's position, so it
    -- also drives flush scheduling without a separate counter that could drift.
    local count, push_err = dict:rpush(BUFFER_KEY, encoded)
    if not count then
        local total = record_drop("buffer_overflow", 1)
        kong.log.err("[aforo-metering] Could not buffer event (", tostring(push_err), "). ",
            "Raise lua_shared_dict aforo_buffer if this recurs. Event not metered. ",
            "Cumulative overflow drops: ", total or "?")
        return
    end

    if count > MAX_BUFFER_SIZE then
        -- Over the cap: take one event back off the tail -- this one, or one a
        -- concurrent worker appended a moment later. Either way the newest, so
        -- the oldest (closest to the ingestor's acceptance window) are kept.
        dict:rpop(BUFFER_KEY)
        local dropped_total = record_drop("buffer_overflow", 1)
        warn_throttled("buffer_overflow", 10,
            "[aforo-metering] Buffer full (", MAX_BUFFER_SIZE, " events) -- dropping the ",
            "newest event. The ingestor is failing or unreachable; see the flush errors. ",
            "Cumulative overflow drops: ", dropped_total or "?", ". Repeats suppressed for 10s.")
        -- Keep a flush coming so the buffer drains once the ingestor recovers.
        schedule_flush(conf, 0, FLUSH_NOW_KEY)
        return
    end

    if count >= (conf.flush_count or 50) then
        schedule_flush(conf, 0, FLUSH_NOW_KEY)
    else
        schedule_flush(conf, (conf.flush_interval_ms or 5000) / 1000, FLUSH_TIMED_KEY)
    end
end

-- Exported for unit testing — not used by the Kong runtime.
-- Keep the top-level handler contract (access/log) unchanged.
AforoMeteringHandler._resolve_customer_id = resolve_customer_id
AforoMeteringHandler._record_drop = record_drop
AforoMeteringHandler._extract_agentic_trace_id = extract_agentic_trace_id
AforoMeteringHandler._generate_idempotency_key = generate_idempotency_key
AforoMeteringHandler._outcome_from_status = outcome_from_status
AforoMeteringHandler._detect_grpc_call = detect_grpc_call
AforoMeteringHandler._grpc_outcome = grpc_outcome
AforoMeteringHandler._read_grpc_status_code = read_grpc_status_code
AforoMeteringHandler._extract_grpc_status = extract_grpc_status
AforoMeteringHandler._detect_graphql_call = detect_graphql_call
AforoMeteringHandler._detect_websocket_upgrade = detect_websocket_upgrade
AforoMeteringHandler._iso8601_utc = iso8601_utc
AforoMeteringHandler._flush_buffer = flush_buffer
AforoMeteringHandler._send_batch = send_batch
AforoMeteringHandler._validate_jwt = validate_jwt
AforoMeteringHandler._resolve_metric_name = resolve_metric_name
AforoMeteringHandler._resolve_quantity = resolve_quantity
AforoMeteringHandler._normalize_product_type = normalize_product_type
AforoMeteringHandler._fetch_mappings = fetch_mappings
AforoMeteringHandler._mapping_matches = mapping_matches

return AforoMeteringHandler
