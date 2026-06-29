-- Aforo Margin Guard Pre-Flight Check for Kong Gateway
-- Runs in the `access` phase (before proxying to backend).
-- Calls the pricing-service /internal/v1/margin-guard/quick-check endpoint.
-- Fail-open: if the check times out or fails, the request proceeds.
--
-- Configuration (via kong.conf or declarative config):
--   margin_guard_enabled: boolean (default: false)
--   margin_guard_url: string (pricing-service base URL)
--   margin_guard_cache_ttl: integer seconds (default: 30)

local http = require("resty.http")
local cjson = require("cjson.safe")

local M = {}

local CACHE_DICT = "aforo_margin_guard_cache"

-- ── Access phase handler ────────────────────────────────────

function M.check(conf, tenant_id, customer_id)
    if not conf.margin_guard_enabled then return end
    if not customer_id or customer_id == "" then return end
    if not tenant_id or tenant_id == "" then return end

    -- Check local cache first (30s TTL)
    local cache_key = "mg:" .. tenant_id .. ":" .. customer_id
    local dict = ngx.shared[CACHE_DICT]
    if dict then
        local cached = dict:get(cache_key)
        if cached then
            local result = cjson.decode(cached)
            if result then
                return M.enforce(result)
            end
        end
    end

    -- Call pricing-service quick-check
    local httpc = http.new()
    httpc:set_timeout(50) -- 50ms timeout, fail-fast

    local url = conf.margin_guard_url
            .. "/internal/v1/margin-guard/quick-check"
            .. "?tenantId=" .. tenant_id
            .. "&scopeType=CUSTOMER"
            .. "&scopeId=" .. customer_id

    local res, err = httpc:request_uri(url, {
        method = "GET",
        headers = {
            ["Content-Type"] = "application/json",
            ["X-Tenant-Id"] = tenant_id,
        },
    })

    if not res then
        -- Timeout or connection failure → fail-open (allow request)
        kong.log.warn("[aforo-margin-guard] Check failed: ", err, " → fail-open ALLOW")
        return
    end

    if res.status ~= 200 then
        kong.log.warn("[aforo-margin-guard] Non-200 response: ", res.status, " → fail-open ALLOW")
        return
    end

    local result = cjson.decode(res.body)
    if not result then
        kong.log.warn("[aforo-margin-guard] Invalid JSON response → fail-open ALLOW")
        return
    end

    -- Cache result for configured TTL (default 30s)
    local ttl = conf.margin_guard_cache_ttl or 30
    if dict then
        dict:set(cache_key, res.body, ttl)
    end

    return M.enforce(result)
end

-- ── Enforcement logic ───────────────────────────────────────

function M.enforce(result)
    if result.allowed then
        return -- allowed, proceed normally
    end

    local level = result.level or "NONE"

    if level == "L3_BLOCK" then
        -- Hard block — reject request immediately
        local retry_after = tostring(result.retryAfterSeconds or 1800)
        return kong.response.exit(429, cjson.encode({
            error = {
                code = "SERVICE_RESTRICTED_MARGIN",
                message = result.message or "Service restricted due to margin constraints. Contact support.",
                retryAfterSeconds = tonumber(retry_after),
                supportUrl = "/portal/support",
            }
        }), {
            ["Content-Type"] = "application/json",
            ["X-Margin-Guard"] = "blocked",
            ["X-Margin-Guard-Level"] = "L3",
            ["Retry-After"] = retry_after,
        })
    end

    if level == "L2_THROTTLE" then
        -- Probabilistic throttle — reject a percentage of requests
        local throttle_rate = result.throttleRate or 50
        -- throttle_rate = percentage of requests to ALLOW (e.g. 50 = allow 50%)
        math.randomseed(ngx.now() * 1000 + ngx.worker.pid())
        local roll = math.random(100)
        if roll > throttle_rate then
            -- This request is throttled
            return kong.response.exit(429, cjson.encode({
                error = {
                    code = "RATE_LIMITED_MARGIN",
                    message = result.message or "Rate limited due to margin constraints. Please retry.",
                    retryAfterSeconds = 60,
                    dashboardUrl = "/portal/cost-explorer",
                }
            }), {
                ["Content-Type"] = "application/json",
                ["X-Margin-Guard"] = "throttled",
                ["X-Margin-Guard-Level"] = "L2",
                ["Retry-After"] = "60",
            })
        end
        -- This request is allowed through (within the allowed percentage)
    end

    -- L1_ALERT or unknown → allow but add informational header
    if level == "L1_ALERT" then
        kong.service.request.set_header("X-Margin-Guard-Warning", "margin-low")
    end
end

return M
