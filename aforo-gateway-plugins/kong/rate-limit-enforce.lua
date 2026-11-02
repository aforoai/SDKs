-- Aforo Rate Limit Enforcement for Kong Gateway
-- Runs in the `access` phase (before proxying to upstream).
-- Reads rate-limit policy from Redis (populated by pricing-service cache warmer).
--
-- Algorithm: sliding-window counter (2.7.0, G329), the approach Kong's
-- rate-limiting-advanced and Cloudflare use. Each tier keeps one counter per
-- fixed window; a request is counted as
--     previous_window_count * (time left in the current window / window)
--   + current_window_count + 1
-- which approximates a true sliding window to within a few percent and stops
-- the 2x burst a plain fixed window allows across its edge. Before 2.7.0 the
-- header said "sliding window" but the code was a fixed window.
--
-- A refused request (HARD mode) is not counted; SOFT mode counts every request.
--
-- Redis key conventions (shared with usage-ingestor Spring filter):
--   Policy:  ratelimit:policy:{tenantId}:{apiKeyHash}  (JSON, TTL 90s; apiKeyHash =
--            lowercase SHA-256 hex of the raw API key, pricing's ApiKey.keyHash)
--            ratelimit:policy:{tenantId}:keyid:{keyId}  (2.7.0, G328: the same
--            JSON indexed by the API key's id, for requests that carry a
--            verified JWT; the token names the key by its key_id claim)
--   Counter: ratelimit:count:{tenantId}:{scope}:{windowSeconds}:{epochWindow}
--            (TTL 2 x window + 10s, so the previous window is still there)
--
-- Round trips (2.7.0, G330): AUTH only on a new connection, never on a pooled
-- one; all tiers checked and counted in one EVALSHA (EVAL when Redis does not
-- have the script yet); the policy cached in the aforo_cache shared dict for
-- POLICY_CACHE_TTL seconds. Steady state: one round trip per request.
--
-- Fail-open: if Redis is unavailable, or anything in the check fails, requests
-- pass through.

local cjson = require("cjson.safe")
local unpack = unpack or table.unpack  -- luacheck: ignore 143

local M = {}

-- Installed: kong.plugins.aforo-metering.<name>. From the source tree
-- (busted): the bare filename. Same fallback as handler.lua.
local function require_sibling(name)
    local ok, mod = pcall(require, "kong.plugins.aforo-metering." .. name)
    if ok then return mod end
    return require(name)
end
local event_util = require_sibling("event-util")
local redis_util = require_sibling("redis-util")

-- Log throttles and the policy cache live in aforo_cache (2.8.0, G323);
-- event_util.cache_dict() falls back to aforo_buffer when it is not declared.

-- Seconds a policy (or "no policy" for an authenticated key) is cached per
-- worker group. Pricing rewrites policies every 30s with a 90s TTL, so a
-- change reaches the gateway within ~35s instead of ~30s.
local POLICY_CACHE_TTL = 5
local POLICY_CACHE_PREFIX = "aforo:rl:policy:"
local NO_POLICY = ""  -- cached marker: this key has no policy

-- ── Sliding-window check, run inside Redis ──────────────────
--
-- KEYS[2i-1] = tier i's current-window counter, KEYS[2i] = its previous one.
-- ARGV[1] = now (seconds, fractional), ARGV[2] = "1" when a refused request
-- must not be counted (HARD), ARGV[1+2i] = tier i's window (seconds),
-- ARGV[2+2i] = tier i's limit including burst.
-- Returns { allowed (1/0), then per tier: ceil(estimate incl. this request),
-- ceil(seconds until one more request fits, 0 if it fits now),
-- ceil(seconds until the current window ends) }.
local SLIDING_WINDOW_SCRIPT = [[
local now = tonumber(ARGV[1])
local hard = ARGV[2] == "1"
local n = #KEYS / 2
local est, wait, roll = {}, {}, {}
local allowed = 1
for i = 1, n do
  local w = tonumber(ARGV[1 + 2 * i])
  local max = tonumber(ARGV[2 + 2 * i])
  local cur = tonumber(redis.call("GET", KEYS[2 * i - 1]) or "0") or 0
  local prev = tonumber(redis.call("GET", KEYS[2 * i]) or "0") or 0
  local elapsed = now - math.floor(now / w) * w
  local e = prev * (w - elapsed) / w + cur + 1
  est[i] = e
  roll[i] = w - elapsed
  wait[i] = 0
  if e > max then
    allowed = 0
    if max < 1 then
      wait[i] = w
    elseif cur + 1 <= max then
      -- Fits once enough of the previous window has aged out.
      wait[i] = w * (1 - (max - cur - 1) / prev) - elapsed
    else
      -- Not in this window: in the next one, this window becomes "previous".
      local x = w * (1 - (max - 1) / cur)
      if x < 0 then x = 0 end
      wait[i] = (w - elapsed) + x
    end
    if wait[i] < 0 then wait[i] = 0 end
  end
end
if allowed == 1 or not hard then
  for i = 1, n do
    local w = tonumber(ARGV[1 + 2 * i])
    redis.call("INCR", KEYS[2 * i - 1])
    redis.call("EXPIRE", KEYS[2 * i - 1], 2 * w + 10)
  end
end
local out = { allowed }
for i = 1, n do
  out[#out + 1] = math.ceil(est[i])
  out[#out + 1] = math.ceil(wait[i])
  out[#out + 1] = math.ceil(roll[i])
end
return out
]]

local script_sha  -- nil = not computed yet; false = no ngx.sha1_bin, use EVAL

local function sliding_window_sha()
    if script_sha == nil then
        script_sha = false
        if ngx.sha1_bin then
            local ok, bin = pcall(ngx.sha1_bin, SLIDING_WINDOW_SCRIPT)
            if ok and bin then
                script_sha = require("resty.string").to_hex(bin)
            end
        end
    end
    return script_sha or nil
end

-- ── Redis helpers ───────────────────────────────────────────

-- Connection, TLS, pooling and AUTH-once: redis-util.lua (2.8.0 adds TLS:
-- rate_limit_redis_ssl / _ssl_verify / _server_name).
local function get_redis(conf)
    return redis_util.connect({
        host        = conf.rate_limit_redis_host or "127.0.0.1",
        port        = conf.rate_limit_redis_port or 6379,
        password    = conf.rate_limit_redis_password,
        timeout_ms  = conf.rate_limit_redis_timeout_ms or 50,
        ssl         = conf.rate_limit_redis_ssl == true,
        ssl_verify  = conf.rate_limit_redis_ssl_verify,
        server_name = conf.rate_limit_redis_server_name,
    })
end

local close_redis = redis_util.release
local discard_redis = redis_util.discard

-- Throttled log line (once per ttl seconds across workers; ttl 0 = once until
-- the dict is flushed). The check runs on every request, so an unthrottled
-- warning would log on every request.
local function log_throttled(level, key, ttl, ...)
    local dict = event_util.cache_dict()
    if dict and not dict:safe_add("aforo:warn:" .. key, 1, ttl) then return end
    kong.log[level](...)
end

-- Policy values as pricing's cache warmer writes them (Jackson). Any field
-- may be JSON null -- "tiers":null for a RATE_PLAN_OVERRIDE, a null
-- burstCapacity, maxRph or policyName -- and null decodes to the cjson.null
-- userdata, which is truthy: ipairs() over it or arithmetic on it raised, and
-- every request through the route answered 500 (2026-10-12 fix).
local function opt(v)
    if v == cjson.null then return nil end
    return v
end
local function num(v)
    v = opt(v)
    return type(v) == "number" and v or nil
end
local function str(v)
    v = opt(v)
    if type(v) == "string" and v ~= "" then return v end
    if type(v) == "number" then return tostring(v) end
    return nil
end

-- Who this request is, for the policy lookup and the PER_KEY counter.
--
-- Returns a table { lookup = <policy key suffix>, key_scope = <PER_KEY
-- counter id>, authenticated = bool } or (nil, why).
--
--   1. A verified JWT's key_id (2.7.0, G328). `identity.key_id` is passed by
--      the handler, which takes it only from a token whose signature was
--      verified: by this plugin (jwt_validation_enabled) or by Kong's jwt
--      plugin. The policy is looked up under keyid:{keyId} and the counter is
--      the key's, so a token refresh keeps the same counter. Before 2.7.0 a
--      JWT request was not rate limited at all (2.6.0) or was looked up by
--      the SHA-256 of the token bytes, which matched no policy and changed on
--      every refresh. Claims of a token nothing verified
--      (jwt_allow_unverified_signature) are never used.
--   2. key-auth: the credential Kong authenticated -- its .key is the raw key.
--      Skipped when Kong's jwt plugin verified the token and for any
--      credential that is a jwt_secrets row: there .key is the shared issuer
--      key, not the caller's key. A request whose token this plugin verified
--      (jwt_validation_enabled) without key_id still uses a key-auth
--      credential when it has one. A JWT request left without a key is not
--      rate limited and the "jwt without key_id" warning is logged.
--   3. Authorization: Bearer <raw key>. The scheme is matched case-
--      insensitively: matching only "Bearer" let "bearer" skip a HARD limit.
-- For 2 and 3 the policy is looked up by the lowercase SHA-256 hex of the
-- raw key, which is pricing's ApiKey.keyHash.
local function key_hash_of(raw)
    local sha256 = require("resty.sha256")
    local str_util = require("resty.string")
    local hasher = sha256:new()
    hasher:update(raw)
    return str_util.to_hex(hasher:final())
end

-- A key-auth credential row: a .key and none of the jwt_secrets fields
-- (secret, algorithm, rsa_public_key). Only its .key is a raw API key.
local function is_key_auth_credential(cred)
    if type(cred) ~= "table" or type(cred.key) ~= "string" or cred.key == "" then return false end
    return cred.secret == nil and cred.algorithm == nil and cred.rsa_public_key == nil
end

local function request_identity(identity)
    local key_id = identity and identity.key_id
    if type(key_id) == "string" and key_id ~= "" then
        return { lookup = "keyid:" .. key_id, key_scope = "keyid:" .. key_id,
                 authenticated = true }
    end

    -- A token Kong's jwt plugin verified, without key_id: never fall through
    -- to the credential. On a Kong-jwt route kong.client.get_credential() is
    -- the jwt_secrets row, whose .key is the issuer key every caller of that
    -- issuer shares, so its hash would put all of them on one counter (and
    -- match no policy).
    local shared = kong.ctx.shared
    if shared and shared.authenticated_jwt_token then
        return nil, "jwt"
    end

    -- This plugin's own verified JWT (jwt_validation_enabled) without key_id:
    -- a key-auth credential on the same request is still the caller's key, so
    -- it is limited by that key. Without one the request is not rate limited.
    local claims = shared and shared.aforo_jwt_claims
    local own_verified_jwt = type(claims) == "table" and claims.signature_verified == true

    local ok, cred = pcall(kong.client.get_credential)
    if ok and is_key_auth_credential(cred) then
        local h = key_hash_of(cred.key)
        return { lookup = h, key_scope = h, authenticated = true }
    end
    if own_verified_jwt then
        return nil, "jwt"
    end

    local auth = kong.request.get_header("Authorization")
    if type(auth) ~= "string" then return nil end
    local token = string.match(auth, "^[Bb][Ee][Aa][Rr][Ee][Rr]%s+(.+)$")
    if not token then return nil end

    if (kong.ctx.shared and kong.ctx.shared.aforo_jwt_claims)
        or string.find(token, "^[%w_-]+%.[%w_-]+%.[%w_-]*$") then
        return nil, "jwt"
    end
    -- A raw key nothing on this gateway has checked: its policy is looked up,
    -- but "no policy" is not cached, so random values cannot fill the dict.
    local h = key_hash_of(token)
    return { lookup = h, key_scope = h, authenticated = false }
end

-- The policy JSON for policy_key: from the shared dict when cached, else from
-- Redis (and cached). Returns (json, nil) with json = nil for "no policy", or
-- (nil, err) when Redis answered with an error.
local function load_policy(red, policy_key, cacheable_miss)
    local dict = event_util.cache_dict()
    local cache_key = POLICY_CACHE_PREFIX .. policy_key
    if dict then
        local cached = dict:get(cache_key)
        if cached == NO_POLICY then return nil end
        if type(cached) == "string" then return cached end
    end

    local policy_json, redis_err = red:get(policy_key)
    if policy_json == false or policy_json == nil then
        return nil, redis_err or "no reply"
    end
    if policy_json == ngx.null then
        if dict and cacheable_miss then
            dict:safe_set(cache_key, NO_POLICY, POLICY_CACHE_TTL)
        end
        return nil
    end
    if dict then
        -- safe_set: never evict buffered events to make room for a cache entry.
        dict:safe_set(cache_key, policy_json, POLICY_CACHE_TTL)
    end
    return policy_json
end

-- The tiers to enforce: policy.tiers when it is a list, else the flat
-- maxRpm / maxRph. A tier without a numeric maxRequests is skipped -- it used
-- to default to 0, which a HARD policy enforced as "refuse everything".
local function policy_tiers(policy)
    local raw = opt(policy.tiers)
    local tiers = {}
    if type(raw) == "table" then
        for _, t in ipairs(raw) do
            if type(t) == "table" then
                local window = num(t.windowSeconds) or 60
                local max_requests = num(t.maxRequests)
                if window > 0 and max_requests then
                    tiers[#tiers + 1] = { window = window, max = max_requests,
                                          burst = num(t.burstCapacity) or 0 }
                end
            end
        end
        return tiers
    end

    local rpm, rph = num(policy.maxRpm), num(policy.maxRph)
    if rpm and rpm > 0 then
        tiers[#tiers + 1] = { window = 60, max = rpm, burst = num(policy.burstCapacity) or 0 }
    end
    if rph and rph > 0 then
        tiers[#tiers + 1] = { window = 3600, max = rph, burst = 0 }
    end
    return tiers
end

-- ── Access phase handler ────────────────────────────────────

-- Returns true when it answered the request (429).
local function enforce(conf, identity)
    local tenant_id = conf.tenant_id
    if not tenant_id or tenant_id == "" then return false end

    local who, why = request_identity(identity)
    if not who then
        if why == "jwt" then
            log_throttled("warn", "rl_jwt", 0,
                "[aforo-ratelimit] A JWT request without a verified key_id is not rate limited: ",
                "policies are found by the API key's id, which only a verified token can name. ",
                "Verify the token (jwt_validation_enabled with jwt_public_key / jwt_jwks_uri, or ",
                "Kong's jwt plugin) and make sure it carries key_id. (Logged once.)")
        end
        return false
    end

    -- Connect to Redis
    local red, err = get_redis(conf)
    if not red then
        log_throttled("warn", "rl_redis", 60, "[aforo-ratelimit] Redis unavailable (", tostring(err), ")",
            " -- fail-open, rate limits are NOT enforced. Repeats suppressed for 60s.")
        return false
    end

    -- Look up policy
    local policy_key = "ratelimit:policy:" .. tenant_id .. ":" .. who.lookup
    local policy_json, redis_err = load_policy(red, policy_key, who.authenticated)
    if redis_err then
        -- An error reply (NOAUTH, LOADING, ...) or a dropped connection.
        discard_redis(red)
        log_throttled("warn", "rl_redis_reply", 60, "[aforo-ratelimit] Redis answered the policy ",
            "lookup with an error (", tostring(redis_err), ") -- fail-open, rate limits are NOT ",
            "enforced. Repeats suppressed for 60s.")
        return false
    end
    if not policy_json then
        close_redis(red)
        return false -- No policy = no limit
    end

    local policy = cjson.decode(policy_json)
    if type(policy) ~= "table" then
        close_redis(red)
        log_throttled("warn", "rl_policy_json", 60,
            "[aforo-ratelimit] Failed to parse policy JSON -- fail-open. Repeats suppressed for 60s.")
        return false
    end

    local enforcement_mode = str(policy.enforcementMode) or "SOFT"
    local policy_name = str(policy.policyName) or str(policy.ratePlanId) or "unknown"
    local scope_key = str(policy.scope) or "PER_KEY"

    -- Resolve scope identifier.
    --
    -- PER_CUSTOMER never reads X-Customer-Id or any other request header --
    -- it is client-settable and therefore spoofable, which previously allowed
    -- cross-customer rate-limit bypass (IDOR advisory finding #7, closed
    -- 2026-04-23).
    --
    -- When the handler passes `identity`, PER_CUSTOMER uses
    -- identity.customer_id: the handler's resolve_customer_id, the same
    -- verified identity the plugin bills (verified JWT claim, else the Kong
    -- consumer -- but never the consumer on a Kong-jwt route, where it is the
    -- token issuer shared by every caller). Without `identity` (direct
    -- callers), a verified Aforo JWT's customer_id, else the Kong consumer.
    -- It used to fall back to the key straight away, so a customer with N
    -- key-auth keys got N times its PER_CUSTOMER limit (2026-10-13 fix). Only
    -- with no customer identity at all does it narrow to the key, which is
    -- authenticated; it never falls back to an unauthenticated source.
    --
    -- PER_APP: an Aforo key belongs to one app or agent, so a request
    -- identified by a verified JWT's key_id counts against that key. Otherwise
    -- the Kong consumer, as before.
    local scope_id
    if scope_key == "PER_CUSTOMER" then
        local customer
        if identity then
            customer = identity.customer_id
        else
            local jwt_claims = kong.ctx.shared and kong.ctx.shared.aforo_jwt_claims
            if type(jwt_claims) == "table" and jwt_claims.signature_verified == true then
                customer = jwt_claims.customer_id
            end
            if type(customer) ~= "string" or customer == "" then
                local consumer = kong.client.get_consumer()
                customer = consumer and (consumer.custom_id or consumer.username or consumer.id)
            end
        end
        if type(customer) == "string" and customer ~= "" then
            scope_id = customer
        else
            scope_id = who.key_scope
        end
    elseif scope_key == "PER_APP" then
        if identity and type(identity.key_id) == "string" and identity.key_id ~= "" then
            scope_id = who.key_scope
        else
            local consumer = kong.client.get_consumer()
            scope_id = consumer and (consumer.custom_id or consumer.username) or who.key_scope
        end
    else
        scope_id = who.key_scope -- PER_KEY default
    end

    local tiers = policy_tiers(policy)
    if #tiers == 0 then
        close_redis(red)
        return false
    end

    local now = ngx.now()
    local hard = enforcement_mode == "HARD"
    local keys, argv = {}, { string.format("%.3f", now), hard and "1" or "0" }
    -- Every key of one evaluation carries the same Redis hash tag
    -- {tenant:scope}, so the script's keys sit in one slot. With it the check
    -- works on ElastiCache Serverless, a proxy that routes per command, or a
    -- single-shard Redis; without it EVALSHA was refused there with CROSSSLOT
    -- and failed open. MOVED is not followed: one node of a multi-shard
    -- classic cluster still fails open for keys on other shards.
    -- The tag always holds a ":", so it is never empty.
    local tag = "{" .. tenant_id .. ":" .. scope_id .. "}"
    for _, tier in ipairs(tiers) do
        local window = tier.window
        local epoch_window = math.floor(now / window)
        local base = "ratelimit:count:" .. tag .. ":" .. tostring(window) .. ":"
        keys[#keys + 1] = base .. tostring(epoch_window)
        keys[#keys + 1] = base .. tostring(epoch_window - 1)
        argv[#argv + 1] = tostring(window)
        argv[#argv + 1] = tostring(tier.max + tier.burst)
    end

    -- One argument list: keys then argv (unpack() in the middle of a call's
    -- arguments yields only its first value).
    local args = { #keys }
    for _, k in ipairs(keys) do args[#args + 1] = k end
    for _, a in ipairs(argv) do args[#args + 1] = a end

    local results, eval_err
    local sha = sliding_window_sha()
    if sha then
        results, eval_err = red:evalsha(sha, unpack(args))
        if not results and type(eval_err) == "string" and string.find(eval_err, "NOSCRIPT", 1, true) then
            results, eval_err = red:eval(SLIDING_WINDOW_SCRIPT, unpack(args))
        end
    else
        results, eval_err = red:eval(SLIDING_WINDOW_SCRIPT, unpack(args))
    end
    if type(results) ~= "table" then
        discard_redis(red)
        local reason = tostring(eval_err)
        if string.find(reason, "CROSSSLOT", 1, true) then
            log_throttled("err", "rl_crossslot", 60, "[aforo-ratelimit] Redis refused the rate-limit script with ",
                "CROSSSLOT (", reason, "): its keys are not in one hash slot. Rate limits, HARD ones included, ",
                "are NOT enforced (fail-open). Repeats suppressed for 60s.")
        else
            log_throttled("err", "rl_eval", 60, "[aforo-ratelimit] Redis refused the rate-limit script (",
                reason, ") -- fail-open, rate limits, HARD ones included, are NOT enforced. ",
                "Repeats suppressed for 60s.")
        end
        return false
    end
    close_redis(red)

    local exceeded = tonumber(results[1]) ~= 1
    local retry_after = 0
    local limit_value = 0
    local remaining_value = 0
    local reset_value = 0

    for i, tier in ipairs(tiers) do
        local estimate = tonumber(results[2 + (i - 1) * 3]) or 0
        local wait = tonumber(results[3 + (i - 1) * 3]) or 0
        local roll = tonumber(results[4 + (i - 1) * 3]) or 0
        local effective_max = tier.max + tier.burst

        -- Track the per-minute tier for response headers
        if tier.window == 60 then
            limit_value = tier.max
            remaining_value = math.max(0, math.floor(effective_max - estimate))
            -- With nothing left, Reset is when the next request fits; otherwise
            -- when the current window rolls over.
            reset_value = (wait > 0) and wait or roll
        end

        if wait > 0 then
            retry_after = math.max(retry_after, wait)
        end
    end

    -- Always set rate limit headers
    kong.response.set_header("X-RateLimit-Limit", tostring(limit_value))
    kong.response.set_header("X-RateLimit-Remaining", tostring(remaining_value))
    kong.response.set_header("X-RateLimit-Reset", tostring(reset_value))
    kong.response.set_header("X-RateLimit-Policy", policy_name)

    if exceeded then
        if retry_after < 1 then retry_after = 1 end
        if hard then
            kong.response.exit(429, {
                error = "rate_limit_exceeded",
                message = "Rate limit exceeded for policy: " .. policy_name,
                retryAfterSeconds = retry_after,
            }, {
                ["Retry-After"] = tostring(math.ceil(retry_after)),
                ["X-RateLimit-Policy"] = policy_name,
                ["Content-Type"] = "application/json",
            })
            return true
        else
            -- SOFT mode: log + warn header, do not reject
            kong.response.set_header("X-RateLimit-Warning", "limit-exceeded-soft-mode")
            kong.log.warn("[aforo-ratelimit] SOFT mode limit exceeded [policy=", policy_name,
                ", tenant=", tenant_id, "]")
        end
    end
    return false
end

-- Returns true when the request was answered (429), so the caller stops.
--
-- Fail-open on any error, not only on an unreachable Redis: whatever a policy
-- contains, a broken rate-limit check must never turn the customer's own API
-- into a 500. The error is logged (throttled) instead.
--
-- identity (optional, from the handler): { key_id = <verified JWT key_id or
-- nil>, customer_id = <verified customer or nil> }. See request_identity.
function M.enforce(conf, identity)
    if not conf.rate_limit_enabled then return false end
    local ok, refused = pcall(enforce, conf, identity)
    if not ok then
        log_throttled("err", "rl_error", 60, "[aforo-ratelimit] Rate-limit check failed (",
            tostring(refused), ") -- fail-open, request allowed. Repeats suppressed for 60s.")
        return false
    end
    return refused == true
end

-- For specs.
M._SLIDING_WINDOW_SCRIPT = SLIDING_WINDOW_SCRIPT
M._POLICY_CACHE_TTL = POLICY_CACHE_TTL

return M
