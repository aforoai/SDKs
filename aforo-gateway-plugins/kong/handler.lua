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
local preflight_quota = require_sibling("preflight-quota")
local redis_util = require_sibling("redis-util")
local unpack = unpack or table.unpack  -- luacheck: ignore 143

-- uuid() and iso8601_utc() live in event-util.lua; see there for why each is
-- the way it is.
local event_util = require_sibling("event-util")
local event_buffer = require_sibling("event-buffer")
local uuid = event_util.uuid
local iso8601_utc = event_util.iso8601_utc
local record_drop = event_util.record_drop


-- ────────────────────────────────────────────────────────────
-- JWT Validation helpers
-- ────────────────────────────────────────────────────────────

-- Extract Bearer token from Authorization header. The scheme is matched
-- case-insensitively (RFC 7235): "bearer" is as valid as "Bearer".
local function extract_bearer_token()
    local auth_header = kong.request.get_header("Authorization")
    if type(auth_header) ~= "string" then return nil end
    local _, _, token = string.find(auth_header, "^[Bb][Ee][Aa][Rr][Ee][Rr]%s+(.+)$")
    return token
end

-- Decode base64url to bytes
local function base64url_decode(str)
    str = str:gsub("-", "+"):gsub("_", "/")
    local pad = 4 - (#str % 4)
    if pad < 4 then str = str .. string.rep("=", pad) end
    return ngx.decode_base64(str)
end

-- v when it is a non-empty string, else nil. A type check rather than a
-- truthiness one, so a null config value can never reach an event as a JSON
-- null that the required-field check would wave through.
local function non_empty_string(v)
    if type(v) == "string" and v ~= "" then
        return v
    end
    return nil
end

-- A claim as a non-empty string, or nil. Claims come from a token the caller
-- built, and before the signature is checked that caller may be anyone, so
-- nothing about their types can be assumed: a JSON null decodes to the
-- cjson.null userdata, which is truthy, compares unequal to everything, and
-- raises when concatenated or sent as a header -- a 500 on demand.
local function claim_string(v)
    if type(v) == "string" and v ~= "" then return v end
    if type(v) == "number" then return tostring(v) end
    return nil
end

-- Parse a JWT without crypto verification.
-- Returns (claims, header) on success, or (nil, err_string) on failure.
local function parse_jwt(token)
    local parts = {}
    for part in token:gmatch("([^.]+)") do
        table.insert(parts, part)
    end
    if #parts ~= 3 then return nil, "invalid_jwt_format" end

    local payload_json = base64url_decode(parts[2])
    if not payload_json then return nil, "invalid_jwt_encoding" end

    local ok, claims = pcall(cjson.decode, payload_json)
    if not ok or type(claims) ~= "table" then return nil, "invalid_jwt_payload" end

    -- The header only matters for its kid (JWKS key selection); a missing or
    -- unreadable header is not an error here -- the signature check decides.
    local header = {}
    local header_json = base64url_decode(parts[1])
    if header_json then
        local hok, h = pcall(cjson.decode, header_json)
        if hok and type(h) == "table" then header = h end
    end

    return claims, header
end

-- Warning throttles, revocation counters and the metric mappings live in the
-- aforo_cache dict (event_util.cache_dict(): aforo_cache, else aforo_buffer
-- with one error per worker). Events stay in aforo_buffer (event-buffer.lua).
-- 2.8.0, G323: they used to share aforo_buffer with the events.

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
    local dict = event_util.cache_dict()
    if not dict then
        kong.log.warn(...)
        return
    end
    if dict:safe_add("aforo:warn:" .. key, 1, ttl or 60) then
        kong.log.warn(...)
    end
end

-- ────────────────────────────────────────────────────────────
-- Revocation checks (jti blocklist + client revocation) in Redis
-- ────────────────────────────────────────────────────────────
--
-- Revocation lists, as org-service's JtiBlocklistService writes them:
--   jti:blocked:{jti}          one token                   (value "1")
--   jti:client:{client_id}     every token for that client (value "revoked")
-- jti:client:{key_id} is checked too, as a secondary key.
--
-- Only a real string value means revoked (Gowtham, 2026-10-12).
-- lua-resty-redis answers a Redis ERROR reply -- NOAUTH on a password-protected
-- Redis, LOADING while it restores, MOVED in a cluster -- with false, and that
-- used to read as "revoked": every token refused, with nothing in the log.
-- AUTH is sent with jwt_redis_password (else rate_limit_redis_password on the
-- same Redis), and one connection serves all the lookups of a request.
--
-- When Redis cannot answer -- connect, AUTH, a GET error or an error reply --
-- the check is UNAVAILABLE, which proves nothing either way. What happens then
-- is jti_redis_fail_mode (w2-2-kong-jti-fail-open, 2.4.0):
--   closed (default): refuse with 503. A revoked token or API key must not
--     keep working while Redis is down -- exactly the window an attacker
--     holding a stolen token would wait for. organization-service answers 503
--     for the same check.
--   open: let it through, log (throttled) and count it.
--
-- Counted in two places:
--   1. shared dict "aforo_revocation_unavailable:<check>:<outcome>" (aforo_cache)
--   2. Prometheus aforo_metering_revocation_check_unavailable_total{check,outcome}
--      when Kong's prometheus plugin is loaded. Every touch is pcall-guarded.
-- check = "jti" | "client", outcome = "closed" (refused) | "open" (let through).

local REVOCATION_UNAVAILABLE_PREFIX = "aforo_revocation_unavailable:"
local prometheus_revocation_counter  -- nil = not yet resolved; false = unavailable

local function get_prometheus_revocation_counter()
    if prometheus_revocation_counter ~= nil then
        return prometheus_revocation_counter or nil
    end
    local ok, exporter = pcall(require, "kong.plugins.prometheus.exporter")
    if ok and type(exporter) == "table" and type(exporter.get_prometheus) == "function" then
        local got, prom = pcall(exporter.get_prometheus)
        if got and prom and type(prom.counter) == "function" then
            local reg, counter = pcall(prom.counter, prom,
                "aforo_metering_revocation_check_unavailable_total",
                "Token revocation checks that could not reach Redis, by check and outcome",
                { "check", "outcome" })
            if reg and counter then
                prometheus_revocation_counter = counter
                return counter
            end
        end
    end
    prometheus_revocation_counter = false
    return nil
end

local function record_revocation_unavailable(check, outcome)
    local dict = event_util.cache_dict()
    if dict then
        dict:incr(REVOCATION_UNAVAILABLE_PREFIX .. check .. ":" .. outcome, 1, 0)
    end
    local counter = get_prometheus_revocation_counter()
    if counter then
        pcall(counter.inc, counter, 1, { check, outcome })
    end
end

-- Redis could not answer the `check` lookup. Returns nil when the request may
-- proceed (fail mode open), else "REVOCATION_CHECK_UNAVAILABLE".
local function revocation_unavailable_one(conf, check, host, port, why)
    local what = check == "jti" and "revoked tokens" or "revoked API keys"
    if conf.jti_redis_fail_mode == "open" then
        record_revocation_unavailable(check, "open")
        warn_throttled("redis_" .. check .. "_open", 60,
            "[aforo-metering] Redis could not answer the ", check, " revocation check at ",
            host, ":", port, " (", tostring(why), "). jti_redis_fail_mode=open: Failing OPEN -- ",
            what, " are NOT being rejected. NOAUTH means jwt_redis_password is missing or ",
            "wrong. Repeats suppressed for 60s.")
        return nil
    end
    record_revocation_unavailable(check, "closed")
    warn_throttled("redis_" .. check .. "_closed", 60,
        "[aforo-metering] Redis could not answer the ", check, " revocation check at ",
        host, ":", port, " (", tostring(why), "). Refusing requests with 503 ",
        "(jti_redis_fail_mode=closed). Check jwt_redis_host / jwt_redis_port / ",
        "jwt_redis_password, or set jti_redis_fail_mode=open to let them through. ",
        "Repeats suppressed for 60s.")
    return "REVOCATION_CHECK_UNAVAILABLE"
end

-- Every check from lookups[first] on could not run (one connection serves
-- them all): each distinct check is logged and counted once.
local function revocation_unavailable(conf, lookups, first, host, port, why)
    local result, seen = nil, {}
    for i = first, #lookups do
        local check = lookups[i][3]
        if not seen[check] then
            seen[check] = true
            result = revocation_unavailable_one(conf, check, host, port, why) or result
        end
    end
    return result
end

-- Returns "TOKEN_REVOKED", "CLIENT_REVOKED", "REVOCATION_CHECK_UNAVAILABLE"
-- (Redis could not answer and the mode is closed) or nil.
local function revocation_reason(conf, claims)
    local lookups = {}
    if claims.jti then
        lookups[#lookups + 1] = { "jti:blocked:" .. claims.jti, "TOKEN_REVOKED", "jti" }
    end
    if claims.client_id then
        lookups[#lookups + 1] = { "jti:client:" .. claims.client_id, "CLIENT_REVOKED", "client" }
    end
    if claims.key_id and claims.key_id ~= claims.client_id then
        lookups[#lookups + 1] = { "jti:client:" .. claims.key_id, "CLIENT_REVOKED", "client" }
    end
    if #lookups == 0 then return nil end

    -- Prefer dedicated jwt_redis_* config; fall back to rate_limit_redis_*.
    -- The password and the TLS settings go with the server: the rate-limit
    -- ones are only borrowed when the blocklist lives on the rate-limit
    -- Redis, so a different blocklist Redis is not sent a password it would
    -- refuse.
    local rl_host = conf.rate_limit_redis_host or "127.0.0.1"
    local rl_port = conf.rate_limit_redis_port or 6379
    local host = non_empty_string(conf.jwt_redis_host) or rl_host
    local port = conf.jwt_redis_port or rl_port
    local same_server = (host == rl_host and port == rl_port)
    local password = non_empty_string(conf.jwt_redis_password)
    if not password and same_server then
        password = non_empty_string(conf.rate_limit_redis_password)
    end
    -- jwt_redis_ssl has no default: unset means "as the rate-limit Redis"
    -- on the same server, else plain.
    local ssl = conf.jwt_redis_ssl
    local ssl_verify = conf.jwt_redis_ssl_verify
    local server_name = non_empty_string(conf.jwt_redis_server_name)
    if ssl == nil or ssl == ngx.null then
        ssl = same_server and conf.rate_limit_redis_ssl == true
        if same_server and ssl then
            if ssl_verify == nil or ssl_verify == ngx.null then
                ssl_verify = conf.rate_limit_redis_ssl_verify
            end
            server_name = server_name or non_empty_string(conf.rate_limit_redis_server_name)
        end
    end

    -- One connection, one round trip (2.8.0, G327): AUTH only on a new
    -- connection (redis-util), then one GET per key, pipelined. Before 2.8.0
    -- each key was its own GET with a 500 ms timeout and AUTH was sent on
    -- every request, so a slow Redis cost up to 2 s per request.
    --
    -- Not MGET: organization-service writes jti:blocked:<jti> and
    -- jti:client:<id> without a common hash tag, so on Redis Cluster and
    -- ElastiCache Serverless the keys land in different slots and an MGET is
    -- refused with CROSSSLOT -- which, failing closed, answered every JWT
    -- request 503. Pipelined single-key GETs are still one round trip and
    -- each is routed by itself on a proxy that routes per key. A classic
    -- cluster node answers a key it does not own with MOVED; that error
    -- reply is "Redis could not answer" (jti_redis_fail_mode), never
    -- "not revoked".
    local red, err = redis_util.connect({
        host = host, port = port, password = password,
        timeout_ms = conf.jwt_redis_timeout_ms or 250,
        ssl = ssl == true, ssl_verify = ssl_verify, server_name = server_name,
    })
    if not red then
        return revocation_unavailable(conf, lookups, 1, host, port, tostring(err))
    end

    red:init_pipeline(#lookups)
    for _, lookup in ipairs(lookups) do
        red:get(lookup[1])
    end
    local values, perr = red:commit_pipeline()
    if type(values) ~= "table" then
        -- A broken connection or a timeout: no evidence either way. Do not
        -- put a connection in an unknown state back into the pool.
        redis_util.discard(red)
        return revocation_unavailable(conf, lookups, 1, host, port,
            "get: " .. tostring(perr or "no reply"))
    end
    -- A value is proof of revocation whatever the other keys answered. A key
    -- that could not be read (an error reply such as { false, "MOVED ..." },
    -- a missing answer, anything GET does not return) matters only when no
    -- key holds a value: then that check could not run. The connection read
    -- every reply, so it goes back to the pool either way.
    local unreadable = {}
    for i, lookup in ipairs(lookups) do
        local val = values[i]
        if type(val) == "string" then
            redis_util.release(red)
            return lookup[2]
        end
        if val ~= ngx.null then
            local why = "unexpected reply"
            if type(val) == "table" and val[1] == false then
                why = tostring(val[2])
            elseif val == nil then
                why = "no reply"
            end
            unreadable[#unreadable + 1] = { lookup = lookup, why = why }
        end
    end
    redis_util.release(red)
    if #unreadable > 0 then
        local failed = {}
        for i, u in ipairs(unreadable) do failed[i] = u.lookup end
        return revocation_unavailable(conf, failed, 1, host, port,
            "get " .. unreadable[1].lookup[1] .. ": " .. unreadable[1].why)
    end
    return nil
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
--   2. header alg == "RS256" exactly. The verifier always runs RSA-SHA256
--      against the configured key, so an alg=none / HS256 token can never
--      verify; the explicit check makes that a named rejection.
--   3. RS256 signature against the issuer's key: from conf.jwt_jwks_uri by
--      the token's kid, else conf.jwt_public_key (PEM, public key only)
--   4. exp (required, numeric) and nbf (when present), with
--      JWT_CLOCK_SKEW_SECONDS of leeway
--   5. iss (required unless jwt_issuer_check_disabled), aud when conf.jwt_audience is set
--   6. tenant_id equals conf.tenant_id (Gowtham, 2026-10-12): org-service signs
--      every tenant's tokens with one key, so a valid signature alone does not
--      say which tenant the token is for
--   7. jti / client_id / key_id revocation (Redis), see above
--
-- Every claim is normalised first (claim_string): before the signature is
-- checked the caller chooses their types, and a JSON null is a truthy userdata
-- that raises when concatenated -- a 500 on demand.
--
-- Keys: with jwt_jwks_uri set, the issuer's JWKS is fetched over https in the
-- access phase and cached per worker for jwt_jwks_cache_ttl seconds (default
-- 600). A token whose kid is not in the cached set triggers a refresh, at most
-- once per JWKS_MIN_REFRESH seconds, so a key rotation needs no Kong config
-- change. A token whose kid IS cached but does not verify triggers the same
-- refresh: org-service makes a new key pair on every start and keeps the kid
-- (Gowtham's case, 2026-10-13). When a refresh fails the last good set keeps
-- working for up to JWKS_MAX_STALE seconds. jwt_public_key, when also set,
-- verifies tokens the JWKS has no key for. A JWKS that cannot be fetched or
-- parsed never opens the gate, jwt_allow_unverified_signature included.
--
-- jwt_allow_unverified_signature = true keeps its meaning for ACCESS: a token
-- this plugin cannot verify is let through, for deployments that verify
-- upstream. It does not supply IDENTITY: the claims of a token nothing on this
-- gateway verified are not used for customerId or keyId (resolve_customer_id).
-- If Kong's own `jwt` plugin verified the same token on this request, it
-- counts as verified.
local MAX_JWT_LENGTH = 8192
local JWT_CLOCK_SKEW_SECONDS = 60

-- Parsed public keys, per worker. Parsing a PEM on every request is wasted
-- work; the key object is immutable. Bounded: reset past a handful.
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

-- ── JWKS (jwt_jwks_uri) ─────────────────────────────────────────
local JWKS_DEFAULT_TTL = 600
local JWKS_MIN_REFRESH = 30
-- A worker that has never fetched the set retries sooner, so a failed first fetch
-- (Kong reload, issuer briefly down) costs seconds of 401s, not half a minute.
local JWKS_MIN_REFRESH_COLD = 5
-- Requests that arrive while this worker's first fetch is in flight wait for it.
local JWKS_WAIT_STEP = 0.05
local JWKS_MAX_STALE = 86400
local JWKS_MAX_BYTES = 262144
local JWKS_TIMEOUT_MS = 3000
-- Whole fetch (connect, TLS, request, every body chunk) must finish inside this.
-- Requests waiting on a worker's first fetch wait this long; a fetch flagged in
-- flight for longer than this (its coroutine was aborted) no longer blocks refreshes.
local JWKS_FETCH_BUDGET = 8
local jwks_cache = {}   -- uri -> { keys = {kid -> pkey}, single = pkey|nil, fetched_at, expires_at, last_attempt }

-- RSA signing keys of a JWKS body, by kid. Keys that are not RSA, not for
-- signing, not RS256, have no kid, or carry private parts are skipped.
local function parse_jwks(body)
    local ok, doc = pcall(cjson.decode, body)
    if not ok or type(doc) ~= "table" or type(doc.keys) ~= "table" then
        return nil, "not a JWKS document"
    end
    local okp, pkey = pcall(require, "resty.openssl.pkey")
    if not okp then return nil, "resty.openssl unavailable: " .. tostring(pkey) end
    local keys, count, only = {}, 0, nil
    for _, k in ipairs(doc.keys) do
        if type(k) == "table" and k.kty == "RSA" and type(k.kid) == "string" and k.kid ~= ""
                and (k.use == nil or k.use == cjson.null or k.use == "sig")
                and (k.alg == nil or k.alg == cjson.null or k.alg == "RS256")
                and type(k.n) == "string" and type(k.e) == "string"
                and (k.d == nil or k.d == cjson.null) then
            local pk = pkey.new(cjson.encode({ kty = "RSA", n = k.n, e = k.e }), { format = "JWK" })
            if pk then
                keys[k.kid] = pk
                count = count + 1
                only = pk
            end
        end
    end
    if count == 0 then return nil, "JWKS has no usable RS256 key" end
    return keys, nil, count == 1 and only or nil
end

local function fetch_jwks(uri)
    if type(uri) ~= "string" or not uri:match("^https://") then
        return nil, "jwt_jwks_uri must be an https URL"
    end
    local started = ngx.now()
    local httpc = http.new()
    httpc:set_timeout(JWKS_TIMEOUT_MS)
    local parsed, uerr = httpc:parse_uri(uri, false)
    if not parsed then return nil, "jwt_jwks_uri could not be parsed: " .. tostring(uerr) end
    local host, port, path, query = parsed[2], parsed[3], parsed[4], parsed[5]
    local okc, cerr = httpc:connect({
        scheme = "https", host = host, port = port, ssl_verify = true, ssl_server_name = host,
    })
    if not okc then return nil, "JWKS fetch failed: " .. tostring(cerr) end
    -- The body is read in chunks and abandoned past JWKS_MAX_BYTES, so an oversized
    -- (or endless) response never sits in worker memory; request_uri would read it all.
    local res, err = httpc:request({
        method = "GET",
        path = (query and query ~= "") and (path .. "?" .. query) or path,
        headers = {
            ["Host"] = (port == 443 or port == nil) and host or (host .. ":" .. port),
            ["Accept"] = "application/json",
        },
    })
    if not res then httpc:close() return nil, "JWKS fetch failed: " .. tostring(err) end
    if res.status ~= 200 then httpc:close() return nil, "JWKS fetch answered " .. tostring(res.status) end
    local too_big = "JWKS body larger than " .. JWKS_MAX_BYTES .. " bytes"
    local declared = res.headers and tonumber(res.headers["Content-Length"])
    if declared and declared > JWKS_MAX_BYTES then httpc:close() return nil, too_big end
    if type(res.body_reader) ~= "function" then httpc:close() return nil, "JWKS body missing" end
    local parts, size = {}, 0
    while true do
        local chunk, berr = res.body_reader(8192)
        if berr then httpc:close() return nil, "JWKS body read failed: " .. tostring(berr) end
        if not chunk then break end
        if ngx.now() - started > JWKS_FETCH_BUDGET then
            httpc:close() return nil, "JWKS fetch took longer than " .. JWKS_FETCH_BUDGET .. " s"
        end
        size = size + #chunk
        if size > JWKS_MAX_BYTES then httpc:close() return nil, too_big end
        parts[#parts + 1] = chunk
    end
    httpc:close()
    local keys, perr, single = parse_jwks(table.concat(parts))
    if not keys then return nil, perr end
    return keys, nil, single
end

-- The JWKS key for kid (or the only key when the token names none), or nil.
-- force = true refreshes the set even when kid is cached (subject to the same
-- JWKS_MIN_REFRESH limit), for a cached key that did not verify.
local function jwks_key(conf, kid, force)
    local uri = conf.jwt_jwks_uri
    local now = ngx.now()
    local ttl = tonumber(conf.jwt_jwks_cache_ttl) or JWKS_DEFAULT_TTL
    local entry = jwks_cache[uri]
    local missing = force or not entry or now >= entry.expires_at
        or (kid ~= nil and entry.keys[kid] == nil)
    local function in_flight(e, at)
        return e ~= nil and e.fetching == true and at - (e.fetch_started or 0) < JWKS_FETCH_BUDGET + 1
    end
    -- Another request in this worker is fetching the first set: wait for it (yields).
    if in_flight(entry, now) and entry.fetched_at == 0 and ngx.sleep then
        local waited = 0
        while in_flight(entry, ngx.now()) and waited < JWKS_FETCH_BUDGET + 1 do
            ngx.sleep(JWKS_WAIT_STEP)
            waited = waited + JWKS_WAIT_STEP
            entry = jwks_cache[uri]
        end
        now = ngx.now()
        missing = not entry or entry.fetched_at == 0 or (kid ~= nil and entry.keys[kid] == nil)
    end
    local min_refresh = (entry and entry.fetched_at > 0) and JWKS_MIN_REFRESH or JWKS_MIN_REFRESH_COLD
    if missing and (not entry or (not in_flight(entry, now) and now - entry.last_attempt >= min_refresh)) then
        -- Mark the attempt first: requests in this worker that arrive while the
        -- fetch yields use what is cached instead of fetching too.
        if entry then
            entry.last_attempt = now
        else
            entry = { keys = {}, single = nil, fetched_at = 0, expires_at = 0, last_attempt = now }
            jwks_cache[uri] = entry
        end
        entry.fetching = true
        entry.fetch_started = now
        local okf, keys, err, single = pcall(fetch_jwks, uri)
        entry.fetching = false
        if not okf then keys, err = nil, tostring(keys) end
        if keys then
            jwks_cache[uri] = { keys = keys, single = single, fetched_at = now,
                                expires_at = now + ttl, last_attempt = now }
            entry = jwks_cache[uri]
        else
            warn_throttled("jwks_fetch", 60, "[aforo-metering] ", err,
                (entry.fetched_at > 0) and " -- using the keys fetched earlier" or "")
        end
    end
    if not entry or entry.fetched_at == 0 then return nil, "no JWKS keys available" end
    if now - entry.fetched_at > JWKS_MAX_STALE then return nil, "JWKS keys too old" end
    if kid ~= nil then return entry.keys[kid], "kid not in JWKS" end
    return entry.single, "token names no kid and the JWKS has several keys"
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

local function rs256_verify(pk, signature, signing_input)
    local okv, verified, verr = pcall(pk.verify, pk, signature, signing_input, "sha256")
    if not okv or verr then
        kong.log.err("[aforo-metering] RS256 verification error: ", tostring(okv and verr or verified))
        return false
    end
    return verified == true
end

-- Returns (true, "verified") when the RS256 signature checked out,
-- (true, "unverified") when it could not be checked and the operator opted
-- out with jwt_allow_unverified_signature, or (false, reason).
local function verify_rs256_signature(token, conf, header)
    local allow_unverified = conf.jwt_allow_unverified_signature == true
    local has_static = non_empty_string(conf.jwt_public_key) ~= nil
    local has_jwks = non_empty_string(conf.jwt_jwks_uri) ~= nil

    if not has_static and not has_jwks then
        if allow_unverified then return true, "unverified" end
        kong.log.err("[aforo-metering] No jwt_jwks_uri or jwt_public_key configured -- RS256 ",
            "signature CANNOT be verified. Set jwt_jwks_uri to the issuer's JWKS, or ",
            "jwt_public_key to its PEM public key, or verify the token with Kong's jwt plugin ",
            "and use customer_id_jwt_claim.")
        return false, "INVALID_SIGNATURE"
    end

    if type(header) ~= "table" or header.alg ~= "RS256" then
        -- Never falls back to "unverified": a key IS configured, so a token
        -- that names another algorithm is a bad token, not an unverifiable one.
        return false, "UNSUPPORTED_ALGORITHM"
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

    local kid = claim_string(header.kid)
    local pk, kerr, from_jwks
    if has_jwks then
        pk, kerr = jwks_key(conf, kid)
        from_jwks = pk ~= nil
    end
    if not pk and has_static then
        pk, kerr = load_public_key(conf.jwt_public_key)
    end
    if not pk then
        -- A broken key or library is an operator error. Never honour
        -- allow_unverified here: a typo in the PEM must not open the gate.
        if has_jwks then
            -- A caller controls the kid, so this is throttled, not logged per request.
            warn_throttled("jwks_no_key", 60, "[aforo-metering] RS256 signature CANNOT be verified: ",
                tostring(kerr))
        else
            kong.log.err("[aforo-metering] RS256 signature CANNOT be verified: ", kerr)
        end
        return false, "INVALID_SIGNATURE"
    end

    if rs256_verify(pk, signature, signing_input) then
        return true, "verified"
    end
    -- The issuer may have replaced the key and kept the kid. Refresh once
    -- (rate-limited like any other refresh, so bad signatures cannot drive
    -- fetches) and try the new key if it differs.
    if from_jwks then
        local fresh = jwks_key(conf, kid, true)
        if fresh and fresh ~= pk and rs256_verify(fresh, signature, signing_input) then
            return true, "verified"
        end
    end
    return false, "INVALID_SIGNATURE"
end

-- Main JWT validation entry point.
-- Returns {valid=bool, reason=string, status=503?, signature_verified=bool,
-- customer_id, tenant_id, key_id, client_id, scopes, ...}
local function validate_jwt(token, conf)
    if type(token) ~= "string" or #token > MAX_JWT_LENGTH then
        return { valid = false, reason = "MALFORMED_TOKEN" }
    end

    -- 1. Structure + encoding
    local raw, header = parse_jwt(token)
    if not raw then
        return { valid = false, reason = "MALFORMED_TOKEN" }
    end

    local claims = {
        sub         = claim_string(raw.sub),
        iss         = claim_string(raw.iss),
        jti         = claim_string(raw.jti),
        tenant_id   = claim_string(raw.tenant_id),
        customer_id = claim_string(raw.customer_id),
        key_id      = claim_string(raw.key_id),
        client_id   = claim_string(raw.client_id),
        environment = claim_string(raw.environment),
    }

    -- 2. Signature. Before exp / iss / revocation: those are claims, and a
    -- claim means nothing until the signature over it has been checked.
    local sig_ok, sig_mode = verify_rs256_signature(token, conf, header)
    if not sig_ok then
        return { valid = false, reason = sig_mode or "INVALID_SIGNATURE" }
    end
    local signature_verified = (sig_mode == "verified") or kong_verified_same_token(token)
    if not signature_verified then
        warn_throttled("jwt_unverified", 300,
            "[aforo-metering] jwt_allow_unverified_signature=true: a token was let through ",
            "WITHOUT signature verification. Its claims are not used for customerId or keyId. ",
            "Verify it with Kong's jwt plugin (then set customer_id_jwt_claim) or set ",
            "jwt_jwks_uri / jwt_public_key. Repeats suppressed for 300s.")
    end

    -- 3. Expiry / not-before
    local now = ngx.time()
    local exp = tonumber(raw.exp)
    if not exp or now > exp then
        return { valid = false, reason = "TOKEN_EXPIRED" }
    end
    if raw.nbf ~= nil and raw.nbf ~= cjson.null then
        local nbf = tonumber(raw.nbf)
        if not nbf or now + JWT_CLOCK_SKEW_SECONDS < nbf then
            return { valid = false, reason = "TOKEN_NOT_YET_VALID" }
        end
    end

    -- 4. Issuer. Required (2.8.0, G326): before, a blank jwt_issuer skipped
    -- the check, so a token from any issuer whose key verified was accepted.
    -- Without jwt_issuer the plugin now refuses JWTs (500, the gateway is
    -- misconfigured, not the caller) unless jwt_issuer_check_disabled is set
    -- on purpose. The schema refuses that combination for new configs.
    local issuer = non_empty_string(conf.jwt_issuer)
    if not issuer then
        if conf.jwt_issuer_check_disabled ~= true then
            warn_throttled("jwt_no_issuer", 60,
                "[aforo-metering] jwt_validation_enabled is set but jwt_issuer is not: JWTs are ",
                "refused with 500 ISSUER_NOT_CONFIGURED. Set jwt_issuer (Aforo: https://auth.aforo.ai), ",
                "or set jwt_issuer_check_disabled = true to accept any issuer. Repeats suppressed for 60s.")
            return { valid = false, reason = "ISSUER_NOT_CONFIGURED", status = 500 }
        end
    elseif claims.iss ~= issuer then
        kong.log.warn("[aforo-metering] JWT issuer mismatch: got '", tostring(claims.iss),
            "', expected '", issuer, "'")
        return { valid = false, reason = "INVALID_ISSUER" }
    end

    -- 4b. Audience (2.8.0, G326). With jwt_audience set, the token's aud (a
    -- string or an array of strings) must name one of them; a token without
    -- aud is refused. Unset: aud is not checked -- Aforo's issuer
    -- (organization-service) mints tokens without aud and binds them to the
    -- tenant instead (step 5).
    local audiences = conf.jwt_audience
    if type(audiences) == "table" and #audiences > 0 then
        local aud = raw.aud
        local list = (type(aud) == "string" and { aud }) or (type(aud) == "table" and aud) or {}
        local matched = false
        for _, a in ipairs(list) do
            if type(a) == "string" then
                for _, want in ipairs(audiences) do
                    if a == want then matched = true; break end
                end
            end
            if matched then break end
        end
        if not matched then
            warn_throttled("jwt_audience", 60,
                "[aforo-metering] JWT rejected: aud does not name any of jwt_audience. ",
                "Repeats suppressed for 60s.")
            return { valid = false, reason = "INVALID_AUDIENCE" }
        end
    end

    -- 5. Tenant binding (Gowtham, 2026-10-12). Without it a token minted for
    -- tenant A was accepted by tenant B's gateway, metered as B, and forwarded
    -- upstream with A's X-Tenant-Id.
    if non_empty_string(conf.tenant_id) and claims.tenant_id ~= conf.tenant_id then
        warn_throttled("jwt_tenant_mismatch", 60,
            "[aforo-metering] JWT rejected: tenant_id '", tostring(claims.tenant_id),
            "' does not match this plugin's tenant_id '", conf.tenant_id,
            "'. Repeats suppressed for 60s.")
        return { valid = false, reason = "TENANT_MISMATCH" }
    end

    -- 6. Revocation: this token (jti), or every token of its client
    -- (client_id, then key_id). See jti_redis_fail_mode above.
    local revoked = revocation_reason(conf, claims)
    if revoked == "REVOCATION_CHECK_UNAVAILABLE" then
        return { valid = false, reason = revoked, status = 503 }
    elseif revoked then
        return { valid = false, reason = revoked }
    end

    -- 7. Return validated claims. Only strings leave here: these become
    -- upstream headers, and a non-string header value raises.
    local scopes = raw.scopes
    if type(scopes) == "table" then
        local parts = {}
        for _, sc in ipairs(scopes) do
            if type(sc) == "string" then parts[#parts + 1] = sc end
        end
        scopes = table.concat(parts, " ")
    else
        scopes = claim_string(scopes) or ""
    end

    return {
        valid        = true,
        signature_verified = signature_verified,
        customer_id  = claims.customer_id or claims.sub or "",
        tenant_id    = claims.tenant_id or "",
        key_id       = claims.key_id or "",
        client_id    = claims.client_id,
        scopes       = scopes,
        environment  = claims.environment or "live",
        offering_ids = type(raw.offering_ids) == "table" and raw.offering_ids or nil,
        jti          = claims.jti,
    }
end

local AforoMeteringHandler = {
    PRIORITY = 5,    -- Run after most other plugins
    VERSION  = "2.8.0",
}

-- The event buffer and its delivery to the ingestor live in event-buffer.lua.

-- productType is REQUIRED by the ingestor in production, and some types carry
-- fields of their own. The ingestor validates a batch as a whole, so one event
-- missing its type's fields fails every event it travels with; such events are
-- skipped at the log phase instead. AI_AGENT gets agentId and sessionId from
-- trusted sources only (see resolve_ai_agent_identity), an MCP tool call its
-- agent from the upstream or the verified customer (mcp_agent_id), and
-- AGENTIC_API its traceId from the upstream or Kong (agentic_trace_id). gRPC service/method,
-- GraphQL operation, WebSocket connection and MQTT topic are not observable
-- at an HTTP gateway, so those types are listed only so the check refuses
-- them rather than poisoning batches. Unknown types are passed through
-- unchecked.
local DEFAULT_PRODUCT_TYPE = "API"
local PRODUCT_TYPE_REQUIRED_FIELDS = {
    API           = {},
    AGENTIC_API   = { "traceId" },
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
-- Helpers
-- ────────────────────────────────────────────────────────────

-- An exclude_paths entry matches the path itself and anything below it: "/health"
-- excludes "/health" and "/health/live", not "/healthcare/patients" (2026-10-12
-- fix). It was a bare string prefix, so the defaults (/health, /ready,
-- /metrics) quietly stopped billing any API whose path merely began with them.
local function should_exclude_path(path, exclude_paths)
    if not exclude_paths or type(path) ~= "string" then return false end
    for _, excluded in ipairs(exclude_paths) do
        if type(excluded) == "string" and excluded ~= "" then
            if path == excluded then return true end
            if string.sub(path, 1, #excluded) == excluded
                and (string.sub(excluded, -1) == "/"
                     or string.sub(path, #excluded + 1, #excluded + 1) == "/") then
                return true
            end
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

-- ── Text hygiene ────────────────────────────────────────────
--
-- What keeps a batch readable is valid JSON, and cjson emits a Lua string's
-- bytes as they are: one malformed UTF-8 sequence in any event (a client's
-- header, a path) made the ingestor unable to read the whole request
-- (Jackson answers 400), and every event batched with it went down too. So
-- every string an event carries must be well-formed UTF-8. Valid Unicode is
-- legitimate and passes through unchanged -- a path, a tool name or a
-- customer id may well be "café".
--
-- Lengths are counted the way the ingestor counts them: Java's
-- String.length(), i.e. UTF-16 code units (@Size, and the Postgres VARCHAR
-- behind it, count characters, not bytes). A 4-byte UTF-8 character is 2.

-- The character at byte i of s, if it is well-formed UTF-8: its length in
-- bytes, and in UTF-16 code units. nil for a malformed, overlong or
-- surrogate sequence.
local function utf8_char(s, i)
    local c = string.byte(s, i)
    if c < 0x80 then return 1, 1 end
    if c >= 0xC2 and c <= 0xDF then
        local c2 = string.byte(s, i + 1)
        if c2 and c2 >= 0x80 and c2 <= 0xBF then return 2, 1 end
        return nil
    end
    if c >= 0xE0 and c <= 0xEF then
        local c2, c3 = string.byte(s, i + 1, i + 2)
        if not c3 or c2 < 0x80 or c2 > 0xBF or c3 < 0x80 or c3 > 0xBF then return nil end
        if (c == 0xE0 and c2 < 0xA0) or (c == 0xED and c2 > 0x9F) then return nil end
        return 3, 1
    end
    if c >= 0xF0 and c <= 0xF4 then
        local c2, c3, c4 = string.byte(s, i + 1, i + 3)
        if not c4 or c2 < 0x80 or c2 > 0xBF or c3 < 0x80 or c3 > 0xBF
            or c4 < 0x80 or c4 > 0xBF then return nil end
        if (c == 0xF0 and c2 < 0x90) or (c == 0xF4 and c2 > 0x8F) then return nil end
        return 4, 2
    end
    return nil
end

local function is_control(c)
    return c < 0x20 or c == 0x7F
end

-- s's length in UTF-16 code units when it is well-formed UTF-8 -- and, unless
-- allow_control, free of control characters -- else nil.
local function text_length(s, allow_control)
    local i, n, len = 1, #s, 0
    while i <= n do
        if not allow_control and is_control(string.byte(s, i)) then return nil end
        local bytes, units = utf8_char(s, i)
        if not bytes then return nil end
        i = i + bytes
        len = len + units
    end
    return len
end

-- A header or body value copied into an event: kept only when it is
-- well-formed UTF-8 text without control characters and at most max
-- characters, else dropped. A repeated header arrives as a table (the first
-- value is used).
local function clean_string(v, max)
    if type(v) == "table" then v = v[1] end
    if type(v) ~= "string" or v == "" then return nil end
    local len = text_length(v)
    if not len or len > max then return nil end
    return v
end

-- A value that must stay on the event whatever the client sent -- the request
-- path, an MCP tool name: dropping it would let a client opt out of metering.
-- Valid UTF-8 is kept as it is; only malformed bytes and control characters
-- are percent-encoded (Kong hands the path over decoded, so it can hold raw
-- bytes). Then it is cut to max characters, at a character boundary.
local function escaped_string(v, max)
    if type(v) == "table" then v = v[1] end
    if type(v) ~= "string" then return nil end
    local out, len, i, n = {}, 0, 1, #v
    while i <= n do
        local c = string.byte(v, i)
        local bytes, units
        if not is_control(c) then bytes, units = utf8_char(v, i) end
        local piece
        if bytes then
            piece = string.sub(v, i, i + bytes - 1)
        else
            piece, bytes, units = string.format("%%%02X", c), 1, 3
        end
        if len + units > max then break end
        out[#out + 1] = piece
        len = len + units
        i = i + bytes
    end
    return table.concat(out)
end

-- A value for event metadata (names Kong holds: service, route, consumer):
-- kept when it is valid text, else left out.
local function text_or_nil(v)
    if type(v) == "string" and text_length(v, true) then return v end
    return nil
end

-- quantity as the ingestor stores it: @Digits(integer = 14, fraction = 6).
-- More decimals failed the event (0.3333333 from an upstream header was
-- refused); rounded here instead. A value that rounds to 0 is not billable.
local function round_quantity(q)
    return math.floor(q * 1e6 + 0.5) / 1e6
end

-- Ingestor limits (IngestUsageEventRequest @Size) on fields that identify what
-- is billed. These are not cut short -- a truncated agent or customer id would
-- bill the wrong one -- and an event over a limit is refused by the ingestor
-- anyway, so it is skipped here with the reason instead.
local IDENTITY_LIMITS = {
    customerId = 64, metricName = 255, idempotencyKey = 255,
    agentId = 36, sessionId = 64, productType = 20, traceId = 128,
    -- gRPC / GraphQL / WebSocket events (IngestUsageEventRequest @Size).
    grpcService = 255, grpcMethod = 128, grpcStatusCode = 24, grpcCallType = 20,
    gqlOperationType = 20, gqlOperationName = 255,
    wsConnectionId = 64, wsDirection = 24, wsFrameType = 16,
}

-- The first identity field the ingestor would refuse, and why -- or nil.
-- Counted in characters (see text_length); control characters are allowed
-- here, since cjson escapes them and they are someone's actual identifier.
local function identity_problem(event)
    for field, max in pairs(IDENTITY_LIMITS) do
        local v = event[field]
        if type(v) == "string" then
            local len = text_length(v, true)
            if not len then
                return field, "is not valid UTF-8 text"
            end
            if len > max then
                return field, "is longer than the ingestor's " .. max .. "-character limit"
            end
        end
    end
    return nil
end

-- ────────────────────────────────────────────────────────────
-- Execution status (OUTCOME_BASED pricing)
-- ────────────────────────────────────────────────────────────
-- The upstream's HTTP status as the ingestor's executionStatus, on every
-- event (2026-10-19). OUTCOME_BASED rate plans bill each event at a weight
-- per status, and metric filters can count only SUCCESS; an event without a
-- status bills at full weight and never matches such a filter. Only MCP tool
-- calls used to carry one (2xx SUCCESS, anything else ERROR), so a 500 from
-- an API, AI agent or agentic API billed exactly like a 200 under every plan.
-- The table is the one all Aforo gateway plugins share (policy locked
-- 2026-09-30):
--   2xx/3xx -> SUCCESS, 408/504 -> TIMEOUT, 499 -> CANCELLED,
--   400/422 -> VALIDATION_FAILED, 401/403/429 -> BLOCKED,
--   every other 4xx and 5xx -> ERROR, anything else -> nil (field left out).
-- conf.status_outcomes overrides it per exact code ("404" -> "VALIDATION_FAILED").
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
        if type(o) == "string" and OUTCOME_STATUSES[string.upper(o)] then
            return string.upper(o)
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

    -- The connection id is reported as data (wsConnectionId) so frames
    -- metered by @aforo/ws-metering can be correlated with the handshake.
    -- The client chooses Sec-WebSocket-Key, so it is never the
    -- idempotency key -- the log phase keys this event on the gateway
    -- request id.
    local connection_id = non_empty_string(kong.request.get_header("Sec-WebSocket-Key"))
        or request_id
        or uuid()
    if not connection_id then return nil end

    return {
        ws_connection_id = connection_id,
        ws_direction     = "SERVER_TO_CLIENT",
    }
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
-- Cached in aforo_cache (2.8.0, G323; aforo_buffer until 2.7.0, and still
-- when aforo_cache is not declared -- see event_util.cache_dict()).
--
-- Keyed by tenant_id + mappings_url (2026-10-12 fix). The cache used to be one
-- global key, so with two plugin instances the second tenant's traffic was
-- named by the first tenant's catalog rules -- metric names from somebody
-- else's catalog, which the ingestor then rejected or, worse, accepted.
local function mappings_key(conf)
    return "aforo:gateway_mappings:" .. ngx.md5((conf.tenant_id or "") .. "\n" .. (conf.mappings_url or ""))
end

local function fetch_mappings(premature, conf)
    if premature then return end

    local dict = event_util.cache_dict()
    if not dict then return end

    local httpc = http.new()
    httpc:set_timeout(conf.mappings_timeout_ms or 3000)

    local url = conf.mappings_url .. "?tenantId=" .. ngx.escape_uri(conf.tenant_id or "")
    local res, err = httpc:request_uri(url, {
        method = "GET",
        headers = { ["Accept"] = "application/json" },
    })

    local key = mappings_key(conf)
    dict:delete(key .. ":inflight")

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

    -- safe_set: never evict buffered events to make room for a cache. If the
    -- dict is full the table is not stored -- and then neither is its
    -- timestamp, so the next request tries again instead of treating an
    -- empty cache as fresh.
    local stored, serr = dict:safe_set(key, cjson.encode(body.mappings))
    if not stored then
        kong.log.warn("[aforo-metering] Could not cache the metric mappings (", tostring(serr),
            "); using the previous table or local metric_mappings until the next refresh.")
        return
    end
    dict:safe_set(key .. ":at", ngx.now())
    if body.cacheTtlSeconds and tonumber(body.cacheTtlSeconds) then
        dict:safe_set(key .. ":ttl", tonumber(body.cacheTtlSeconds))
    end
    kong.log.info("[aforo-metering] Loaded ", #body.mappings, " metric mappings for tenant ",
        conf.tenant_id or "?")
end

-- Spawn a refresh when the cache is older than its TTL. Called from the request
-- path, but only ever schedules work -- it does not wait for it.
local function maybe_refresh_mappings(conf)
    if not conf.mappings_url or conf.mappings_url == "" then return end

    local dict = event_util.cache_dict()
    if not dict then return end

    local key = mappings_key(conf)
    local fetched_at = dict:get(key .. ":at")
    local ttl = dict:get(key .. ":ttl") or conf.mappings_refresh_seconds or 300
    if fetched_at and (ngx.now() - fetched_at) < ttl then return end

    -- One worker fetches; the rest carry on with the cache. add() is atomic, so
    -- a burst of concurrent requests cannot stampede catalog.
    local claimed = dict:safe_add(key .. ":inflight", 1, 30)
    if not claimed then return end

    local ok, err = ngx.timer.at(0, fetch_mappings, conf)
    if not ok then
        dict:delete(key .. ":inflight")
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

local function metric_from_cached_mappings(conf, path)
    local dict = event_util.cache_dict()
    if not dict then return nil end
    if not conf.mappings_url or conf.mappings_url == "" then return nil end
    local raw = dict:get(mappings_key(conf))
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
                                   consumer_name, header_metric, mcp_fallback)
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
    local central = metric_from_cached_mappings(conf, path)
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

    -- An MCP tool call stops here: after the header and the mappings it is a
    -- tool invocation, not generic API usage under default_metric.
    if mcp_fallback then
        return mcp_fallback
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

-- Resolve agentId and sessionId for an AI_AGENT event.
--
-- Aforo requires both on every AI_AGENT event and a gateway observes neither.
-- The obvious sources -- X-Agent-Id or X-Aforo-Session-Id on the REQUEST --
-- are client-settable, so they are never read: a caller could choose which
-- agent its usage is attributed to. Only sources the client cannot touch:
--   agentId:   conf.agent_id_header from the upstream RESPONSE, then the
--              operator's conf.agent_id for this service/route, then the
--              id of the Kong service the request was proxied to
--              (2026-10-19): an AI_AGENT product with neither configured
--              used to meter nothing at all. The service is the agent, and
--              its id is the operator's, never the client's.
--   sessionId: conf.session_id_header from the upstream RESPONSE, then this
--              request's idempotency key (Kong's request ID, never a client
--              header) -- so without the header, one request is one session
-- agentId comes back nil only for a request routed to no service; the
-- required-field check in the log phase then refuses the event and says how
-- to supply it.
-- An upstream response header that names who or what is billed. Returns
-- (value) when usable, (nil) when absent, and (nil, true) when it is present
-- but unusable -- malformed text, a control character, or longer than the
-- ingestor allows. The caller must then skip the event, not fall back
-- (2026-10-12 fix): falling back used to bill an agent's usage to
-- config.agent_id, a multi-request session as one-off requests, and a
-- metric the backend named to default_metric -- quietly, to the wrong thing.
local function upstream_identity(header, max)
    local raw = kong.response.get_header(header)
    if type(raw) == "table" then raw = raw[1] end
    if raw == nil or raw == "" then return nil end
    local v = clean_string(raw, max)
    if not v then return nil, true end
    return v
end

-- The trace an AGENTIC_API call belongs to, or (nil, bad_header).
--
-- AGENTIC_API bills per trace: the ingestor folds every event of a
-- (tenant, traceId) into one agentic session -- a goal -- which outcome
-- billing, session budgets and the kill switch then act on. So the trace is
-- billing identity, and the client must not choose it (2026-10-19). It was
-- the client's traceparent, else its x-trace-id: a caller that sent one
-- traceparent on every call folded all its goals into a single session, and
-- one that sent another customer's trace id put its calls into that
-- customer's session. Now only sources the client cannot touch:
--   1. conf.trace_id_header from the upstream RESPONSE -- the backend knows
--      which calls make up one goal
--   2. Kong's ID for this request: one request, one goal
-- The client's traceparent still travels in event.trace, for correlation.
local function agentic_trace_id(conf, request_id)
    local header = non_empty_string(conf.trace_id_header)
    if header then
        local v, bad = upstream_identity(header, IDENTITY_LIMITS.traceId)
        if bad then return nil, header end
        if v then return v end
    end
    return request_id
end

-- Returns agent_id, session_id, bad_agent_header, bad_session_header.
-- A bad_* is the name of a header the upstream sent with a value that cannot
-- be used; the matching value is then nil -- never a fallback -- and the
-- other one is still resolved, so a caller that does not need the bad one
-- can go on (2026-10-13 fix: one bad header used to void both).
local function resolve_ai_agent_identity(conf, request_key, service)
    local agent_id, session_id, bad_agent, bad_session

    local agent_header = non_empty_string(conf.agent_id_header)
    if agent_header then
        local v, bad = upstream_identity(agent_header, IDENTITY_LIMITS.agentId)
        if bad then bad_agent = agent_header else agent_id = v end
    end
    if not bad_agent then
        agent_id = agent_id or non_empty_string(conf.agent_id)
            or (type(service) == "table" and clean_string(service.id, IDENTITY_LIMITS.agentId))
    end

    local session_header = non_empty_string(conf.session_id_header)
    if session_header then
        local v, bad = upstream_identity(session_header, IDENTITY_LIMITS.sessionId)
        if bad then bad_session = session_header else session_id = v end
    end
    if not bad_session then
        session_id = session_id or request_key
    end

    return agent_id, session_id, bad_agent, bad_session
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
    local ok, claims = pcall(parse_jwt, token)
    if not ok or type(claims) ~= "table" then return nil end
    return claims
end


-- A claim is "set" when it is present and not false / "" / JSON null.
local function claim_is_set(v)
    if v == nil or v == false or v == "" then return false end
    if cjson.null ~= nil and v == cjson.null then return false end
    return true
end

-- A usable customer id: a non-blank string, trimmed. Its length is checked
-- later, by identity_problem, in characters as the ingestor counts them (a
-- byte count here refused 'é' x 40, which the ingestor accepts).
local function usable_customer_id(value)
    if type(value) ~= "string" then return nil end
    value = value:match("^%s*(.-)%s*$")
    if value == "" then return nil end
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

-- The Aforo API-key id of a token whose signature was verified, for rate
-- limiting (2.7.0, G328): this plugin's own check (jwt_validation_enabled,
-- signature_verified) first, else a token Kong's jwt plugin verified. A token
-- let through by jwt_allow_unverified_signature names no key. Returns nil
-- when there is none.
local function verified_key_id()
    local claims = kong.ctx.shared and kong.ctx.shared.aforo_jwt_claims
    if type(claims) == "table" then
        if claims.signature_verified == true then
            return non_empty_string(claims.key_id)
        end
        return nil
    end
    local kong_claims = verified_jwt_claims()
    if kong_claims then
        return non_empty_string(claim_string(kong_claims.key_id))
    end
    return nil
end

-- Kong's own ID for the current request -- the idempotency key (2026-10-12).
--
-- The key used to be the client's X-Request-Id header, falling back to
-- X-Kong-Request-Id, which is a request header too. The ingestor dedups on
-- (tenant_id, idempotency_key) and silently drops a repeat, so a caller that
-- sent the same X-Request-Id on every call was billed for the first one and
-- never again -- and any other customer of the tenant who happened to send a
-- colliding ID lost those events as well. A value the client chooses cannot
-- decide whether usage counts. Only a server-generated ID is used now:
--   1. kong.request.get_id(), where the PDK has it (not in Kong 3.4)
--   2. nginx's $request_id: 32 random hex characters per request, generated
--      by nginx and not influenced by any request header (verified on 3.4)
--   3. a fresh UUID
-- Resolved once per event in the log phase. The key is then part of the
-- buffered JSON, so a re-buffered or retried event carries the same key and
-- the ingestor still collapses a retry that did land.
local function kong_request_id()
    local get_id = kong.request.get_id
    if type(get_id) == "function" then
        local ok, id = pcall(get_id)
        if ok and type(id) == "string" and id ~= "" then
            return id
        end
    end
    local ok, id = pcall(function() return ngx.var.request_id end)
    if ok and type(id) == "string" and id ~= "" then
        return id
    end
    return uuid()
end

-- ────────────────────────────────────────────────────────────
-- W3C Trace Context extraction
-- Captures traceparent, tracestate, x-trace-id, x-request-id
-- from inbound request headers. Returns nil for absent headers.
-- ────────────────────────────────────────────────────────────

local function extract_trace_context()
    -- Client headers: see clean_string. Informational only, never identity.
    return {
        traceparent = clean_string(kong.request.get_header("traceparent"), 128),
        tracestate  = clean_string(kong.request.get_header("tracestate"), 512),
        xTraceId    = clean_string(kong.request.get_header("x-trace-id"), 128),
        xRequestId  = clean_string(kong.request.get_header("x-request-id"), 128),
    }
end

-- ────────────────────────────────────────────────────────────
-- MCP JSON-RPC Detection
-- ────────────────────────────────────────────────────────────

local MCP_TOOL_METRIC = "mcp_server.tool_invocations"

-- Largest request body read from client_body_buffer_size's spill file.
local MCP_MAX_BODY_BYTES = 1048576

-- MCP metering is on for an mcp_enabled route, and always for an
-- MCP_SERVER product (2026-10-19): an MCP_SERVER event needs the tool name,
-- which only the JSON-RPC body has, so with mcp_enabled off such a product
-- metered nothing at all.
local function mcp_on(conf, product_type)
    return conf.mcp_enabled == true or product_type == "MCP_SERVER"
end

-- Parse a request body as JSON-RPC (2026-10-12 rewrite). Returns nil when it
-- is not JSON-RPC at all, else { calls = { {tool_name}, ... },
-- other = <number of messages that are not tools/call> } --
-- one entry per tools/call, also inside a JSON-RPC batch (an array), which
-- used to be read as no tool call at all.
--
-- Every level is type-checked: the body is the client's. A body of `1`, or
-- "params": null, used to raise in the log phase (indexing a number or the
-- cjson.null userdata) and lose the event. A tools/call whose name is
-- missing or not a string is still a tool call -- billed as "unknown", so
-- leaving the name out is not a way to skip billing. params._meta.agent_id
-- is not read (2026-10-19): it is the client's to write, and the agent is
-- billing identity (see mcp_agent_id).
local function parse_jsonrpc(raw_body)
    if type(raw_body) ~= "string" or raw_body == "" then return nil end
    local parsed = cjson.decode(raw_body)
    if type(parsed) ~= "table" then return nil end

    local messages
    if parsed.jsonrpc ~= nil then
        messages = { parsed }
    elseif #parsed > 0 then
        messages = parsed
    else
        return nil
    end

    local calls, other, jsonrpc = {}, 0, false
    for _, msg in ipairs(messages) do
        if type(msg) == "table" and msg.jsonrpc == "2.0" then
            jsonrpc = true
            if msg.method ~= "tools/call" then
                other = other + 1
            else
                local params = type(msg.params) == "table" and msg.params or {}
                calls[#calls + 1] = {
                    -- Kept, escaped and capped, whatever the client sent: see escaped_string.
                    tool_name = escaped_string(params.name, 64) or "unknown",
                }
            end
        end
    end
    if not jsonrpc then return nil end
    return { calls = calls, other = other }
end

-- What a request bills: tool-call events, a plain event, both or neither.
-- Decided here for both phases, so the access phase's pre-flight check asks
-- about exactly the events the log phase will create.
--   * tools: one event per tools/call in the body
--   * plain: an event for the request itself. Never on an MCP_SERVER
--     product, whose events need a tool name (a GET or DELETE on the MCP
--     endpoint is session plumbing). On a JSON-RPC body, only for its
--     non-tool messages and only with mcp_meter_non_tool_calls (2026-10-12):
--     initialize, tools/list, ping and notifications are protocol traffic.
local function billable(conf, product_type, jsonrpc)
    local tools = jsonrpc ~= nil and #jsonrpc.calls > 0
    local plain
    if product_type == "MCP_SERVER" then
        plain = false
    elseif jsonrpc then
        plain = conf.mcp_meter_non_tool_calls == true and jsonrpc.other > 0
    else
        plain = true
    end
    return tools, plain
end

-- The schema's default_metric. On an MCP_SERVER product a default_metric
-- set to anything else is the product's tool-call metric.
local SCHEMA_DEFAULT_METRIC = "api_calls"

-- The metric a tools/call bills to: the upstream's metric header, central
-- mappings, metric_mappings -- then, on an MCP_SERVER product,
-- default_metric unless it is still the schema's api_calls (2026-10-19),
-- else mcp_server.tool_invocations. An MCP_SERVER product's plugin is
-- configured with its catalog metric as default_metric, and every tool call
-- was billed to mcp_server.tool_invocations instead: a metric the catalog
-- may not have, and not the one its quota rules name.
local function tool_call_metric(conf, product_type, method, path, service_name, route_name,
                                 consumer_name, header_metric)
    local fallback = MCP_TOOL_METRIC
    if product_type == "MCP_SERVER" then
        local dm = non_empty_string(conf.default_metric)
        if dm and dm ~= SCHEMA_DEFAULT_METRIC then fallback = dm end
    end
    return resolve_metric_name(conf, method, path, service_name, route_name, consumer_name,
                               header_metric, fallback)
end

-- The agent of an MCP tool call (not on an AI_AGENT route), or
-- (nil, bad_header). MCP_SERVER requires one on every event, and the agent
-- is billing identity: the ingestor applies per-agent session limits, keys
-- MCP sessions and their duration billing by it, and resolves the agent's
-- team for budgets. So the client cannot name it (2026-10-19) -- it used to
-- be params._meta.agent_id from the request body. Now:
--   1. conf.agent_id_header from the upstream RESPONSE
--   2. the verified customer (JWT claim or Kong consumer): the caller of an
--      MCP server is the agent, and at a gateway the credential is all that
--      identifies the caller
-- conf.agent_id is not used here: it names one agent for the whole service,
-- which for an MCP server would put every customer's sessions under one
-- agent (one session limit, one duration bill).
local function mcp_agent_id(conf, customer_id)
    local header = non_empty_string(conf.agent_id_header)
    if header then
        local v, bad = upstream_identity(header, IDENTITY_LIMITS.agentId)
        if bad then return nil, header end
        if v then return v end
    end
    return customer_id
end

-- The MCP session of a tool call (not on an AI_AGENT route), or
-- (nil, bad_header). Optional for MCP_SERVER, but the ingestor tracks
-- sessions and bills their duration by it, so it comes from the upstream
-- only (2026-10-19) -- it was the client's Mcp-Session-Id request header,
-- and a client rotating it on every call billed no session time:
--   1. conf.session_id_header from the upstream RESPONSE
--   2. the Mcp-Session-Id the upstream answered with (MCP's own header).
--      Its length is not bounded by MCP, so a value the ingestor would not
--      take is hashed rather than dropped: the session survives.
--   3. none
local function mcp_session_id(conf)
    local header = non_empty_string(conf.session_id_header)
    if header then
        local v, bad = upstream_identity(header, IDENTITY_LIMITS.sessionId)
        if bad then return nil, header end
        if v then return v end
    end
    local raw = kong.response.get_header("Mcp-Session-Id")
    if type(raw) == "table" then raw = raw[1] end
    if type(raw) ~= "string" or raw == "" then return nil end
    return clean_string(raw, IDENTITY_LIMITS.sessionId) or ("mcp-" .. ngx.md5(raw))
end

-- A request body larger than client_body_buffer_size is spooled to a temp
-- file, and kong.request.get_raw_body() returns nil for it, so a large
-- tools/call was never seen. Read from the file instead, up to
-- MCP_MAX_BODY_BYTES; past that it is not parsed (and is metered as a plain
-- API call).
local function read_body_file()
    local ok, path = pcall(ngx.req.get_body_file)
    if not ok or type(path) ~= "string" then return nil end
    local f = io.open(path, "rb")
    if not f then return nil end
    local data = f:read(MCP_MAX_BODY_BYTES + 1)
    f:close()
    if not data or #data > MCP_MAX_BODY_BYTES then return nil end
    return data
end

-- nginx variables, read defensively (absent outside a request).
local function ngx_var(name)
    local ok, v = pcall(function() return ngx.var[name] end)
    return ok and v or nil
end

-- Bytes of response body sent to the client (2026-10-12 fix). Content-Length
-- was used, which a chunked or streaming (SSE) response does not have -- so
-- quantity_source=response_size billed it as nothing.
local function response_bytes()
    return tonumber(ngx_var("body_bytes_sent"))
        or tonumber(kong.response.get_header("Content-Length")) or 0
end

-- The whole request as the client saw it, in ms (2026-10-12 fix).
-- X-Kong-Proxy-Latency is only Kong's own overhead: an upstream that took
-- 504 ms was reported as 2.
local function response_time_ms(latency)
    local t = tonumber(ngx_var("request_time"))
    if t then return math.floor(t * 1000 + 0.5) end
    return tonumber(latency) or 0
end

-- ────────────────────────────────────────────────────────────
-- init_worker: re-arm flushes for buffered events no timer is waiting on
-- (after a kong reload, or a worker that crashed). See event-buffer.lua.
-- ────────────────────────────────────────────────────────────

function AforoMeteringHandler:init_worker()
    event_buffer.init_worker()
end

-- The metrics the pre-flight quota check asks about: those this request's
-- events will be billed to (2026-10-19). It used to resolve one metric the
-- way a plain API call bills, so an MCP tool call was checked against
-- default_metric but billed to its tool-call metric, and an initialize or
-- tools/list -- billed nothing -- could still be refused 429.
--
-- Decided as the log phase decides (billable, tool_call_metric,
-- resolve_metric_name), with what the access phase cannot know left out:
--   * the upstream's metric_header. A backend that renames the metric for
--     one response is checked against the configured metric; the metric it
--     names is still enforced by the ingestor when the event arrives.
--   * the upstream's quantity. The check asks whether the quota is already
--     used up, not whether this call would exceed it.
-- Empty for a request that will make no event: an excluded path, a CORS
-- preflight, or an MCP request without a tools/call.
local function preflight_metrics(conf, product_type, consumer)
    local method, path = kong.request.get_method(), kong.request.get_path()
    if should_exclude_path(path, conf.exclude_paths) then return {} end
    if method == "OPTIONS" and kong.request.get_header("Access-Control-Request-Method") then
        return {}
    end

    local jsonrpc
    if mcp_on(conf, product_type) and method == "POST" then
        jsonrpc = parse_jsonrpc(kong.ctx.shared.aforo_raw_body)
    end
    local tools, plain = billable(conf, product_type, jsonrpc)

    local service, route = kong.router.get_service(), kong.router.get_route()
    local service_name = service and service.name or ""
    local route_name = route and route.name or ""
    local consumer_name = consumer and (consumer.username or consumer.custom_id) or ""

    local metrics = {}
    if tools then
        metrics[1] = tool_call_metric(conf, product_type, method, path, service_name, route_name,
                                      consumer_name, nil)
    end
    if plain then
        local m = resolve_metric_name(conf, method, path, service_name, route_name, consumer_name, nil)
        if m ~= metrics[1] then metrics[#metrics + 1] = m end
    end
    return metrics
end

-- ────────────────────────────────────────────────────────────
-- Access phase handler (runs before proxying to upstream)
-- Currently a no-op that stashes trace context for correlation.
-- Session 5 will add rate-limit enforcement here.
-- ────────────────────────────────────────────────────────────

function AforoMeteringHandler:access(conf)
    -- Requests this plugin refuses are not billable usage (2026-10-12 fix).
    -- The flag is raised on entry and lowered only when the access phase
    -- completes, so every refusal below (401 / 429 / 503) and any error that
    -- aborts this handler (Kong answers 500) leaves it set, and the log phase
    -- skips the request. A preflight fail-closed 503 used to be metered: the
    -- customer was billed for a call the gateway itself turned away.
    -- exclude_status_codes still applies on top, to every request.
    kong.ctx.shared.aforo_refused = true

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
    local product_type = normalize_product_type(conf.product_type)
    if mcp_on(conf, product_type) or conf.graphql_enabled then
        local ok, body = pcall(kong.request.get_raw_body)
        body = ok and body or nil
        if body == nil then
            body = read_body_file()
        end
        kong.ctx.shared.aforo_raw_body = body
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
        if not result.valid and result.status == 503 then
            -- Revocation could not be checked (Redis down, fail mode closed).
            -- Not the caller's fault, so not 401; Retry-After as preflight-quota does.
            return kong.response.exit(503, {
                error             = "temporarily_unavailable",
                error_description = result.reason,
            }, { ["Retry-After"] = "1" })
        end
        if not result.valid and result.status == 500 then
            -- The plugin is misconfigured (no jwt_issuer); fail closed.
            return kong.response.exit(500, {
                error             = "server_error",
                error_description = result.reason,
            })
        end
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
        -- conf.tenant_id, not the claim: the plugin instance decides the tenant
        -- (the claim has been checked equal to it above).
        kong.service.request.set_header("X-Tenant-Id",   conf.tenant_id)
        kong.service.request.set_header("X-Key-Id",      result.key_id)
        kong.service.request.set_header("X-Scopes",      result.scopes)
        if result.environment then
            kong.service.request.set_header("X-Environment", result.environment)
        end
    end

    -- Rate limit enforcement (reads policy from Redis, returns 429 on HARD breach).
    -- Each check below returns true when it has answered the request; stop
    -- there. In the access phase kong.response.exit only records the
    -- response, so carrying on would run the later checks -- and could answer
    -- twice.
    --
    -- resolve_customer_id() prefers the JWT-validated claim stashed above;
    -- falls back to Kong consumer identity (credential-bound). Never reads
    -- request headers or query params — those sources were removed 2026-04-23.
    -- Resolved before the rate limit so PER_CUSTOMER counts the same verified
    -- customer the log phase bills.
    local consumer = kong.client.get_consumer()
    local customer_id = resolve_customer_id(conf, consumer)

    if conf.rate_limit_enabled and rate_limit.enforce(conf, {
            key_id = verified_key_id(), customer_id = customer_id }) then
        return
    end

    -- Pre-flight quota check against the ingestor (2026-09-21). The module was
    -- written and packaged in the rockspec but never called, so quotas and
    -- prepaid wallets were enforced only after the fact, at ingest -- by which
    -- point the upstream had already served the request. Off unless
    -- preflight_quota_enabled; fail-open; see preflight-quota.lua.
    --
    -- It checks the metrics the log phase will bill (see preflight_metrics),
    -- and nothing for a request that will not be billed: an MCP initialize
    -- or tools/list is never refused for a spent tool-call quota.
    if conf.preflight_quota_enabled then
        -- The quantity known before the upstream answers (2.8.0, G334): a
        -- fixed numeric quantity_source. Response-derived quantities
        -- (quantity_header, response_size) are not known yet; the ingestor
        -- then assumes 1.
        local source = conf.quantity_source
        local qty = (source ~= "response_size") and tonumber(source) or nil
        for _, metric in ipairs(preflight_metrics(conf, product_type, consumer)) do
            if preflight_quota.check(conf, customer_id, metric, qty) then
                return  -- answered 429/503; skip the remaining checks
            end
        end
    end

    -- Margin guard pre-flight check (calls pricing-service quick-check, returns
    -- 429 on THROTTLE / BLOCK).
    if margin_guard.check(conf, conf.tenant_id, customer_id) then
        return
    end

    kong.ctx.shared.aforo_refused = nil
end

-- ────────────────────────────────────────────────────────────
-- Log phase handler (runs after response is sent to client)
-- ────────────────────────────────────────────────────────────

function AforoMeteringHandler:log(conf)
    -- Refused by this plugin's access phase, or that phase failed: never
    -- billable. See the flag in access().
    if kong.ctx.shared.aforo_refused then
        kong.log.debug("[aforo-metering] Not metering a request this plugin refused.")
        return
    end

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
    local request_size = type(raw_body) == "string" and #raw_body
        or tonumber(kong.request.get_header("Content-Length")) or 0
    local response_size = response_bytes()
    local response_ms = response_time_ms(latency)
    -- Never a request header: see kong_request_id.
    local request_id = kong_request_id()

    local service_name = service and service.name or ""
    local route_name = route and route.name or ""
    local consumer_name = consumer and (consumer.username or consumer.custom_id) or ""
    local customer_id = resolve_customer_id(conf, consumer, headers)

    -- W3C trace context (prefer access-phase stash, fallback to re-extraction)
    local trace = kong.ctx.shared.aforo_trace or extract_trace_context()

    -- productType on every event (conf.product_type, default "API").
    local product_type = normalize_product_type(conf.product_type)

    -- An upstream identity header that is present but unusable: the event is
    -- not metered, rather than billed under a different identity.
    local function skip_unusable(header)
        warn_throttled("unusable_" .. header, 60, "[aforo-metering] Skipping events: the upstream ",
            "sent ", header, " with a value that cannot be used (not valid UTF-8 text, a control ",
            "character, or longer than the ingestor allows), e.g. ", method, " ", path, ". Not ",
            "metered, rather than billed to a different ", header, ". Repeats suppressed for 60s.")
    end

    -- Upstream-supplied overrides, read from the response so a client cannot
    -- forge them.
    local header_metric
    if conf.metric_header and conf.metric_header ~= "" then
        local bad
        header_metric, bad = upstream_identity(conf.metric_header, IDENTITY_LIMITS.metricName)
        if bad then return skip_unusable(conf.metric_header) end
    end

    -- MCP: JSON-RPC on an mcp_enabled route or an MCP_SERVER product.
    local jsonrpc = nil
    if mcp_on(conf, product_type) and method == "POST" then
        jsonrpc = parse_jsonrpc(raw_body)
    end

    -- Nothing billable: an MCP protocol message that is not a tool call
    -- (initialize, tools/list, ping, notifications/*) without
    -- mcp_meter_non_tool_calls, or anything but a tool call on an MCP_SERVER
    -- product. See billable(); the pre-flight check uses the same decision.
    local tools, plain = billable(conf, product_type, jsonrpc)
    if not tools and not plain then
        kong.log.debug("[aforo-metering] Not metering an MCP request without a tools/call.")
        return
    end

    local function api_event()
        local header_quantity = conf.quantity_header and conf.quantity_header ~= ""
            and kong.response.get_header(conf.quantity_header) or nil
        local event = { productType = product_type, customerId = customer_id }
        event.metricName     = resolve_metric_name(conf, method, path, service_name,
                                                   route_name, consumer_name, header_metric)
        event.quantity       = resolve_quantity(conf, response_size, header_quantity)
        event.idempotencyKey = request_id
        event.occurredAt     = iso8601_utc(ngx.now())
        -- AI_AGENT only. Other types do not define these fields, so they are
        -- left off rather than sent on every API call. The idempotency key is
        -- Kong's own request ID, so it doubles as the per-request session
        -- fallback.
        if product_type == "AI_AGENT" then
            local bad_agent, bad_session
            event.agentId, event.sessionId, bad_agent, bad_session = resolve_ai_agent_identity(conf, request_id, service)
            if bad_agent or bad_session then return nil, bad_agent or bad_session end
        end
        return event
    end

    local events = {}
    if tools then
        -- One event per tools/call: a JSON-RPC batch carries several.
        local metric = tool_call_metric(conf, product_type, method, path, service_name, route_name,
                                        consumer_name, header_metric)
        -- AI_AGENT: agent and session come from config or the upstream only,
        -- as for every other AI_AGENT event. Otherwise the call is an
        -- MCP_SERVER event whose agent is the upstream's agent header or the
        -- verified customer, and whose session is the upstream's (see
        -- mcp_agent_id, mcp_session_id) -- never X-Agent-Id, _meta.agent_id
        -- or the request's Mcp-Session-Id, which are the client's to set.
        -- An unusable header skips the calls: every one of them would use it.
        local agent_id, session_id, bad
        if product_type == "AI_AGENT" then
            local bad_agent, bad_session
            agent_id, session_id, bad_agent, bad_session =
                resolve_ai_agent_identity(conf, request_id, service)
            bad = bad_agent or bad_session
        else
            agent_id, bad = mcp_agent_id(conf, customer_id)
            if not bad then session_id, bad = mcp_session_id(conf) end
        end
        if bad then return skip_unusable(bad) end
        for i, call in ipairs(jsonrpc.calls) do
            local event = { productType = product_type, customerId = customer_id }
            if product_type ~= "AI_AGENT" then event.productType = "MCP_SERVER" end
            event.metricName     = metric
            event.quantity       = 1
            event.idempotencyKey = "mcp:" .. (conf.tenant_id or "") .. ":" .. request_id .. ":"
                                   .. i .. ":" .. call.tool_name
            event.occurredAt     = iso8601_utc(ngx.now())
            event.toolName       = call.tool_name
            event.agentId        = agent_id
            event.sessionId      = session_id
            event.executionDurationMs = response_ms
            events[i] = event
        end
    end
    -- gRPC / GraphQL / WebSocket, each opt-in (grpc_enabled, graphql_enabled,
    -- websocket_enabled). Only for a request that is not an MCP tool call.
    -- Returns an event, nil (not this protocol), or false (an excluded
    -- outcome: no event at all).
    --
    -- Idempotency keys are built from Kong's request id only (Rule #21),
    -- never from a client value. The gRPC service/method and the GraphQL
    -- operation name come from the client: they are escaped and cut to the
    -- ingestor's limits rather than skipped, so a client cannot opt out of
    -- metering with an oversized name.
    local function protocol_event()
        local content_type = headers["content-type"]
        if type(content_type) ~= "string" then content_type = nil end
        local base = { customerId = customer_id, quantity = 1, occurredAt = iso8601_utc(ngx.now()),
                       executionDurationMs = response_ms }
        if conf.grpc_enabled then
            local g = detect_grpc_call(content_type or kong.response.get_header("Content-Type"),
                                       path, conf.grpc_path_prefix)
            if g then
                local grpc_code = read_grpc_status_code()
                -- exclude_status_codes is in HTTP terms. gRPC auth and rate-limit
                -- failures arrive on HTTP 200, so the gRPC code's HTTP equivalent
                -- is checked too.
                if grpc_code and should_exclude_status(
                        GRPC_OUTCOME_HTTP_EQUIV[grpc_code] or 500, conf.exclude_status_codes) then
                    return false
                end
                local svc = escaped_string(g.grpc_service, IDENTITY_LIMITS.grpcService) or "unknown"
                local mth = escaped_string(g.grpc_method, IDENTITY_LIMITS.grpcMethod) or "unknown"
                base.productType    = "GRPC_API"
                base.metricName     = "grpc_api.rpc_calls"
                base.idempotencyKey = "grpc:" .. (conf.tenant_id or "") .. ":" .. request_id
                base.grpcService    = svc
                base.grpcMethod     = mth
                base.grpcStatusCode = extract_grpc_status(status, grpc_code)
                base.grpcCallType   = g.grpc_call_type
                base.messageCount   = tonumber(kong.request.get_header("Grpc-Message-Count")) or 1
                base.dataBytes      = (request_size or 0) + (response_size or 0)
                base.executionStatus = grpc_outcome(grpc_code, status, conf.status_outcomes)
                return base
            end
        end
        if conf.graphql_enabled and method == "POST" then
            local q = detect_graphql_call(raw_body, content_type, path, conf.graphql_path_pattern)
            if q then
                base.productType      = "GRAPHQL_API"
                base.metricName       = "graphql_api.operations"
                base.idempotencyKey   = "gql:" .. (conf.tenant_id or "") .. ":" .. request_id
                base.gqlOperationType = q.gql_operation_type
                base.gqlOperationName = escaped_string(q.gql_operation_name, IDENTITY_LIMITS.gqlOperationName)
                base.gqlComplexity    = q.gql_complexity
                base.gqlHasErrors     = (status >= 400)
                base.dataBytes        = (request_size or 0) + (response_size or 0)
                return base
            end
        end
        if conf.websocket_enabled then
            local w = detect_websocket_upgrade(headers["upgrade"], status, request_id)
            if w then
                local conn = clean_string(w.ws_connection_id, IDENTITY_LIMITS.wsConnectionId) or request_id
                base.productType    = "WEBSOCKET_API"
                base.metricName     = "websocket_api.connection_opened"
                base.idempotencyKey = "ws:" .. (conf.tenant_id or "") .. ":" .. request_id
                base.wsConnectionId = conn
                base.wsDirection    = w.ws_direction
                base.wsFrameType    = "TEXT"   -- no frames yet; the SDK meters frames
                base.messageCount   = 0
                base.dataBytes      = 0
                -- 101 is not a final outcome, so executionStatus stays unset.
                return base
            end
        end
        return nil
    end

    -- The request itself; for a mixed JSON-RPC batch with
    -- mcp_meter_non_tool_calls, its other messages as one plain API call --
    -- as they would be on their own.
    if plain then
        local event, unusable
        if not tools then
            event = protocol_event()
            if event == false then return end
        end
        if not event then
            event, unusable = api_event()
            if not event then return skip_unusable(unusable) end
        end
        events[#events + 1] = event
    end

    -- The path is client-chosen: escaped and cut to the ingestor's 512 limit.
    local event_path = escaped_string(path, 512) or "/"

    -- One event per call; returning skips it. Written as a function because
    -- Lua 5.1 has no goto (Kong runs LuaJIT, but the busted suite runs on 5.1).
    -- Returns "stop" when no later event can be metered either.
    local function meter_event(event)
        -- quantity must be > 0 (e.g. quantity_source=response_size with an empty
        -- body) after rounding to the ingestor's 6 decimals, and below its 14
        -- integer digits; such an event would only be refused.
        if type(event.quantity) == "number" then
            event.quantity = round_quantity(event.quantity)
        end
        if type(event.quantity) ~= "number" or event.quantity <= 0 or event.quantity >= 1e14 then
            kong.log.debug("[aforo-metering] Skipping ", method, " ", path,
                " -- quantity is not > 0 (after rounding to 6 decimals) or is too large.")
            return
        end

        -- AGENTIC_API: always a traceId, never the client's (see
        -- agentic_trace_id). An unusable trace header skips the event.
        if event.productType == "AGENTIC_API" then
            local bad_trace
            event.traceId, bad_trace = agentic_trace_id(conf, request_id)
            if bad_trace then
                skip_unusable(bad_trace)
                return
            end
        end
        -- AI_AGENT: the ingestor aggregates an agent's sessions by traceId,
        -- and an event without one gets the client's traceparent there -- the
        -- client would choose the session its calls are folded into. The
        -- session is the trusted grouping (config or upstream), so it is
        -- the trace too, as Aforo's agent SDKs send it.
        if event.productType == "AI_AGENT" then
            event.traceId = event.sessionId
        end

        -- Top-level HTTP fields (hoisted from metadata for fast ClickHouse queries)
        event.endpointPath    = event_path
        event.httpMethod      = string.sub(method or "", 1, 16)
        event.statusCode      = status
        event.responseTimeMs  = response_ms
        -- Every type, MCP tool calls included: see outcome_from_status.
        -- gRPC sets its own from the grpc-status code; a WebSocket handshake
        -- (101) has no final outcome.
        if event.executionStatus == nil and event.productType ~= "WEBSOCKET_API" then
            event.executionStatus = outcome_from_status(status, conf.status_outcomes)
        end

        -- W3C trace context (null when absent — fidelity, not synthetic)
        event.trace = trace

        -- Metadata (kept for backward compat — HTTP fields will be removed here in a follow-up)
        if conf.include_metadata then
            event.metadata = {
                gateway       = "kong",
                method        = method,
                path          = event_path,
                status        = status,
                latency       = tonumber(latency) or 0,
                endpoint_path = event_path,
                http_method   = method,
                status_code   = status,
                response_time_ms = response_ms,
                requestSize   = request_size,
                responseSize  = response_size,
                service       = text_or_nil(service_name),
                route         = text_or_nil(route_name),
                consumer      = text_or_nil(consumer_name),
            }
        else
            -- endpoint_path stays whatever include_metadata says (2026-10-12):
            -- central mappings and the ingestor's metric filters and
            -- aggregation read this key, so without it include_metadata=false
            -- silently changed what was billed.
            event.metadata = { endpoint_path = event_path }
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
        -- Only from a token whose signature was verified (2.2.0): a token let
        -- through by jwt_allow_unverified_signature names any key it likes.
        local jwt_claims = kong.ctx.shared and kong.ctx.shared.aforo_jwt_claims
        if type(jwt_claims) == "table" and jwt_claims.signature_verified == true
           and non_empty_string(jwt_claims.key_id) then
            event.metadata.keyId = jwt_claims.key_id
        end

        -- Refuse to buffer an event that can never be accepted (2026-09-03).
        --
        -- customerId is what usage attributes to; the ingestor rejects a blank one.
        -- Nothing downstream can supply the missing value later, so buffering it
        -- only costs a round trip -- it is dropped here, at the one point where the
        -- loss is limited to the event actually at fault.
        if not event.customerId or event.customerId == "" then
            warn_throttled("no_customer", 60, "[aforo-metering] Skipping ", method, " ", path,
                " -- no customer identity resolved. With jwt_validation_enabled the ",
                "customer_id claim supplies this; otherwise set customer_id_source to a ",
                "Kong consumer. Event not metered. Repeats suppressed for 60s.")
            return "stop"
        end

        local field, why = identity_problem(event)
        if field then
            record_drop("invalid_field", 1)
            warn_throttled("identity_" .. field, 300,
                "[aforo-metering] Skipping events: ", field, " ", why, " (e.g. ", method, " ",
                event_path, "). Event not metered. Repeats suppressed for 300s.")
            return
        end

        -- Refuse to buffer an event its productType makes invalid, for the same
        -- reason as the customerId skip above.
        do
            local missing = missing_required_fields(event)
            if missing then
                record_drop("missing_fields", 1)
                -- Name the fix where there is one. An AI_AGENT agentId has exactly
                -- two sources, both in the operator's hands; sessionId always has
                -- its Kong request-ID fallback, so it is never the gap.
                local fix = ""
                if event.productType == "AI_AGENT" and not event.agentId then
                    local agent_header = non_empty_string(conf.agent_id_header)
                    fix = " Fix: set config.agent_id to this service's agent ID, or have the upstream "
                        .. (agent_header
                            and ("send it in the " .. agent_header .. " response header.")
                            or "send it in a response header and set config.agent_id_header to its name.")
                end
                warn_throttled("missing_fields_" .. event.productType, 300,
                    "[aforo-metering] Skipping events: product_type ", event.productType,
                    " requires ", table.concat(missing, ", "), ", which this request did not ",
                    "supply (e.g. ", method, " ", path, ").", fix, " Repeats suppressed for 300s.")
                return
            end
        end

        do
            local encoded, enc_err = cjson.encode(event)
            if not encoded then
                kong.log.err("[aforo-metering] Could not encode event for ", method, " ", path,
                    ": ", enc_err, ". Event not metered.")
                return
            end
            event_buffer.push(conf, encoded)
        end
    end

    for _, event in ipairs(events) do
        if meter_event(event) == "stop" then return end
    end
end

-- Exported for unit testing — not used by the Kong runtime.
-- Keep the top-level handler contract (access/log) unchanged.
AforoMeteringHandler._resolve_customer_id = resolve_customer_id
AforoMeteringHandler._flush_buffer = event_buffer.flush
AforoMeteringHandler._buffer_key = event_buffer.key
AforoMeteringHandler._rearm = event_buffer._rearm
AforoMeteringHandler._conf_ttl = event_buffer.CONF_TTL
AforoMeteringHandler._max_event_age = event_buffer.MAX_EVENT_AGE_SECONDS
AforoMeteringHandler._mappings_key = mappings_key
AforoMeteringHandler._outcome_from_status = outcome_from_status
AforoMeteringHandler._validate_jwt = validate_jwt
AforoMeteringHandler._iso8601_utc = iso8601_utc
AforoMeteringHandler._gateway_request_id = kong_request_id
AforoMeteringHandler._jwks_reset = function() jwks_cache = {} end
AforoMeteringHandler._jwks_cache = function() return jwks_cache end
AforoMeteringHandler._record_drop = record_drop
AforoMeteringHandler._detect_grpc_call = detect_grpc_call
AforoMeteringHandler._grpc_outcome = grpc_outcome
AforoMeteringHandler._read_grpc_status_code = read_grpc_status_code
AforoMeteringHandler._extract_grpc_status = extract_grpc_status
AforoMeteringHandler._detect_graphql_call = detect_graphql_call
AforoMeteringHandler._detect_websocket_upgrade = detect_websocket_upgrade

return AforoMeteringHandler
