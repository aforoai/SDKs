-- Aforo Rate Limit Enforcement for Kong Gateway
-- Runs in the `access` phase (before proxying to upstream).
-- Reads rate-limit policy from Redis (populated by pricing-service cache warmer).
-- Uses sliding-window counters in Redis for accurate request counting.
--
-- Redis key conventions (shared with usage-ingestor Spring filter):
--   Policy:  ratelimit:policy:{tenantId}:{apiKeyHash}  (JSON, TTL 90s)
--   Counter: ratelimit:count:{tenantId}:{scope}:{windowSeconds}:{epochWindow}
--
-- Fail-open: if Redis is unavailable, requests pass through.

local cjson = require("cjson.safe")

local M = {}

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

-- ── Access phase handler ────────────────────────────────────

function M.enforce(conf)
    if not conf.rate_limit_enabled then return end

    local tenant_id = conf.tenant_id
    if not tenant_id or tenant_id == "" then return end

    -- Extract API key from Authorization header
    local auth_header = kong.request.get_header("Authorization")
    if not auth_header then return end

    local api_key = string.match(auth_header, "^Bearer%s+(.+)$")
    if not api_key then return end

    -- Hash the key for Redis lookup (first 16 chars of SHA-256)
    local sha256 = require("resty.sha256")
    local str = require("resty.string")
    local hasher = sha256:new()
    hasher:update(api_key)
    local key_hash = str.to_hex(hasher:final())

    -- Connect to Redis
    local red, err = get_redis(conf)
    if not red then
        kong.log.warn("[aforo-ratelimit] Redis connect failed: ", err, " → fail-open")
        return
    end

    -- Look up policy
    local policy_key = "ratelimit:policy:" .. tenant_id .. ":" .. key_hash
    local policy_json, redis_err = red:get(policy_key)
    if not policy_json or policy_json == ngx.null then
        close_redis(red)
        return -- No policy = no limit
    end

    local ok, policy = pcall(cjson.decode, policy_json)
    if not ok or not policy then
        close_redis(red)
        kong.log.warn("[aforo-ratelimit] Failed to parse policy JSON → fail-open")
        return
    end

    local enforcement_mode = policy.enforcementMode or "SOFT"
    local policy_name = policy.policyName or policy.ratePlanId or "unknown"
    local scope_key = policy.scope or "PER_KEY"

    -- Resolve scope identifier.
    --
    -- PER_CUSTOMER scope: sources customer identity EXCLUSIVELY from the
    -- JWT-validated claim stashed in kong.ctx.shared.aforo_jwt_claims by
    -- the access-phase JWT validator. NEVER read X-Customer-Id from the
    -- request header — it is client-settable and therefore spoofable,
    -- which previously allowed cross-customer rate-limit bypass (IDOR
    -- advisory finding #7). Closed 2026-04-23.
    --
    -- When JWT validation is disabled or the JWT carries no customer_id
    -- claim, PER_CUSTOMER falls back to key_hash (same behavior as
    -- PER_KEY). This is safe — the key is already authenticated, and
    -- the enforcement scope just becomes narrower (per-key instead of
    -- per-customer). It does NOT fall back to an unauthenticated source.
    local scope_id
    if scope_key == "PER_CUSTOMER" then
        local jwt_claims = kong.ctx.shared and kong.ctx.shared.aforo_jwt_claims
        local jwt_customer = jwt_claims and jwt_claims.customer_id
        if jwt_customer and jwt_customer ~= "" then
            scope_id = jwt_customer
        else
            scope_id = key_hash
        end
    elseif scope_key == "PER_APP" then
        local consumer = kong.client.get_consumer()
        scope_id = consumer and (consumer.custom_id or consumer.username) or key_hash
    else
        scope_id = key_hash -- PER_KEY default
    end

    -- Check each tier
    local tiers = policy.tiers
    if not tiers then
        -- Fall back to simple maxRpm/maxRph
        tiers = {}
        if policy.maxRpm and policy.maxRpm > 0 then
            table.insert(tiers, { windowSeconds = 60, maxRequests = policy.maxRpm, burstCapacity = policy.burstCapacity })
        end
        if policy.maxRph and policy.maxRph > 0 then
            table.insert(tiers, { windowSeconds = 3600, maxRequests = policy.maxRph })
        end
    end

    local now = ngx.time()
    local exceeded = false
    local retry_after = 0
    local limit_value = 0
    local remaining_value = 0
    local reset_value = 0

    for _, tier in ipairs(tiers) do
        local window = tier.windowSeconds or 60
        local max_requests = tier.maxRequests or 0
        local burst = tier.burstCapacity
        local effective_max = burst and (max_requests + burst) or max_requests

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
            return kong.response.exit(429, {
                error = "rate_limit_exceeded",
                message = "Rate limit exceeded for policy: " .. policy_name,
                retryAfterSeconds = retry_after,
            }, {
                ["Retry-After"] = tostring(math.ceil(retry_after)),
                ["X-RateLimit-Policy"] = policy_name,
                ["Content-Type"] = "application/json",
            })
        else
            -- SOFT mode: log + warn header, do not reject
            kong.response.set_header("X-RateLimit-Warning", "limit-exceeded-soft-mode")
            kong.log.warn("[aforo-ratelimit] SOFT mode limit exceeded [policy=", policy_name,
                ", tenant=", tenant_id, "]")
        end
    end
end

return M
