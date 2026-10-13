-- Aforo Margin Guard Pre-Flight Check for Kong Gateway
-- Runs in the `access` phase (before proxying to backend).
-- Calls the pricing-service quick-check endpoint:
--
--   GET {margin_guard_url}/internal/v1/margin-guard/quick-check
--       ?tenantId=..&scopeType=GLOBAL|CUSTOMER&scopeId=..
--
-- No auth: it is an internal, network-secured pricing endpoint. The answer is
-- pricing's MarginGuardCheckResponse, flat (no envelope):
--   { verdict = ALLOW | WARN | THROTTLE | BLOCK, currentLevel, message, ... }
--
-- Two scopes are asked: GLOBAL (scopeId "global", pricing's own default) and,
-- when the customer is known, CUSTOMER. Either answering BLOCK or THROTTLE is
-- a 429. Pricing already decides THROTTLE per request (it counts requests and
-- rejects its configured share), so the plugin does not roll its own dice.
--
-- 2026-10-12 fix. This module read `allowed` / `level` / `throttleRate`, none
-- of which pricing sends, so `result.allowed` was always nil, `level` always
-- "NONE", and nothing was ever blocked or throttled. It also cached into a
-- shared dict no install declared, and a missing margin_guard_url raised on
-- every request (a 500).
--
-- Fail-open: a timeout, an error status, an unreadable answer, a missing URL
-- or any failure in this module lets the request through.
--
-- Configuration (schema.lua):
--   margin_guard_enabled: boolean (default: false)
--   margin_guard_url: string (pricing-service base URL; required when enabled)
--   margin_guard_cache_ttl: integer seconds (default: 30)

local http = require("resty.http")
local cjson = require("cjson.safe")

local M = {}

-- Cached in the existing aforo_buffer dict, as preflight-quota.lua does.
-- (This module used to name its own "aforo_margin_guard_cache" dict, which no
-- install declared, so every request called pricing.)
local CACHE_DICT = "aforo_buffer"
local CACHE_PREFIX = "aforo:mg:"
local QUICK_CHECK_PATH = "/internal/v1/margin-guard/quick-check"
local TIMEOUT_MS = 50 -- fail-fast: this is on the request path

-- Same shape as preflight-quota.lua's throttle.
local function log_throttled(dict, level, key, ...)
    if dict and not dict:safe_add("aforo:warn:" .. key, 1, 60) then return end
    kong.log[level](...)
end

-- One scope's verdict: { verdict, message } or nil when there is no usable
-- answer (fail open). Only BLOCK and a plain ALLOW are cached. THROTTLE is
-- decided per request by pricing (it counts requests and rejects its share),
-- so neither a THROTTLE nor the ALLOW for a request the throttle let through
-- may be cached: a cached pass would wave through every request in the TTL,
-- and the throttle would almost never apply (2026-10-13 fix). Pricing marks
-- such a pass ALLOW with currentLevel "L2_THROTTLE"; an ALLOW is cached only
-- when currentLevel is "NONE" or absent. Older pricing versions answer a
-- throttle pass with currentLevel "NONE", which cannot be told apart from a
-- real ALLOW -- full throttle accuracy needs the updated pricing service.
local function quick_check(conf, dict, base_url, tenant_id, scope_type, scope_id)
    local ttl = tonumber(conf.margin_guard_cache_ttl) or 30
    local cache_key = CACHE_PREFIX .. tenant_id .. ":" .. scope_type .. ":" .. scope_id
    if dict and ttl > 0 then
        local cached = dict:get(cache_key)
        local entry = cached and cjson.decode(cached)
        if type(entry) == "table" then return entry end
    end

    local httpc = http.new()
    httpc:set_timeout(TIMEOUT_MS)
    local url = base_url .. QUICK_CHECK_PATH
        .. "?tenantId=" .. ngx.escape_uri(tenant_id)
        .. "&scopeType=" .. scope_type
        .. "&scopeId=" .. ngx.escape_uri(scope_id)

    local res, err = httpc:request_uri(url, {
        method = "GET",
        headers = {
            ["Accept"] = "application/json",
            ["X-Tenant-Id"] = tenant_id,
        },
    })
    if not res then
        log_throttled(dict, "warn", "mg_unreachable", "[aforo-margin-guard] Check failed: ",
            tostring(err), " -- fail-open ALLOW. Repeats suppressed for 60s.")
        return nil
    end
    if res.status ~= 200 then
        log_throttled(dict, "warn", "mg_status", "[aforo-margin-guard] Non-200 response: ",
            res.status, " -- fail-open ALLOW. Repeats suppressed for 60s.")
        return nil
    end

    local body = cjson.decode(res.body)
    local verdict = type(body) == "table" and body.verdict
    if type(verdict) ~= "string" then
        log_throttled(dict, "warn", "mg_body", "[aforo-margin-guard] Response has no verdict -- ",
            "fail-open ALLOW. Repeats suppressed for 60s.")
        return nil
    end

    local entry = {
        verdict = verdict,
        message = type(body.message) == "string" and body.message or nil,
    }
    local level = body.currentLevel
    local plain_allow = verdict == "ALLOW" and (level == nil or level == cjson.null or level == "NONE")
    if dict and ttl > 0 and (verdict == "BLOCK" or plain_allow) then
        -- safe_set: a cache never evicts buffered events; a full dict just misses.
        dict:safe_set(cache_key, cjson.encode(entry), ttl)
    end
    return entry
end

-- Answer 429. Retry-After: for BLOCK, the cache TTL -- the soonest this
-- gateway will ask pricing again; for THROTTLE, 1 second, since pricing
-- rejects only a share of requests and the next one may pass.
local function refuse(conf, entry)
    local block = entry.verdict == "BLOCK"
    local retry_after = 1
    if block then
        retry_after = math.max(1, math.floor(tonumber(conf.margin_guard_cache_ttl) or 30))
    end
    kong.response.exit(429, {
        error = block and {
            code = "SERVICE_RESTRICTED_MARGIN",
            message = entry.message or "Service restricted due to margin constraints. Contact support.",
            retryAfterSeconds = retry_after,
            supportUrl = "/portal/support",
        } or {
            code = "RATE_LIMITED_MARGIN",
            message = entry.message or "Rate limited due to margin constraints. Please retry.",
            retryAfterSeconds = retry_after,
            dashboardUrl = "/portal/cost-explorer",
        },
    }, {
        ["Retry-After"] = tostring(retry_after),
        ["X-Margin-Guard"] = block and "blocked" or "throttled",
        ["X-Margin-Guard-Level"] = block and "L3" or "L2",
    })
    return true
end

local function check(conf, tenant_id, customer_id)
    local dict = ngx.shared[CACHE_DICT]

    local base_url = type(conf.margin_guard_url) == "string"
        and (conf.margin_guard_url:gsub("/+$", "")) or ""
    if base_url == "" then
        -- The schema refuses this combination; a config that predates that
        -- check must still not take traffic down.
        log_throttled(dict, "err", "mg_no_url", "[aforo-margin-guard] margin_guard_enabled is set ",
            "but margin_guard_url is not -- margin guard is NOT enforced. Repeats suppressed for 60s.")
        return false
    end

    local scopes = { { "GLOBAL", "global" } }
    if type(customer_id) == "string" and customer_id ~= "" then
        scopes[2] = { "CUSTOMER", customer_id }
    end

    local warn = false
    for _, scope in ipairs(scopes) do
        local entry = quick_check(conf, dict, base_url, tenant_id, scope[1], scope[2])
        if entry then
            if entry.verdict == "BLOCK" or entry.verdict == "THROTTLE" then
                return refuse(conf, entry)
            end
            if entry.verdict == "WARN" then warn = true end
        end
    end

    if warn then
        kong.service.request.set_header("X-Margin-Guard-Warning", "margin-low")
    end
    return false
end

-- ── Access phase handler ────────────────────────────────────

-- Returns true when it answered the request (429), so the caller stops.
function M.check(conf, tenant_id, customer_id)
    if not conf.margin_guard_enabled then return false end
    if type(tenant_id) ~= "string" or tenant_id == "" then return false end

    local ok, refused = pcall(check, conf, tenant_id, customer_id)
    if not ok then
        log_throttled(ngx.shared[CACHE_DICT], "err", "mg_error",
            "[aforo-margin-guard] Check failed (", tostring(refused),
            ") -- fail-open ALLOW. Repeats suppressed for 60s.")
        return false
    end
    return refused == true
end

return M
