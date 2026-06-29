-- Aforo Pre-Flight Quota Check for Kong Gateway
-- Runs in the `access` phase (before proxying to backend).
-- Calls the usage-ingestor /api/v1/quota/check endpoint synchronously.
-- Fail-open: if the check times out or fails, the request proceeds.
--
-- Configuration (via kong.conf or declarative config):
--   preflight_enabled: boolean (default: false)
--   preflight_url: string (usage-ingestor quota check endpoint)
--   preflight_timeout_ms: integer (default: 50)
--   preflight_cache_ttl_ms: integer (default: 1000)
--   preflight_fallback: string ("ALLOW" or "DENY", default: "ALLOW")

local http = require("resty.http")
local cjson = require("cjson.safe")

local M = {}

local CACHE_DICT = "aforo_preflight_cache"

-- ── Access phase handler ────────────────────────────────────

function M.check(conf, customer_id, metric_name)
    if not conf.preflight_enabled then return end
    if not customer_id then return end

    local fallback = conf.preflight_fallback or "ALLOW"

    -- Check local cache first (ALLOW decisions only)
    local cache_key = "preflight:cache:" .. customer_id .. ":" .. (metric_name or "_all")
    local dict = ngx.shared[CACHE_DICT]
    if dict then
        local cached = dict:get(cache_key)
        if cached == "ALLOW" then
            return -- cached allow, proceed
        end
    end

    -- Call pre-flight endpoint
    local httpc = http.new()
    httpc:set_timeout(conf.preflight_timeout_ms or 50)

    local body = cjson.encode({
        customerId = customer_id,
        metricName = metric_name,
    })

    local res, err = httpc:request_uri(conf.preflight_url, {
        method = "POST",
        body = body,
        headers = {
            ["Content-Type"] = "application/json",
            ["X-Tenant-Id"] = conf.tenant_id,
        },
    })

    if not res then
        -- Timeout or connection failure → fall back
        kong.log.warn("[aforo-preflight] Check failed: ", err, " → fallback=", fallback)
        if fallback == "DENY" then
            return kong.response.exit(429, { message = "Service temporarily unavailable" })
        end
        return -- ALLOW fallback
    end

    if res.status ~= 200 then
        kong.log.warn("[aforo-preflight] Non-200 response: ", res.status, " → fallback=", fallback)
        if fallback == "DENY" then
            return kong.response.exit(429, { message = "Service temporarily unavailable" })
        end
        return
    end

    local ok, result = pcall(cjson.decode, res.body)
    if not ok or not result then
        kong.log.warn("[aforo-preflight] Failed to parse response → fallback=", fallback)
        return
    end

    -- Handle response envelope: {success, data: {decision, ...}, meta}
    local data = result.data or result

    if data.decision == "DENY" then
        local retry_after = data.retryAfterMs and math.floor(data.retryAfterMs / 1000) or 60
        local headers = {
            ["Retry-After"] = tostring(retry_after),
            ["Content-Type"] = "application/json",
        }
        -- Forward rate limit headers
        if data.headers then
            for k, v in pairs(data.headers) do
                headers[k] = v
            end
        end
        return kong.response.exit(429, {
            message = data.reason or "Rate limit exceeded",
            retryAfter = retry_after,
        }, headers)
    elseif data.decision == "WARN" then
        -- Add warning header but allow request
        kong.response.set_header("X-RateLimit-Warning", "approaching-limit")
        if data.headers then
            for k, v in pairs(data.headers) do
                kong.response.set_header(k, v)
            end
        end
    elseif data.decision == "ALLOW" then
        -- Cache ALLOW decisions (never cache DENY or WARN)
        if dict then
            local ttl = (conf.preflight_cache_ttl_ms or 1000) / 1000
            dict:set(cache_key, "ALLOW", ttl)
        end
        -- Forward rate limit headers
        if data.headers then
            for k, v in pairs(data.headers) do
                kong.response.set_header(k, v)
            end
        end
    end
end

return M
