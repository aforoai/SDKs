-- Aforo Metering Plugin for Kong Gateway
-- Runs in `access` and `log` phases to capture API usage events and
-- forward them to Aforo's usage ingestor service.
--
-- access phase: stashes W3C trace context for later correlation (no-op enforcement — Session 5)
-- log phase: builds event payload and buffers for batch flush
--
-- Zero latency impact on the critical path: metering runs in post-response log phase.
-- Batched: buffers events in shared memory, flushes periodically.
-- Retry: 3x exponential backoff on ingestor failures.

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

-- UUID source (2026-09-01 fix).
--
-- The call sites below previously reached for the uuid helper through the PDK
-- global. `kong.tools` is not part of the PDK in Kong 3.x, so that raised
-- "attempt to index field 'tools' (a nil value)" and aborted the entire log
-- phase -- meaning no event was buffered and the plugin metered nothing. The
-- module also moved between releases: kong.tools.utils.uuid before Kong 3.9,
-- kong.tools.uuid.uuid from 3.9 on. Resolve once at load with a fallback chain
-- so the plugin spans both without a version check.
local uuid
do
    local function try(mod_name, fn_name)
        local ok, mod = pcall(require, mod_name)
        if ok and type(mod) == "table" and type(mod[fn_name]) == "function" then
            return mod[fn_name]
        end
        return nil
    end

    uuid = try("kong.tools.uuid", "uuid")        -- Kong >= 3.9
        or try("kong.tools.utils", "uuid")       -- Kong <  3.9

    if not uuid then
        local ok, jit_uuid = pcall(require, "resty.jit-uuid")
        if ok and type(jit_uuid) == "table" and type(jit_uuid.generate_v4) == "function" then
            pcall(jit_uuid.seed)
            uuid = jit_uuid.generate_v4
        end
    end

    if not uuid then
        -- Never leave this nil: both callers use it inside idempotency keys on
        -- the metering hot path, and a nil here takes down the log phase again.
        -- Not a real UUID, but unique enough to keep events distinct.
        uuid = function()
            return string.format("%d-%d-%d", ngx.worker.pid(), ngx.now() * 1000, math.random(1e9))
        end
    end
end

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

-- Format an epoch timestamp as ISO-8601 UTC with milliseconds.
--
-- 2026-09-01 fix. occurredAt was emitted as `ngx.now() * 1000`, i.e. a bare
-- number of epoch MILLIseconds. The ingestor deserialises occurredAt into a
-- java.time.Instant, and Jackson reads a bare number as epoch SECONDS -- so
-- 1788268682221 was read as the year 58637 and every single event was rejected
-- with "Event timestamp is too far in the future". Gateway-metered usage never
-- persisted at all.
--
-- It failed quietly in the worst way: /v1/ingest/batch answers 202 with a
-- per-event `failed` count rather than an HTTP error, so the plugin's own
-- flush logged success and moved on. Emitting a string removes the ambiguity
-- entirely -- there is no unit to misread.
local function iso8601_utc(epoch_seconds)
    local secs = math.floor(epoch_seconds)
    local ms = math.floor((epoch_seconds - secs) * 1000 + 0.5)
    if ms >= 1000 then
        secs = secs + 1
        ms = 0
    end
    return string.format("%s.%03dZ", os.date("!%Y-%m-%dT%H:%M:%S", secs), ms)
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

-- RS256 signature verification, via Kong's bundled resty.openssl.
--
-- FAIL-CLOSED (2026-09-01 security fix). This previously returned true both
-- when the JWT library was missing AND when no jwt_public_key was configured,
-- so a stock install could run jwt_validation_enabled=true while verifying no
-- signature at all. exp / iss / jti / key_id are all read from the token
-- payload, and that payload is only trustworthy once the signature is checked
-- -- so an unverified token let any caller mint their own JWT naming an
-- arbitrary customer_id and tenant_id and receive authorized,
-- correctly-attributed access: free API usage, billed to somebody else.
--
-- Uses resty.openssl rather than lua-resty-jwt. lua-resty-jwt pulls in
-- lua-resty-hmac, whose FFI binding does not load against OpenSSL 3
-- ("size of C type is unknown or too large" -- HMAC_CTX became opaque in
-- OpenSSL 3). Kong 3.x links OpenSSL 3, so that dependency could never load
-- here no matter how it was installed; the failure surfaced as a bare
-- "signature cannot be verified" and looked like a packaging problem.
-- resty.openssl ships with Kong, is OpenSSL 3 native, and needs no external
-- rock -- so this also removes an install step that could not be satisfied
-- from the LuaRocks mirrors anyway.
--
-- Operators who deliberately terminate JWT verification upstream (Kong
-- Enterprise native JWT plugin, a service mesh, an external authorizer) opt out
-- via jwt_allow_unverified_signature=true: explicit, defaulting to false, and
-- logged at ERROR so the posture is never silent.
local function verify_rs256_signature(token, conf)
    local allow_unverified = conf.jwt_allow_unverified_signature == true

    if not conf.jwt_public_key or conf.jwt_public_key == "" then
        -- jwt_jwks_uri is declared in schema.lua but no JWKS fetcher is
        -- implemented, so a JWKS-only configuration verifies nothing.
        kong.log.err("[aforo-metering] No jwt_public_key configured -- RS256 signature CANNOT ",
            "be verified (jwt_jwks_uri is declared but not yet implemented). Set jwt_public_key ",
            "to the issuer's PEM public key, or jwt_allow_unverified_signature=true only if ",
            "signatures are verified upstream.")
        return allow_unverified
    end

    local ok, pkey = pcall(require, "resty.openssl.pkey")
    if not ok then
        -- Surface the underlying loader error. Reporting only "library not
        -- found" here is what made the OpenSSL 3 breakage above look like a
        -- missing package for so long.
        kong.log.err("[aforo-metering] resty.openssl unavailable -- RS256 signature CANNOT be ",
            "verified. Underlying error: ", tostring(pkey))
        return allow_unverified
    end

    local dot1 = string.find(token, ".", 1, true)
    local dot2 = dot1 and string.find(token, ".", dot1 + 1, true)
    if not dot2 or string.find(token, ".", dot2 + 1, true) then
        return false
    end

    local signing_input = string.sub(token, 1, dot2 - 1)
    local signature = base64url_decode(string.sub(token, dot2 + 1))
    if not signature or #signature == 0 then
        return false
    end

    local pk, perr = pkey.new(conf.jwt_public_key)
    if not pk then
        -- A malformed configured key is an operator error, not an upstream
        -- one. Never honour allow_unverified here: that would turn a typo in
        -- the PEM into an open gate.
        kong.log.err("[aforo-metering] jwt_public_key could not be parsed as a public key: ",
            tostring(perr))
        return false
    end

    local verified, verr = pk:verify(signature, signing_input, "sha256")
    if verr then
        kong.log.err("[aforo-metering] RS256 verification error: ", tostring(verr))
        return false
    end

    return verified == true
end

-- Main JWT validation entry point.
-- Returns {valid=bool, reason=string, customer_id, tenant_id, key_id, scopes, ...}
local function validate_jwt(token, conf)
    -- 1. Parse claims (structure + encoding check)
    local claims, parts = parse_jwt_claims(token)
    if not claims then
        return { valid = false, reason = "MALFORMED_TOKEN" }
    end

    -- 2. Expiry check
    local exp = claims.exp
    if not exp or ngx.time() > tonumber(exp) then
        return { valid = false, reason = "TOKEN_EXPIRED" }
    end

    -- 3. Issuer check
    if conf.jwt_issuer and conf.jwt_issuer ~= "" and claims.iss ~= conf.jwt_issuer then
        kong.log.warn("[aforo-metering] JWT issuer mismatch: got '", claims.iss,
            "', expected '", conf.jwt_issuer, "'")
        return { valid = false, reason = "INVALID_ISSUER" }
    end

    -- 4. RS256 signature verification (resty.openssl; fail-closed -- see above)
    if not verify_rs256_signature(token, conf) then
        return { valid = false, reason = "INVALID_SIGNATURE" }
    end

    -- Resolve Redis coords for jti blocklist checks.
    -- Prefer dedicated jwt_redis_* config; fall back to rate_limit_redis_*.
    local redis_host = (conf.jwt_redis_host and conf.jwt_redis_host ~= "" and conf.jwt_redis_host)
                       or conf.rate_limit_redis_host or "127.0.0.1"
    local redis_port = conf.jwt_redis_port or conf.rate_limit_redis_port or 6379

    -- 5. jti blocklist (revoked individual token)
    local jti = claims.jti
    if is_jti_blocked(jti, redis_host, redis_port) then
        return { valid = false, reason = "TOKEN_REVOKED" }
    end

    -- 6. Client-level revocation (all tokens for this key_id revoked)
    local key_id = claims.key_id
    if is_client_revoked(key_id, redis_host, redis_port) then
        return { valid = false, reason = "CLIENT_REVOKED" }
    end

    -- 7. Return validated claims
    return {
        valid        = true,
        customer_id  = claims.customer_id or claims.sub or "",
        tenant_id    = claims.tenant_id   or "",
        key_id       = claims.key_id      or "",
        scopes       = type(claims.scopes) == "table"
                           and table.concat(claims.scopes, " ")
                           or (claims.scopes or ""),
        environment  = claims.environment or "live",
        offering_ids = claims.offering_ids,
        jti          = jti,
    }
end

local AforoMeteringHandler = {
    PRIORITY = 5,    -- Run after most other plugins
    VERSION  = "1.1.0",
}

-- Shared memory buffer name (must be declared in kong.conf: lua_shared_dict aforo_buffer 10m)
local BUFFER_KEY = "events"
local BUFFER_COUNT_KEY = "event_count"
local MAX_BUFFER_SIZE = 10000

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
-- Central metric mappings, fetched from Aforo
-- ────────────────────────────────────────────────────────────
--
-- Declaring endpoint->metric rules in gateway config works and does not scale:
-- a customer with a hundred metrics maintains a hundred rules by hand, and every
-- new metric couples an Aforo change to a gateway deploy. Catalog serves the
-- same table, projected from the metric's own filter conditions, so the customer
-- declares it once where the metric is defined.
--
-- Two rules govern this code:
--   * It never blocks a request. Refresh runs in a timer; the request path only
--     ever reads the cache.
--   * A stale table beats no table. If catalog is unreachable we keep serving
--     what we last saw, indefinitely, and log. The alternative is silently
--     re-attributing live traffic to default_metric, which is a revenue bug that
--     looks like nothing at all.
--
-- Cached in the existing aforo_buffer dict on purpose: requiring a second
-- lua_shared_dict would add a deployment step operators forget, and a missing
-- dict already costs this plugin all of its metering.
local MAPPINGS_KEY = "aforo:gateway_mappings"
local MAPPINGS_FETCHED_AT_KEY = "aforo:gateway_mappings_at"
local MAPPINGS_INFLIGHT_KEY = "aforo:gateway_mappings_inflight"

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

    dict:delete(MAPPINGS_INFLIGHT_KEY)

    if not res or res.status < 200 or res.status >= 300 then
        -- Keep whatever is cached. Do not clear it.
        kong.log.warn("[aforo-metering] Could not refresh metric mappings from ", url,
            " (status=", res and res.status or "no response", ", err=", err or "none",
            "). Continuing with the cached table.")
        return
    end

    local ok, body = pcall(cjson.decode, res.body)
    if not ok or type(body) ~= "table" or type(body.mappings) ~= "table" then
        kong.log.err("[aforo-metering] Metric mappings response was not usable JSON; ",
            "keeping the cached table.")
        return
    end

    dict:set(MAPPINGS_KEY, cjson.encode(body.mappings))
    dict:set(MAPPINGS_FETCHED_AT_KEY, ngx.now())
    if body.cacheTtlSeconds and tonumber(body.cacheTtlSeconds) then
        dict:set("aforo:gateway_mappings_ttl", tonumber(body.cacheTtlSeconds))
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

    local fetched_at = dict:get(MAPPINGS_FETCHED_AT_KEY)
    local ttl = dict:get("aforo:gateway_mappings_ttl") or conf.mappings_refresh_seconds or 300
    if fetched_at and (ngx.now() - fetched_at) < ttl then return end

    -- One worker fetches; the rest carry on with the cache. add() is atomic, so
    -- a burst of concurrent requests cannot stampede catalog.
    local claimed = dict:add(MAPPINGS_INFLIGHT_KEY, 1, 30)
    if not claimed then return end

    local ok, err = ngx.timer.at(0, fetch_mappings, conf)
    if not ok then
        dict:delete(MAPPINGS_INFLIGHT_KEY)
        kong.log.warn("[aforo-metering] Could not schedule mappings refresh: ", err)
    end
end

-- Match a path against one cached rule. Plain string comparisons, never a
-- pattern: catalog serves EXACT / PREFIX / CONTAINS precisely so the same rule
-- means the same thing in every gateway, whatever its regex dialect.
local function mapping_matches(path, rule)
    local value = rule.value
    if not value or value == "" or not path then return false end
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

local function metric_from_cached_mappings(path)
    local dict = ngx.shared[BUFFER_DICT]
    if not dict then return nil end
    local raw = dict:get(MAPPINGS_KEY)
    if not raw then return nil end
    local ok, rules = pcall(cjson.decode, raw)
    if not ok or type(rules) ~= "table" then return nil end
    -- Catalog returns them already ordered; first match wins.
    for _, rule in ipairs(rules) do
        if mapping_matches(path, rule) then
            return rule.metricName
        end
    end
    return nil
end

-- The legacy default. Kept as a sentinel so we can tell "operator left it
-- alone" from "operator deliberately chose a template".
local DEFAULT_METRIC_PATTERN = "{method} {path}"

-- Resolve the metric this request should be billed against.
--
-- 2026-09-02. The old behaviour was `{method} {path}`, which produces a metric
-- name per endpoint: "GET /api/products", "POST /api/sms/v2/send". Aforo rejects
-- any metric that is not registered in the catalog, so out of the box every
-- event failed. Registering one metric per endpoint is not a workaround -- it
-- makes the catalog track URL structure instead of business meaning, puts a
-- line item per endpoint on the invoice, and turns adding an endpoint into a
-- billing change.
--
-- Billing wants business metrics -- sms_sent, otp_delivered, call_minutes --
-- and many endpoints map onto one of those. Aforo cannot do that mapping
-- server-side: metric filters narrow which events count toward a metric the
-- event has ALREADY named, so the name has to be right when it arrives.
--
-- Resolution order, first match wins:
--   1. upstream response header (conf.metric_header) -- per-request, for cases
--      only the backend knows, e.g. which metric a multi-purpose endpoint served
--   2. central mappings fetched from Aforo (conf.mappings_url) -- the scalable
--      answer: declared on the metric, no gateway deploy per metric
--   3. metric_mappings -- local config rules; also the fallback when catalog is
--      unreachable and nothing is cached yet
--   4. metric_name_pattern -- only when explicitly set, for backward compat
--   5. default_metric -- a single registered fallback, so an unmapped endpoint
--      still bills as generic usage rather than being rejected
local function resolve_metric_name(conf, method, path, service_name, route_name,
                                   consumer_name, header_metric)
    -- 1. Upstream override. This reads the RESPONSE header, which the upstream
    -- sets and the client cannot -- so it is not a spoofable input the way a
    -- request header would be.
    if header_metric and header_metric ~= "" then
        return header_metric
    end

    -- 2. Central mappings from Aforo, when configured. Above local config so the
    -- customer's own catalog wins; below the header so a backend can still speak
    -- for a single request. Falls through when the cache is empty or has no rule
    -- for this path, so an unreachable catalog degrades to local config rather
    -- than to nothing.
    local central = metric_from_cached_mappings(path)
    if central and central ~= "" then
        return central
    end

    -- 3. Local config mappings. Lua patterns, not globs: "^/api/sms" anchors,
    -- and ordering is the operator's tie-breaker, so put specific before general.
    if conf.metric_mappings then
        for _, rule in ipairs(conf.metric_mappings) do
            local method_ok = (rule.method == nil or rule.method == ""
                               or string.upper(rule.method) == string.upper(method or ""))
            if method_ok and rule.path_pattern and rule.path_pattern ~= "" then
                local ok, matched = pcall(string.find, path or "", rule.path_pattern)
                if not ok then
                    -- A malformed pattern must not take metering down for every
                    -- request; skip the rule and say which one is broken.
                    kong.log.err("[aforo-metering] Invalid path_pattern '", tostring(rule.path_pattern),
                        "' in metric_mappings -- rule skipped.")
                elseif matched then
                    return rule.metric_name
                end
            end
        end
    end

    -- 4. Legacy template, honoured only if the operator actually chose one.
    local pattern = conf.metric_name_pattern
    if pattern and pattern ~= "" and pattern ~= DEFAULT_METRIC_PATTERN then
        local result = pattern
        result = string.gsub(result, "{method}", method or "UNKNOWN")
        result = string.gsub(result, "{path}", path or "/")
        result = string.gsub(result, "{service}", service_name or "")
        result = string.gsub(result, "{route}", route_name or "")
        result = string.gsub(result, "{consumer}", consumer_name or "")
        return result
    end

    -- 5. Fallback.
    return conf.default_metric or "api_calls"
end

-- Resolve the quantity to bill.
--
-- header_quantity comes from the upstream RESPONSE (conf.quantity_header) and
-- wins when present. Without it, usage-based metrics whose value only the
-- backend knows -- call_minutes, tokens consumed, bytes processed -- cannot be
-- metered at the gateway at all: Kong can count that a call happened, not how
-- long it lasted. Rejected unless it parses to a positive number, because the
-- ingestor requires quantity > 0 and a malformed header would fail the whole
-- batch rather than this one event.
local function resolve_quantity(conf, response_size, header_quantity)
    if header_quantity and header_quantity ~= "" then
        local n = tonumber(header_quantity)
        if n and n > 0 then
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

-- resolve_customer_id
--
-- Priority order (post-2026-04-23 IDOR fix):
--   1. JWT customer_id claim (cryptographically verified in access phase
--      and stashed in kong.ctx.shared.aforo_jwt_claims)
--   2. Kong consumer identity (bound to the verified credential)
--
-- Returns nil if neither source is present. The caller decides whether
-- to drop the metering event, skip the margin-guard check, etc.
--
-- IMPORTANT: the `headers` argument is kept for call-site backwards
-- compatibility but is NEVER consulted. Client-settable request headers
-- (X-Customer-Id, ?customer_id=) are no longer trusted sources.
local function resolve_customer_id(conf, consumer, headers)  -- luacheck: ignore 212
    local jwt_claims = kong.ctx.shared and kong.ctx.shared.aforo_jwt_claims
    if jwt_claims and jwt_claims.customer_id and jwt_claims.customer_id ~= "" then
        return jwt_claims.customer_id
    end
    if consumer then
        return consumer.custom_id or consumer.username or consumer.id
    end
    return nil
end

local function generate_idempotency_key(request_id)
    return request_id or uuid()
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

local function flush_buffer(premature, conf)
    if premature then return end

    local dict = ngx.shared[BUFFER_DICT]
    if not dict then
        kong.log.err("[aforo-metering] Shared dict '", BUFFER_DICT, "' not found")
        return
    end

    local events_json = dict:get(BUFFER_KEY)
    if not events_json then return end

    local events = cjson.decode(events_json)
    if not events or #events == 0 then return end

    dict:delete(BUFFER_KEY)
    dict:set(BUFFER_COUNT_KEY, 0)

    local httpc = http.new()
    httpc:set_timeout(10000)

    local body = cjson.encode({ events = events })

    local max_retries = 3
    local last_status, last_body
    for attempt = 1, max_retries do
        local res, err = httpc:request_uri(conf.aforo_endpoint, {
            method  = "POST",
            body    = body,
            -- X-API-Key, not Authorization: Bearer (2026-09-03).
            --
            -- The ingestor authenticates keys through aforo-common's
            -- ApiKeyAuthFilter, which reads X-API-Key and nothing else. A key sent
            -- as a Bearer token is simply not seen: the request stays anonymous and
            -- /v1/ingest/batch answers 403 "You don't have permission to
            -- usage-events:ingest", which reads like a permissions problem on the
            -- key rather than a header the server never looked at.
            --
            -- Sent ALONE. Adding Authorization: Bearer alongside as a fallback was
            -- tried and is actively harmful: an API key in that header is parsed as
            -- a JWT, fails, and the request is rejected 401 before the API-key
            -- filter ever runs. Verified against production -- X-API-Key alone
            -- returns 202, the two together return 401.
            headers = {
                ["Content-Type"]  = "application/json",
                ["X-API-Key"]     = conf.api_key or "",
                ["X-Tenant-Id"]   = conf.tenant_id or "",
            },
        })

        if res and res.status >= 200 and res.status < 300 then
            kong.log.info("[aforo-metering] Flushed ", #events, " events to Aforo (status=", res.status, ")")
            return
        end

        local status = res and res.status or "no response"
        last_status = res and res.status or nil
        last_body = res and res.body or nil
        kong.log.warn("[aforo-metering] Flush attempt ", attempt, "/", max_retries,
            " failed (status=", status, ", err=", err or "none", ")")

        -- Name the fix for the one failure that is reliably misdiagnosed.
        -- OpenSSL error 20 against an https endpoint almost always means Kong's
        -- lua_ssl_verify_depth (default 1) is too shallow for the chain, NOT a
        -- missing CA bundle -- so operators go install certificates that are
        -- already there. Only logged on the final attempt to avoid noise.
        if attempt == max_retries and err and string.find(err, "unable to get local issuer certificate", 1, true) then
            kong.log.err("[aforo-metering] TLS verification failed for ", conf.aforo_endpoint, ". ",
                "This is usually lua_ssl_verify_depth, which Kong defaults to 1 -- too shallow for a ",
                "leaf/intermediate/root chain. Set lua_ssl_verify_depth = 3 in kong.conf (or ",
                "KONG_LUA_SSL_VERIFY_DEPTH=3). Adding CA certificates will not help: Kong already ",
                "trusts the system bundle via lua_ssl_trusted_certificate.")
        end

        if attempt < max_retries then
            ngx.sleep(math.pow(2, attempt - 1))
        end
    end

    -- Drop on a permanent rejection; only retry what retrying can fix
    -- (2026-09-03 fix).
    --
    -- Re-buffering EVERY failure, added 2026-09-01, created a poison pill. The
    -- ingestor validates the batch as a whole: one event the server considers
    -- malformed fails the request with 400, so the whole batch came back and was
    -- re-buffered -- including every well-formed event in it. The bad event was
    -- then retried forever, failing the batch every time and dragging good
    -- events down with it. Metering stops permanently and the log only says
    -- "flush attempts failed", which reads like the ingestor being unwell rather
    -- than one unacceptable event stuck at the head of the queue.
    --
    -- 4xx means the server understood us and refused; retrying sends the same
    -- bytes to the same judgement. 408 and 429 are the exceptions -- both
    -- explicitly invite a retry. Anything else (5xx, timeout, connection
    -- refused) is transient and worth keeping, which is what the original fix
    -- was for.
    local permanent = last_status and last_status >= 400 and last_status < 500
        and last_status ~= 408 and last_status ~= 429
    if permanent then
        kong.log.err("[aforo-metering] Ingestor rejected the batch with ", last_status,
            " -- dropping ", #events, " event(s) rather than retrying them forever. ",
            "Response: ", string.sub(tostring(last_body or ""), 1, 500))
        return
    end

    -- Re-buffer transient failures (2026-09-01 fix).
    -- The buffer is cleared before the first attempt, so an ingestor outage
    -- outlasting 3 retries used to destroy the only copy of these events:
    -- unbilled usage, no dead-letter, nothing to reconstruct from. Push them
    -- back so a later flush retries them.
    --
    -- Ordering: failed events are older than anything buffered during the
    -- attempt, so they go in front. On overflow we keep the OLDEST and drop the
    -- newest, because the oldest are the ones closest to falling outside the
    -- ingestor's 90-day occurredAt acceptance window -- and losing recent events
    -- is recoverable from upstream logs far more often than losing old ones.
    local pending_json = dict:get(BUFFER_KEY)
    if pending_json then
        local pending = cjson.decode(pending_json)
        if pending then
            for i = 1, #pending do
                events[#events + 1] = pending[i]
            end
        end
    end

    local dropped = 0
    if #events > MAX_BUFFER_SIZE then
        dropped = #events - MAX_BUFFER_SIZE
        local trimmed = {}
        for i = 1, MAX_BUFFER_SIZE do
            trimmed[i] = events[i]
        end
        events = trimmed
    end

    dict:set(BUFFER_KEY, cjson.encode(events))
    dict:set(BUFFER_COUNT_KEY, #events)

    if dropped > 0 then
        kong.log.err("[aforo-metering] All ", max_retries, " flush attempts failed. ",
            #events, " events re-buffered for retry; ", dropped,
            " dropped (buffer at MAX_BUFFER_SIZE=", MAX_BUFFER_SIZE,
            "). Raise lua_shared_dict aforo_buffer if this recurs.")
    else
        kong.log.err("[aforo-metering] All ", max_retries, " flush attempts failed. ",
            #events, " events re-buffered for retry on the next flush.")
    end
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
-- Currently a no-op that stashes trace context for correlation.
-- Session 5 will add rate-limit enforcement here.
-- ────────────────────────────────────────────────────────────

function AforoMeteringHandler:access(conf)
    kong.ctx.shared.aforo_trace = extract_trace_context()

    -- Only ever schedules a background refresh; never waits on one.
    maybe_refresh_mappings(conf)

    -- Stash the request body for the log phase (2026-09-01 fix).
    -- kong.request.get_raw_body() is access/rewrite-phase only. Calling it from
    -- log_by_lua raises "function cannot be called in log phase", which aborted
    -- the ENTIRE log handler on every request -- so no event was ever buffered
    -- and the plugin metered precisely nothing on Kong 3.x. The failure was
    -- invisible from the plugin's own logs: Kong reports it as a generic
    -- "failed to run log_by_lua*" and the handler never reaches its own
    -- logging. Mirrors the aforo_trace stash directly above.
    --
    -- Only read when MCP detection needs it: touching the raw body forces Kong
    -- to buffer the whole request, which is real overhead on large uploads and
    -- pointless when nothing consumes it. pcall-guarded because the body is
    -- legitimately unavailable for streamed or oversized requests.
    if conf.mcp_enabled then
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

    -- Margin guard pre-flight check (calls pricing-service quick-check, returns 429 on L2/L3).
    -- resolve_customer_id() prefers the JWT-validated claim stashed above;
    -- falls back to Kong consumer identity (credential-bound). Never reads
    -- request headers or query params — those sources were removed 2026-04-23.
    local customer_id = resolve_customer_id(conf, kong.client.get_consumer())
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

    -- Never meter a CORS preflight (2026-09-03).
    --
    -- A preflight is a browser protocol detail, not a billable API call, and it
    -- carries no Authorization header by definition -- so it has no customer and
    -- never can. Worse, Kong's cors plugin answers it in the access phase and
    -- short-circuits the chain, so this plugin's access handler never runs and no
    -- JWT claims are stashed; only the log phase fires. The result was an event
    -- with an empty customerId, which the ingestor rejects, failing the whole
    -- batch it travelled in and taking every valid event with it.
    if method == "OPTIONS" and kong.request.get_header("Access-Control-Request-Method") then
        return
    end

    local consumer = kong.client.get_consumer()
    local headers = kong.request.get_headers()
    local service = kong.router.get_service()
    local route = kong.router.get_route()
    local latency = kong.response.get_header("X-Kong-Proxy-Latency")
    -- Read the access-phase stash; never call get_raw_body() here (see above).
    local raw_body = kong.ctx.shared.aforo_raw_body
    -- Content-Length when the body was not captured, so request_size stays
    -- populated for the common non-MCP path instead of reporting a flat 0.
    local request_size = raw_body and #raw_body
        or tonumber(kong.request.get_header("Content-Length")) or 0
    local response_size = tonumber(kong.response.get_header("Content-Length")) or 0
    local request_id = kong.request.get_header("X-Request-Id")
        or kong.request.get_header("X-Kong-Request-Id")
    local session_id = kong.request.get_header("Mcp-Session-Id")

    local service_name = service and service.name or ""
    local route_name = route and route.name or ""
    local consumer_name = consumer and (consumer.username or consumer.custom_id) or ""
    local customer_id = resolve_customer_id(conf, consumer, headers)

    -- W3C trace context (prefer access-phase stash, fallback to re-extraction)
    local trace = kong.ctx.shared.aforo_trace or extract_trace_context()

    -- MCP Detection
    local mcp_info = nil
    if conf.mcp_enabled and method == "POST" then
        mcp_info = detect_mcp_tool_call(raw_body)
    end

    -- Build usage event
    local event = {}

    if mcp_info then
        event.customerId     = customer_id
        event.metricName     = "mcp_server.tool_invocations"
        event.quantity       = 1
        event.idempotencyKey = "mcp:" .. (conf.tenant_id or "") .. ":" ..
                               (request_id or uuid()) .. ":" ..
                               mcp_info.tool_name .. ":" .. tostring(ngx.now())
        event.occurredAt     = iso8601_utc(ngx.now())
        event.productType    = "MCP_SERVER"
        event.toolName       = mcp_info.tool_name
        event.agentId        = mcp_info.agent_id or headers["x-agent-id"]
        event.sessionId      = session_id
        event.executionStatus = (status >= 200 and status < 300) and "SUCCESS" or "ERROR"
        event.executionDurationMs = tonumber(latency) or 0
    else
        event.customerId     = customer_id
        -- Upstream-supplied overrides, read from the response so a client
        -- cannot forge them.
        local header_metric = conf.metric_header and conf.metric_header ~= ""
            and kong.response.get_header(conf.metric_header) or nil
        local header_quantity = conf.quantity_header and conf.quantity_header ~= ""
            and kong.response.get_header(conf.quantity_header) or nil

        event.metricName     = resolve_metric_name(conf, method, path, service_name,
                                                   route_name, consumer_name, header_metric)
        event.quantity       = resolve_quantity(conf, response_size, header_quantity)
        event.idempotencyKey = generate_idempotency_key(request_id)
        event.occurredAt     = iso8601_utc(ngx.now())
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

    -- Billing-hierarchy identity (2026-09-01 fix).
    -- usage-ingestor's BillingHierarchyEnricher resolves team / member /
    -- subscription for an event from an identity carried in metadata. Until now
    -- this plugin emitted none, so every gateway-metered event reached the
    -- ingestor unattributed: teamId stayed null, and because budget enforcement
    -- is gated on a non-null teamId, team budgets were silently never enforced
    -- for gateway traffic.
    --
    -- key_id is the JWT's Aforo API-key id (UUID). It is deliberately NOT the
    -- same value as keyHash (SHA-256 hex of the raw key) which the enricher's
    -- older :apikey: index is built on -- the gateway never sees the raw key, so
    -- it cannot compute that hash. The ingestor therefore maintains a parallel
    -- :keyid: index; see BillingHierarchySyncJob.
    --
    -- Set outside the include_metadata block on purpose: include_metadata=false
    -- turns off *diagnostic* metadata, and must not silently disable billing
    -- attribution.
    local jwt_claims = kong.ctx.shared and kong.ctx.shared.aforo_jwt_claims
    if jwt_claims and jwt_claims.key_id and jwt_claims.key_id ~= "" then
        event.metadata = event.metadata or {}
        event.metadata.keyId = jwt_claims.key_id
    end

    -- Refuse to buffer an event that can never be accepted (2026-09-03).
    --
    -- customerId is what usage attributes to; the ingestor rejects a blank one.
    -- Because it validates a batch as a whole, a single such event fails the
    -- request and every well-formed event batched with it is rejected too. Since
    -- nothing downstream can supply the missing value later, buffering it only
    -- damages the events around it -- so it is dropped here, at the one point
    -- where the loss is limited to the event actually at fault.
    if not event.customerId or event.customerId == "" then
        kong.log.warn("[aforo-metering] Skipping ", method, " ", path,
            " -- no customer identity resolved. With jwt_validation_enabled the ",
            "customer_id claim supplies this; otherwise set customer_id_source to a ",
            "Kong consumer. Event not metered.")
        return
    end

    -- Buffer the event
    local dict = ngx.shared[BUFFER_DICT]
    if not dict then
        kong.log.err("[aforo-metering] Shared dict '", BUFFER_DICT, "' not available. ",
            "Add 'lua_shared_dict aforo_buffer 10m;' to kong.conf")
        return
    end

    local count = dict:incr(BUFFER_COUNT_KEY, 1, 0)

    if count > MAX_BUFFER_SIZE then
        kong.log.warn("[aforo-metering] Buffer overflow (", count, "/", MAX_BUFFER_SIZE,
            "). Dropping oldest event.")
        dict:incr(BUFFER_COUNT_KEY, -1)
        return
    end

    local events_json = dict:get(BUFFER_KEY)
    local events = events_json and cjson.decode(events_json) or {}
    table.insert(events, event)
    dict:set(BUFFER_KEY, cjson.encode(events))

    if count >= (conf.flush_count or 50) then
        local ok, err = ngx.timer.at(0, flush_buffer, conf)
        if not ok then
            kong.log.warn("[aforo-metering] Failed to schedule immediate flush: ", err)
        end
    elseif count == 1 then
        local interval = (conf.flush_interval_ms or 5000) / 1000
        local ok, err = ngx.timer.at(interval, flush_buffer, conf)
        if not ok then
            kong.log.warn("[aforo-metering] Failed to schedule timed flush: ", err)
        end
    end
end

-- Exported for unit testing — not used by the Kong runtime.
-- Keep the top-level handler contract (access/log) unchanged.
AforoMeteringHandler._resolve_customer_id = resolve_customer_id

return AforoMeteringHandler
