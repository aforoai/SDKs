-- Aforo Rate Limit Enforcement for Kong Gateway
-- Runs in the `access` phase (before proxying to upstream).
-- Reads rate-limit policy from Redis (populated by pricing-service cache warmer).
-- Uses sliding-window counters in Redis for accurate request counting.
--
-- Redis key conventions (shared with usage-ingestor Spring filter):
--   Policy:  ratelimit:policy:{tenantId}:{apiKeyHash}  (JSON, TTL 90s; apiKeyHash =
--            lowercase SHA-256 hex of the raw API key, pricing's ApiKey.keyHash)
--   Counter: ratelimit:count:{tenantId}:{scope}:{windowSeconds}:{epochWindow}
--
-- Fail-open: if Redis is unavailable, or anything in the check fails, requests
-- pass through.

local cjson = require("cjson.safe")

local M = {}

-- The plugin's one shared dict (see handler.lua), used here only to throttle logs.
local BUFFER_DICT = "aforo_buffer"

-- ── Redis helpers ───────────────────────────────────────────

local function get_redis(conf)
    local redis = require("resty.redis")
    local red = redis:new()
    red:set_timeout(conf.rate_limit_redis_timeout_ms or 50)

    local ok, err = red:connect(
        conf.rate_limit_redis_host or "127.0.0.1",
        conf.rate_limit_redis_port or 6379
    )
    if not ok then
        return nil, err
    end

    local password = conf.rate_limit_redis_password
    if password and password ~= "" then
        local auth_ok, auth_err = red:auth(password)
        if not auth_ok then
            return nil, auth_err
        end
    end

    return red
end

local function close_redis(red)
    if red then
        red:set_keepalive(10000, 100)
    end
end

-- Throttled log line (once per ttl seconds across workers; ttl 0 = once until
-- the dict is flushed). The check runs on every request, so an unthrottled
-- warning would log on every request.
local function log_throttled(level, key, ttl, ...)
    local dict = ngx.shared[BUFFER_DICT]
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

-- The raw API key this request authenticated with, or (nil, "jwt").
--
-- Pricing keys policies by ApiKey.keyHash: the lowercase SHA-256 hex of the
-- raw sk_live_/sk_test_ key. So the hash has to be taken over that key.
--   1. key-auth: the credential Kong authenticated -- its .key is the raw key.
--      Before 2026-10-12 this traffic was never looked up at all.
--   2. Authorization: Bearer <raw key>. The scheme is matched case-
--      insensitively: matching only "Bearer" let "bearer" skip a HARD limit.
-- A Bearer JWT is not a key, and its hash matches no policy. Pricing would
-- have to index policies by the token's key_id for these to be limited; until
-- then they are not, and that is said once in the log rather than silently.
local function request_api_key()
    local ok, cred = pcall(kong.client.get_credential)
    if ok and type(cred) == "table" and type(cred.key) == "string" and cred.key ~= "" then
        return cred.key
    end

    local auth = kong.request.get_header("Authorization")
    if type(auth) ~= "string" then return nil end
    local token = string.match(auth, "^[Bb][Ee][Aa][Rr][Ee][Rr]%s+(.+)$")
    if not token then return nil end

    if (kong.ctx.shared and kong.ctx.shared.aforo_jwt_claims)
        or string.find(token, "^[%w_-]+%.[%w_-]+%.[%w_-]*$") then
        return nil, "jwt"
    end
    return token
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
local function enforce(conf)
    local tenant_id = conf.tenant_id
    if not tenant_id or tenant_id == "" then return false end

    local api_key, why = request_api_key()
    if not api_key then
        if why == "jwt" then
            log_throttled("warn", "rl_jwt", 0,
                "[aforo-ratelimit] Rate limiting is not applied to JWT-authenticated requests yet: ",
                "Aforo's rate-limit policies are keyed by API key, and a JWT carries only the key's ",
                "id. These requests pass without a rate-limit check. (Logged once.)")
        end
        return false
    end

    -- Hash the key for the Redis lookup: SHA-256, lowercase hex, as pricing's
    -- ApiKeyServiceImpl computes keyHash.
    local sha256 = require("resty.sha256")
    local str_util = require("resty.string")
    local hasher = sha256:new()
    hasher:update(api_key)
    local key_hash = str_util.to_hex(hasher:final())

    -- Connect to Redis
    local red, err = get_redis(conf)
    if not red then
        log_throttled("warn", "rl_redis", 60, "[aforo-ratelimit] Redis connect failed: ", tostring(err),
            " -- fail-open, rate limits are NOT enforced. Repeats suppressed for 60s.")
        return false
    end

    -- Look up policy
    local policy_key = "ratelimit:policy:" .. tenant_id .. ":" .. key_hash
    local policy_json, redis_err = red:get(policy_key)
    if policy_json == false or policy_json == nil then
        -- An error reply (NOAUTH, LOADING, ...) or a dropped connection.
        close_redis(red)
        log_throttled("warn", "rl_redis_reply", 60, "[aforo-ratelimit] Redis answered the policy ",
            "lookup with an error (", tostring(redis_err), ") -- fail-open, rate limits are NOT ",
            "enforced. Repeats suppressed for 60s.")
        return false
    end
    if policy_json == ngx.null then
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
    -- PER_CUSTOMER scope: sources customer identity EXCLUSIVELY from the
    -- JWT-validated claim stashed in kong.ctx.shared.aforo_jwt_claims by
    -- the access-phase JWT validator. NEVER read X-Customer-Id from the
    -- request header — it is client-settable and therefore spoofable,
    -- which previously allowed cross-customer rate-limit bypass (IDOR
    -- advisory finding #7). Closed 2026-04-23.
    --
    -- Without a JWT claim, PER_CUSTOMER uses the Kong consumer -- the same
    -- credential-bound identity the plugin bills (handler.lua's
    -- resolve_customer_id: custom_id, then username, then id). It used to
    -- fall back to the key hash straight away, so a customer with N key-auth
    -- keys got N times its PER_CUSTOMER limit (2026-10-13 fix). Only with no
    -- customer identity at all does it narrow to the key, which is
    -- authenticated; it never falls back to an unauthenticated source.
    local scope_id
    if scope_key == "PER_CUSTOMER" then
        local jwt_claims = kong.ctx.shared and kong.ctx.shared.aforo_jwt_claims
        local jwt_customer = jwt_claims and jwt_claims.customer_id
        local consumer = kong.client.get_consumer()
        local consumer_id = consumer and (consumer.custom_id or consumer.username or consumer.id)
        if type(jwt_customer) == "string" and jwt_customer ~= "" then
            scope_id = jwt_customer
        elseif type(consumer_id) == "string" and consumer_id ~= "" then
            scope_id = consumer_id
        else
            scope_id = key_hash
        end
    elseif scope_key == "PER_APP" then
        local consumer = kong.client.get_consumer()
        scope_id = consumer and (consumer.custom_id or consumer.username) or key_hash
    else
        scope_id = key_hash -- PER_KEY default
    end

    local now = ngx.time()
    local exceeded = false
    local retry_after = 0
    local limit_value = 0
    local remaining_value = 0
    local reset_value = 0

    for _, tier in ipairs(policy_tiers(policy)) do
        local window = tier.window
        local max_requests = tier.max
        local effective_max = max_requests + tier.burst

        local epoch_window = math.floor(now / window)
        local counter_key = "ratelimit:count:" .. tenant_id .. ":" .. scope_id
            .. ":" .. tostring(window) .. ":" .. tostring(epoch_window)

        -- INCR + conditional EXPIRE (atomic via pipeline)
        red:init_pipeline()
        red:incr(counter_key)
        red:expire(counter_key, window + 10) -- TTL = window + grace
        local results = red:commit_pipeline()

        local count = 0
        if results and results[1] then
            count = tonumber(results[1]) or 0
        end

        -- Track the per-minute tier for response headers
        if window == 60 then
            limit_value = max_requests
            remaining_value = math.max(0, effective_max - count)
            reset_value = (epoch_window + 1) * window - now
        end

        if count > effective_max then
            exceeded = true
            retry_after = math.max(retry_after, (epoch_window + 1) * window - now)
        end
    end

    close_redis(red)

    -- Always set rate limit headers
    kong.response.set_header("X-RateLimit-Limit", tostring(limit_value))
    kong.response.set_header("X-RateLimit-Remaining", tostring(remaining_value))
    kong.response.set_header("X-RateLimit-Reset", tostring(reset_value))
    kong.response.set_header("X-RateLimit-Policy", policy_name)

    if exceeded then
        if enforcement_mode == "HARD" then
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
function M.enforce(conf)
    if not conf.rate_limit_enabled then return false end
    local ok, refused = pcall(enforce, conf)
    if not ok then
        log_throttled("err", "rl_error", 60, "[aforo-ratelimit] Rate-limit check failed (",
            tostring(refused), ") -- fail-open, request allowed. Repeats suppressed for 60s.")
        return false
    end
    return refused == true
end

return M
