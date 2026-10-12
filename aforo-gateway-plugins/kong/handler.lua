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

-- uuid() and iso8601_utc() live in event-util.lua, shared with
-- compound-metering.lua; see there for why each is the way it is.
local event_util = require_sibling("event-util")
local uuid = event_util.uuid
local iso8601_utc = event_util.iso8601_utc


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

-- Revocation lists in Redis, as org-service's JtiBlocklistService writes them:
--   jti:blocked:{jti}          one token                   (value "1")
--   jti:client:{client_id}     every token for that client (value "revoked")
-- jti:client:{key_id} is checked too, as a secondary key.
--
-- Fail-OPEN, as documented, and only on evidence (2026-10-12 fix). The value
-- used to be treated as "revoked" whenever it was anything but nil or
-- ngx.null. lua-resty-redis answers a Redis ERROR reply -- NOAUTH on a
-- password-protected Redis, LOADING while it restores, MOVED in a cluster --
-- with false, so every one of those turned into 401 TOKEN_REVOKED for every
-- token: fail-CLOSED, with nothing in the log. And no AUTH was ever sent, so
-- a protected Redis produced exactly that. Now only a real string value means
-- revoked; an error reply is logged (throttled) and treated as not revoked,
-- the same as an unreachable Redis.
--
-- One connection per request for all the lookups, not one per lookup.
-- Returns "TOKEN_REVOKED", "CLIENT_REVOKED" or nil.
local function revocation_reason(conf, claims)
    local lookups = {}
    if claims.jti then
        lookups[#lookups + 1] = { "jti:blocked:" .. claims.jti, "TOKEN_REVOKED" }
    end
    if claims.client_id then
        lookups[#lookups + 1] = { "jti:client:" .. claims.client_id, "CLIENT_REVOKED" }
    end
    if claims.key_id and claims.key_id ~= claims.client_id then
        lookups[#lookups + 1] = { "jti:client:" .. claims.key_id, "CLIENT_REVOKED" }
    end
    if #lookups == 0 then return nil end

    -- Prefer dedicated jwt_redis_* config; fall back to rate_limit_redis_*.
    -- The password goes with the server: rate_limit_redis_password is only
    -- borrowed when the blocklist lives on the rate-limit Redis, so a
    -- password-less blocklist Redis is not sent a password it would refuse.
    local rl_host = conf.rate_limit_redis_host or "127.0.0.1"
    local rl_port = conf.rate_limit_redis_port or 6379
    local host = non_empty_string(conf.jwt_redis_host) or rl_host
    local port = conf.jwt_redis_port or rl_port
    local password = non_empty_string(conf.jwt_redis_password)
    if not password and host == rl_host and port == rl_port then
        password = non_empty_string(conf.rate_limit_redis_password)
    end

    local red = require("resty.redis"):new()
    red:set_timeout(500)
    local ok, err = red:connect(host, port)
    if ok and password then
        ok, err = red:auth(password)
        if not ok then err = "AUTH failed: " .. tostring(err) end
    end
    if not ok then
        warn_throttled("redis_revocation", 60,
            "[aforo-metering] Redis unavailable for the JWT revocation check at ",
            host, ":", port, " (", tostring(err), "). ",
            "Failing OPEN -- revoked tokens and clients are NOT being rejected. ",
            "Check jwt_redis_host / jwt_redis_port / jwt_redis_password. Repeats suppressed for 60s.")
        red:close()
        return nil
    end

    local failed
    for _, lookup in ipairs(lookups) do
        local val, gerr = red:get(lookup[1])
        if type(val) == "string" then
            red:set_keepalive(10000, 10)
            return lookup[2]
        end
        if val ~= ngx.null then
            -- An error reply or a broken connection: no evidence either way.
            failed = gerr or "no reply"
        end
    end

    if failed then
        warn_throttled("redis_revocation_reply", 60,
            "[aforo-metering] Redis answered the JWT revocation lookup with an error (",
            tostring(failed), ") at ", host, ":", port, ". Failing OPEN -- revoked tokens ",
            "and clients are NOT being rejected. NOAUTH means jwt_redis_password is missing ",
            "or wrong. Repeats suppressed for 60s.")
        red:close()
        return nil
    end
    red:set_keepalive(10000, 10)
    return nil
end

-- ── JWKS (jwt_jwks_uri) ─────────────────────────────────────
--
-- The issuer's public keys, fetched from its JWKS document and selected by the
-- token header's kid. Never fetched per request:
--   * cached in aforo_buffer for JWKS_HARD_TTL, refreshed in the background
--     (a timer) once the copy is older than JWKS_SOFT_TTL -- requests keep
--     using the cached keys meanwhile
--   * fetched in the request only when nothing is cached yet, or the token's
--     kid is not in the cached set (the issuer rotated its key) -- and then at
--     most once per JWKS_REFETCH_INTERVAL across all workers, so a stream of
--     tokens with invented kids cannot become a stream of fetches
-- A set older than JWKS_HARD_TTL is dropped rather than trusted indefinitely:
-- a key the issuer withdrew must stop verifying eventually even if the JWKS
-- endpoint stays unreachable.
local JWKS_CACHE_PREFIX = "aforo:jwks:"
local JWKS_FETCH_LOCK_PREFIX = "aforo:jwks_fetch:"
local JWKS_REFRESH_LOCK_PREFIX = "aforo:jwks_refresh:"
local JWKS_SOFT_TTL = 3600
local JWKS_HARD_TTL = 86400
local JWKS_REFETCH_INTERVAL = 30
local JWKS_FETCH_TIMEOUT_MS = 2000

-- cjson.null -> nil, for optional JWK members.
local function json_opt(v)
    if v == cjson.null then return nil end
    return v
end

-- GET and parse the JWKS document. Returns an entry
-- { fetched_at, count, keys = { [kid] = jwk_json } } or (nil, reason).
-- Only RSA signing keys usable for RS256 are kept; a key without a kid is
-- stored under "" and can only match a kid-less token.
local function fetch_jwks(uri)
    local httpc = http.new()
    httpc:set_timeout(JWKS_FETCH_TIMEOUT_MS)
    local res, err = httpc:request_uri(uri, {
        method = "GET",
        headers = { ["Accept"] = "application/json" },
    })
    if not res then return nil, "fetch failed: " .. tostring(err) end
    if res.status ~= 200 then return nil, "status " .. tostring(res.status) end

    local doc = cjson.decode(res.body)
    if type(doc) ~= "table" or type(doc.keys) ~= "table" then
        return nil, "response is not a JWKS document"
    end

    local keys, count = {}, 0
    for _, k in ipairs(doc.keys) do
        if type(k) == "table" and k.kty == "RSA"
            and (json_opt(k.use) == nil or k.use == "sig")
            and (json_opt(k.alg) == nil or k.alg == "RS256") then
            keys[claim_string(k.kid) or ""] = cjson.encode(k)
            count = count + 1
        end
    end
    if count == 0 then return nil, "no RS256 signing keys in the JWKS" end
    return { fetched_at = ngx.now(), count = count, keys = keys }
end

local function cached_jwks(dict, uri)
    local raw = dict:get(JWKS_CACHE_PREFIX .. uri)
    local entry = raw and cjson.decode(raw)
    return type(entry) == "table" and type(entry.keys) == "table" and entry or nil
end

local function store_jwks(dict, uri, entry)
    dict:set(JWKS_CACHE_PREFIX .. uri, cjson.encode(entry), JWKS_HARD_TTL)
end

-- The key for kid. A token without a kid only matches a set of exactly one
-- key: with several, picking one would be a guess.
local function pick_jwk(entry, kid)
    if not entry then return nil end
    if kid then return entry.keys[kid] end
    if entry.count == 1 then
        local _, jwk = next(entry.keys)
        return jwk
    end
    return nil
end

local function refresh_jwks(premature, uri)
    if premature then return end
    local dict = ngx.shared[BUFFER_DICT]
    if not dict then return end
    local entry, err = fetch_jwks(uri)
    if entry then
        store_jwks(dict, uri, entry)
    else
        warn_throttled("jwks_refresh", 300,
            "[aforo-metering] Could not refresh the JWKS from ", uri, " (", err, "). ",
            "Keeping the cached keys. Repeats suppressed for 300s.")
    end
end

-- The JWK (JSON string) to verify a token with kid, or (nil, reason).
local function jwks_key(uri, kid)
    local dict = ngx.shared[BUFFER_DICT]
    if not dict then
        return nil, "shared dict '" .. BUFFER_DICT .. "' not available"
    end

    local entry = cached_jwks(dict, uri)
    local jwk = pick_jwk(entry, kid)
    if jwk then
        if ngx.now() - (tonumber(entry.fetched_at) or 0) > JWKS_SOFT_TTL
            and dict:add(JWKS_REFRESH_LOCK_PREFIX .. uri, 1, JWKS_REFETCH_INTERVAL) then
            ngx.timer.at(0, refresh_jwks, uri)
        end
        return jwk
    end

    if not dict:add(JWKS_FETCH_LOCK_PREFIX .. uri, 1, JWKS_REFETCH_INTERVAL) then
        if entry then
            return nil, "kid '" .. tostring(kid) .. "' is not in the cached JWKS, and it was "
                .. "refetched less than " .. JWKS_REFETCH_INTERVAL .. "s ago"
        end
        -- Cold cache, and another request is fetching it right now (just
        -- after a restart, typically). Wait for that fetch rather than
        -- refusing a valid token.
        for _ = 1, JWKS_FETCH_TIMEOUT_MS / 50 do
            ngx.sleep(0.05)
            entry = cached_jwks(dict, uri)
            if entry then
                jwk = pick_jwk(entry, kid)
                if jwk then return jwk end
                return nil, "kid '" .. tostring(kid) .. "' is not in the JWKS"
            end
        end
        return nil, "the JWKS has not been fetched yet"
    end

    local fresh, err = fetch_jwks(uri)
    if not fresh then return nil, err end
    store_jwks(dict, uri, fresh)
    jwk = pick_jwk(fresh, kid)
    if not jwk then
        return nil, "kid '" .. tostring(kid) .. "' is not in the JWKS"
    end
    return jwk
end

-- Parsed public keys, per worker, keyed by the JWK's JSON: building an RSA key
-- from a JWK on every request is wasted work for a key that changes yearly.
-- Bounded so a rotation cannot grow it without limit.
local jwk_pkeys, jwk_pkey_count = {}, 0
local function jwk_to_pkey(pkey, jwk)
    local pk = jwk_pkeys[jwk]
    if pk then return pk end
    local err
    pk, err = pkey.new(jwk, { format = "JWK" })
    if not pk then return nil, err end
    if jwk_pkey_count >= 16 then
        jwk_pkeys, jwk_pkey_count = {}, 0
    end
    jwk_pkeys[jwk] = pk
    jwk_pkey_count = jwk_pkey_count + 1
    return pk
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
--
-- Key source (2026-10-12): jwt_public_key (a static PEM) when set, else the
-- issuer's JWKS from jwt_jwks_uri, selected by the token's kid. jwt_jwks_uri
-- used to be accepted and ignored, so a JWKS-only configuration rejected every
-- token. Neither set, or no usable key from the JWKS: the signature cannot be
-- verified, which jwt_allow_unverified_signature decides. A key that IS found
-- and does not verify the signature is always a rejection.
local function verify_rs256_signature(token, conf, header)
    local allow_unverified = conf.jwt_allow_unverified_signature == true
    local pem = non_empty_string(conf.jwt_public_key)
    local jwks_uri = non_empty_string(conf.jwt_jwks_uri)

    if not pem and not jwks_uri then
        kong.log.err("[aforo-metering] Neither jwt_public_key nor jwt_jwks_uri is configured -- ",
            "RS256 signature CANNOT be verified. Set one of them, or ",
            "jwt_allow_unverified_signature=true only if signatures are verified upstream.")
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

    local pk, perr
    if pem then
        pk, perr = pkey.new(pem)
        if not pk then
            -- A malformed configured key is an operator error, not an upstream
            -- one. Never honour allow_unverified here: that would turn a typo in
            -- the PEM into an open gate.
            kong.log.err("[aforo-metering] jwt_public_key could not be parsed as a public key: ",
                tostring(perr))
            return false
        end
    else
        local kid = claim_string(header and header.kid)
        local jwk, why = jwks_key(jwks_uri, kid)
        if not jwk then
            warn_throttled("jwks_key", 60,
                "[aforo-metering] No JWKS key to verify a token (kid=", tostring(kid), ") from ",
                jwks_uri, ": ", tostring(why), ". RS256 signature CANNOT be verified. ",
                "Repeats suppressed for 60s.")
            return allow_unverified
        end
        pk, perr = jwk_to_pkey(pkey, jwk)
        if not pk then
            kong.log.err("[aforo-metering] JWKS key (kid=", tostring(kid), ") from ", jwks_uri,
                " could not be loaded: ", tostring(perr))
            return allow_unverified
        end
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
--
-- Ordering matters: nothing in the payload is trustworthy until the signature
-- is checked, so before it only exp and iss are looked at -- each normalised
-- first, because an unauthenticated caller chooses their types (see
-- claim_string). A non-numeric exp used to reach `ngx.time() > exp` as a
-- string or a null and raise: a 500 for anyone who asked.
local function validate_jwt(token, conf)
    -- 1. Parse claims (structure + encoding check)
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

    -- 2. Expiry check
    local exp = tonumber(raw.exp)
    if not exp or ngx.time() > exp then
        return { valid = false, reason = "TOKEN_EXPIRED" }
    end

    -- 3. Issuer check
    if conf.jwt_issuer and conf.jwt_issuer ~= "" and claims.iss ~= conf.jwt_issuer then
        kong.log.warn("[aforo-metering] JWT issuer mismatch: got '", tostring(claims.iss),
            "', expected '", conf.jwt_issuer, "'")
        return { valid = false, reason = "INVALID_ISSUER" }
    end

    -- 4. RS256 signature verification (resty.openssl; fail-closed -- see above)
    if not verify_rs256_signature(token, conf, header) then
        return { valid = false, reason = "INVALID_SIGNATURE" }
    end

    -- 5. Tenant binding (2026-10-12 security fix). org-service signs every
    -- tenant's tokens with the same key and issuer, so a valid signature says
    -- nothing about WHICH tenant the token belongs to. Without this check a
    -- token minted for tenant A was accepted by tenant B's gateway, metered as
    -- B, and forwarded upstream with A's X-Tenant-Id.
    if non_empty_string(conf.tenant_id) and claims.tenant_id ~= conf.tenant_id then
        warn_throttled("jwt_tenant_mismatch", 60,
            "[aforo-metering] JWT rejected: tenant_id '", tostring(claims.tenant_id),
            "' does not match this plugin's tenant_id '", conf.tenant_id,
            "'. Repeats suppressed for 60s.")
        return { valid = false, reason = "TENANT_MISMATCH" }
    end

    -- 6. Revocation: this token (jti), or every token of its client
    -- (client_id, then key_id). Fail-open on Redis trouble; see above.
    local revoked = revocation_reason(conf, claims)
    if revoked then
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
    VERSION  = "1.1.0",
}

-- Shared memory buffer name (must be declared in kong.conf: lua_shared_dict aforo_buffer 10m)
--
-- The buffer is a shared-dict LIST, one JSON-encoded event per element
-- (2026-09-21). It used to be a single JSON array under one key, appended by
-- get -> decode -> insert -> set and drained by get -> delete. Neither sequence
-- is atomic, and every nginx worker runs them concurrently: two workers
-- appending at once each wrote back their own copy of the array and the other's
-- event vanished, and an append landing between a flush's get and its delete
-- was deleted unsent. Silent, proportional to traffic, and invisible in the
-- logs -- the worst kind of metering loss. rpush / lpop are single atomic
-- operations under the dict's own lock, so neither race exists any more.
--
-- A new key name on purpose: rpush against the old key, if it still held the
-- legacy string after a hot reload, fails with "value not a list".
local BUFFER_KEY = "aforo:events"
local MAX_BUFFER_SIZE = 10000

-- The ingestor rejects a batch of more than 1000 events with 400 -- which the
-- drop-on-4xx rule in flush_buffer would turn into silently discarding the
-- whole backlog. So a backlog (after an outage, say) is drained in slices no
-- larger than this, rather than as one oversized request.
local MAX_BATCH_SIZE = 1000

-- Longest Retry-After (seconds) honoured on a 429 before the next attempt.
-- The flush runs in a timer, so a longer wait would only hold later slices;
-- past this the batch is re-buffered for a later flush instead.
local MAX_RETRY_AFTER_SECONDS = 30

-- productType is REQUIRED by the ingestor in production, and some types carry
-- fields of their own. The ingestor validates a batch as a whole, so one event
-- missing its type's fields fails every event it travels with; such events are
-- skipped at the log phase instead. AI_AGENT gets agentId and sessionId from
-- trusted sources only (see resolve_ai_agent_identity). gRPC service/method,
-- GraphQL operation, WebSocket connection and MQTT topic are not observable
-- at an HTTP gateway, so those types are listed only so the check refuses
-- them rather than poisoning batches. Unknown types are passed through
-- unchecked.
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

-- Resolve agentId and sessionId for an AI_AGENT event.
--
-- Aforo requires both on every AI_AGENT event and a gateway observes neither.
-- The obvious sources -- X-Agent-Id or X-Aforo-Session-Id on the REQUEST --
-- are client-settable, so they are never read: a caller could choose which
-- agent its usage is attributed to. Only sources the client cannot touch:
--   agentId:   conf.agent_id_header from the upstream RESPONSE, then the
--              operator's conf.agent_id for this service/route
--   sessionId: conf.session_id_header from the upstream RESPONSE, then this
--              request's idempotency key (Kong's request ID, never a client
--              header) -- so without the header, one request is one session
-- agentId may come back nil; the required-field check in the log phase
-- refuses the event and says how to supply it.
local function resolve_ai_agent_identity(conf, request_key)
    local agent_id, session_id

    local agent_header = non_empty_string(conf.agent_id_header)
    if agent_header then
        agent_id = non_empty_string(kong.response.get_header(agent_header))
    end
    agent_id = agent_id or non_empty_string(conf.agent_id)

    local session_header = non_empty_string(conf.session_id_header)
    if session_header then
        session_id = non_empty_string(kong.response.get_header(session_header))
    end
    session_id = session_id or request_key

    return agent_id, session_id
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
-- concurrent flushes in different workers take disjoint events: nothing is sent
-- twice and nothing is lost between a read and a delete.
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
--
-- Ordering: failed events are older than anything buffered during the
-- attempt, so they go in front. On overflow we keep the OLDEST and drop the
-- newest, because the oldest are the ones closest to falling outside the
-- ingestor's 90-day occurredAt acceptance window -- and losing recent events
-- is recoverable from upstream logs far more often than losing old ones.
local function rebuffer(dict, batch)
    local dropped = 0
    for i = #batch, 1, -1 do
        local len, err = dict:lpush(BUFFER_KEY, batch[i])
        if not len then
            -- Only "no memory" in practice: the dict is full. The events
            -- further down this loop are newer, so this is still "drop newest".
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
-- See the drop-on-rejection comment in send_batch for why these are not retried.
local function is_permanent_rejection(status)
    return status ~= nil and status >= 400 and status < 500
        and status ~= 408 and status ~= 429
end

-- POST one batch. Returns "sent", "rejected" (permanent -- dropped, do not
-- retry) or "failed" (transient -- the caller keeps the events).
local function send_batch(conf, batch)
    local httpc = http.new()
    httpc:set_timeout(10000)

    -- Each element is already a JSON-encoded event, so the body is assembled
    -- rather than decoded and re-encoded: cheaper, and the bytes sent are
    -- exactly the bytes buffered.
    local body = '{"events":[' .. table.concat(batch, ",") .. ']}'

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
            kong.log.info("[aforo-metering] Flushed ", #batch, " events to Aforo (status=", res.status, ")")
            return "sent"
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

        -- A permanent rejection (see below) gets the same answer on every
        -- attempt, so stop here rather than sleeping through two more of them
        -- -- which, with a backlog drained in slices, would hold every slice
        -- behind it for 3s per rejected batch.
        if is_permanent_rejection(last_status) then
            break
        end

        if attempt < max_retries then
            local wait = math.pow(2, attempt - 1)
            -- Honour the ingestor's Retry-After on 429 (delta-seconds form).
            -- Longer than MAX_RETRY_AFTER_SECONDS: stop here and let the
            -- caller re-buffer, rather than sleep through the flush.
            if last_status == 429 then
                local ra = res.headers and tonumber(res.headers["Retry-After"]
                    or res.headers["retry-after"])
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
    if is_permanent_rejection(last_status) then
        kong.log.err("[aforo-metering] Ingestor rejected the batch with ", last_status,
            " -- dropping ", #batch, " event(s) rather than retrying them forever. ",
            "Response: ", string.sub(tostring(last_body or ""), 1, 500))
        return "rejected"
    end

    return "failed"
end

local function flush_buffer(premature, conf)
    if premature then return end

    local dict = ngx.shared[BUFFER_DICT]
    if not dict then
        kong.log.err("[aforo-metering] Shared dict '", BUFFER_DICT, "' not found")
        return
    end

    -- Drain in slices of MAX_BATCH_SIZE. Bounded so one flush cannot chase a
    -- buffer that live traffic refills as fast as it drains; whatever is left
    -- is picked up by the flush the next buffered event schedules.
    for _ = 1, math.ceil(MAX_BUFFER_SIZE / MAX_BATCH_SIZE) do
        local batch = pop_batch(dict, MAX_BATCH_SIZE)
        if #batch == 0 then return end

        local outcome = send_batch(conf, batch)

        if outcome == "failed" then
            -- Re-buffer transient failures (2026-09-01 fix).
            -- The events were taken off the buffer before the first attempt, so
            -- an ingestor outage outlasting 3 retries used to destroy the only
            -- copy of them: unbilled usage, no dead-letter, nothing to
            -- reconstruct from. Push them back so a later flush retries them,
            -- and stop draining -- the next slice would only fail the same way.
            local dropped = rebuffer(dict, batch)
            if dropped > 0 then
                kong.log.err("[aforo-metering] All flush attempts failed. ",
                    #batch, " events re-buffered for retry; ", dropped,
                    " dropped (buffer at MAX_BUFFER_SIZE=", MAX_BUFFER_SIZE,
                    "). Raise lua_shared_dict aforo_buffer if this recurs.")
            else
                kong.log.err("[aforo-metering] All flush attempts failed. ",
                    #batch, " events re-buffered for retry on the next flush.")
            end
            return
        end

        if #batch < MAX_BATCH_SIZE then return end
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
    if rate_limit.enforce(conf) then
        return
    end

    -- resolve_customer_id() prefers the JWT-validated claim stashed above;
    -- falls back to Kong consumer identity (credential-bound). Never reads
    -- request headers or query params — those sources were removed 2026-04-23.
    local consumer = kong.client.get_consumer()
    local customer_id = resolve_customer_id(conf, consumer)

    -- Pre-flight quota check against the ingestor (2026-09-21). The module was
    -- written and packaged in the rockspec but never called, so quotas and
    -- prepaid wallets were enforced only after the fact, at ingest -- by which
    -- point the upstream had already served the request. Off unless
    -- preflight_quota_enabled; fail-open; see preflight-quota.lua.
    --
    -- The metric is resolved the same way the log phase will bill it, minus
    -- the upstream response header, which does not exist yet.
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
    local request_size = raw_body and #raw_body
        or tonumber(kong.request.get_header("Content-Length")) or 0
    local response_size = tonumber(kong.response.get_header("Content-Length")) or 0
    -- Never a request header: see kong_request_id.
    local request_id = kong_request_id()
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

    -- productType on every event (conf.product_type, default "API").
    local product_type = normalize_product_type(conf.product_type)

    -- Build usage event
    local event = {}
    event.productType = product_type

    if mcp_info then
        event.customerId     = customer_id
        event.metricName     = "mcp_server.tool_invocations"
        event.quantity       = 1
        event.idempotencyKey = "mcp:" .. (conf.tenant_id or "") .. ":" ..
                               request_id .. ":" ..
                               mcp_info.tool_name .. ":" .. tostring(ngx.now())
        event.occurredAt     = iso8601_utc(ngx.now())
        event.toolName       = mcp_info.tool_name
        event.agentId        = mcp_info.agent_id or headers["x-agent-id"]
        event.sessionId      = session_id
        event.executionStatus = (status >= 200 and status < 300) and "SUCCESS" or "ERROR"
        event.executionDurationMs = tonumber(latency) or 0
        -- MCP_SERVER requires toolName AND agentId. Classify the tool call as
        -- MCP_SERVER only when both are known; otherwise keep the configured
        -- product_type rather than send an event the ingestor must reject.
        if event.toolName and event.toolName ~= ""
            and event.agentId and event.agentId ~= "" then
            event.productType = "MCP_SERVER"
        end
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
        event.idempotencyKey = request_id
        event.occurredAt     = iso8601_utc(ngx.now())
        -- AI_AGENT only. Other types do not define these fields, so they are
        -- left off rather than sent on every API call. The idempotency key is
        -- Kong's own request ID, so it doubles as the per-request session
        -- fallback.
        if event.productType == "AI_AGENT" then
            event.agentId, event.sessionId =
                resolve_ai_agent_identity(conf, event.idempotencyKey)
        end
    end

    -- quantity must be > 0 (e.g. quantity_source=response_size with an empty
    -- body); one such event would fail the whole batch.
    if type(event.quantity) ~= "number" or event.quantity <= 0 then
        kong.log.debug("[aforo-metering] Skipping ", method, " ", path,
            " -- quantity is not > 0.")
        return
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

    -- Refuse to buffer an event its productType makes invalid, for the same
    -- reason as the customerId skip above: one such event fails its batch.
    local missing = missing_required_fields(event)
    if missing then
        -- Name the fix where there is one. Off the MCP path an AI_AGENT
        -- agentId has exactly two sources, both in the operator's hands;
        -- sessionId always has its Kong request-ID fallback, so it is never
        -- the gap.
        local fix = ""
        if not mcp_info and event.productType == "AI_AGENT" and not event.agentId then
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
            ": ", enc_err, ". Event not metered.")
        return
    end

    -- One atomic append; the returned length is this event's position, so it
    -- doubles as the count that drives flush scheduling below without a
    -- separate counter that could drift from the list.
    local count, push_err = dict:rpush(BUFFER_KEY, encoded)
    if not count then
        kong.log.err("[aforo-metering] Could not buffer event (", push_err, "). ",
            "Raise lua_shared_dict aforo_buffer if this recurs. Event not metered.")
        return
    end

    if count > MAX_BUFFER_SIZE then
        -- Over the cap: take one event back off the tail. That is this event or
        -- one a concurrent worker appended a moment later -- either way the
        -- newest, so the oldest (closest to the ingestor's acceptance window)
        -- are the ones kept, matching the re-buffer rule in flush_buffer.
        dict:rpop(BUFFER_KEY)
        warn_throttled("buffer_overflow", 10,
            "[aforo-metering] Buffer full (", MAX_BUFFER_SIZE, " events) -- dropping the ",
            "newest event. The ingestor is failing or unreachable; see the flush errors. ",
            "Repeats suppressed for 10s.")
        -- Keep a flush coming. Previously an overflow returned without
        -- scheduling one, so once the buffer was full and the last flush had
        -- re-buffered, nothing ever flushed again even after the ingestor
        -- recovered -- every new event was dropped at this line. add() limits
        -- it to one attempt per second across workers rather than one per request.
        if dict:add("aforo:overflow_flush", 1, 1) then
            ngx.timer.at(0, flush_buffer, conf)
        end
        return
    end

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
AforoMeteringHandler._flush_buffer = flush_buffer

return AforoMeteringHandler
