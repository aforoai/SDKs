-- Aforo Margin Guard Pre-Flight Check for Kong Gateway
-- Runs in the `access` phase (before proxying to backend).
-- Calls the pricing-service quick-check endpoint:
--
--   GET {margin_guard_url}/api/v1/margin-guard/quick-check
--       ?scopeType=GLOBAL|CUSTOMER&scopeId=..
--
-- Pricing's public, key-authenticated check (2.8.0, G332): the plugin's Aforo
-- API key goes as X-API-Key and pricing takes the tenant from the key, so no
-- tenantId parameter and no X-Tenant-Id header are sent (a header the caller
-- chooses proves nothing). Before 2.8.0 the call went to
-- /internal/v1/margin-guard/quick-check with only X-Tenant-Id, a path public
-- *.aforo.ai hosts refuse. The answer is bare (no envelope):
--   { verdict = ALLOW | THROTTLE | BLOCK, currentLevel, message }
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
-- A 4xx other than 408 / 429 (2.8.1) is pricing refusing that request: it is
-- logged and fails open, but does not count against the breaker. A customer
-- id over 128 characters (pricing's limit) is not sent: only GLOBAL is asked.
--
-- Fail-open: a timeout, an error status, an unreadable answer, a missing URL
-- or any failure in this module lets the request through.
--
-- Timeout and circuit breaker (2.8.0 review, G331). The call now goes to
-- pricing's public host (TLS, possibly another region), so the timeout is
-- margin_guard_timeout_ms (default 300; it was a fixed 50 ms, which mostly
-- timed out and so mostly failed open). After margin_guard_breaker_threshold
-- (default 5, 0 = off) failures in a row (timeout, error, non-200, no
-- verdict) pricing is not called for margin_guard_breaker_cooldown_s
-- (default 10) and requests go through at once; then one request probes, and
-- a success closes the breaker. Without it a down pricing cost every request
-- up to two timeouts (two scopes). One breaker per tenant and pricing URL,
-- shared by all workers (aforo_cache), the same implementation as the
-- pre-flight quota check (event_util.breaker_*).
--
-- Configuration (schema.lua):
--   margin_guard_enabled: boolean (default: false)
--   margin_guard_url: string (pricing-service base URL; required when enabled)
--   margin_guard_cache_ttl: integer seconds (default: 30)
--   margin_guard_timeout_ms: integer ms (default: 300, 10..5000)
--   margin_guard_breaker_threshold: integer (default: 5; 0 disables the breaker)
--   margin_guard_breaker_cooldown_s: integer seconds (default: 10)

local http = require("resty.http")
local cjson = require("cjson.safe")

local function require_sibling(name)
    local ok, mod = pcall(require, "kong.plugins.aforo-metering." .. name)
    if ok then return mod end
    return require(name)
end
local event_util = require_sibling("event-util")

local M = {}

-- Cached in aforo_cache (2.8.0, G323/G331), through event_util.cache_dict():
-- aforo_buffer when aforo_cache is not declared, nil when neither is -- then
-- every request asks pricing, and cache_dict() logs that once per worker.
-- (This module once named its own "aforo_margin_guard_cache" dict, which no
-- install declared, so every request called pricing with nothing logged.)
local CACHE_PREFIX = "aforo:mg:"
local QUICK_CHECK_PATH = "/api/v1/margin-guard/quick-check"
local DEFAULT_TIMEOUT_MS = 300
local DEFAULT_BREAKER_THRESHOLD = 5
local DEFAULT_BREAKER_COOLDOWN = 10

-- Same shape as preflight-quota.lua's throttle.
-- Longest scopeId pricing's quick-check accepts (400 above it).
local MAX_SCOPE_ID = 128

local function log_throttled(dict, level, key, ...)
    if dict and not dict:safe_add("aforo:warn:" .. key, 1, 60) then return end
    kong.log[level](...)
end

local function timeout_ms(conf)
    local t = tonumber(conf.margin_guard_timeout_ms)
    if not t or t <= 0 then return DEFAULT_TIMEOUT_MS end
    return t
end

local function breaker_settings(conf)
    return event_util.breaker_settings(conf.margin_guard_breaker_threshold,
        conf.margin_guard_breaker_cooldown_s, DEFAULT_BREAKER_THRESHOLD, DEFAULT_BREAKER_COOLDOWN)
end

local function breaker_failure(conf, dict, bkey)
    local threshold, cooldown = breaker_settings(conf)
    local opened, fails, tripped = event_util.breaker_failure(dict, bkey, threshold, cooldown)
    if opened then
        log_throttled(dict, "warn", "mg_breaker_open", "[aforo-margin-guard] Pricing check failed ",
            tripped and "its probe" or (tostring(fails) .. " times in a row"),
            "; not calling it for ", cooldown, "s -- fail-open ALLOW meanwhile. ",
            "Repeats suppressed for 60s.")
    end
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
local function quick_check(conf, dict, bkey, base_url, tenant_id, scope_type, scope_id)
    local ttl = tonumber(conf.margin_guard_cache_ttl) or 30
    local cache_key = CACHE_PREFIX .. tenant_id .. ":" .. scope_type .. ":" .. scope_id
    if dict and ttl > 0 then
        local cached = dict:get(cache_key)
        local entry = cached and cjson.decode(cached)
        if type(entry) == "table" then return entry end
    end

    -- Breaker open: no call, no verdict (fail open). Asked per call, so a
    -- half-open probe is a single call, not one per scope.
    local threshold = breaker_settings(conf)
    if not event_util.breaker_allows(dict, bkey, threshold, timeout_ms(conf) / 1000 + 1) then
        return nil, "breaker"
    end

    local httpc = http.new()
    httpc:set_timeout(timeout_ms(conf))
    local url = base_url .. QUICK_CHECK_PATH
        .. "?scopeType=" .. ngx.escape_uri(scope_type)
        .. "&scopeId=" .. ngx.escape_uri(scope_id)

    local res, err = httpc:request_uri(url, {
        method = "GET",
        headers = {
            ["Accept"] = "application/json",
            -- X-API-Key, never Authorization: Bearer (same rule as the
            -- ingest flush and the pre-flight quota check).
            ["X-API-Key"] = conf.api_key or "",
        },
    })
    if not res then
        breaker_failure(conf, dict, bkey)
        log_throttled(dict, "warn", "mg_unreachable", "[aforo-margin-guard] Check failed: ",
            tostring(err), " -- fail-open ALLOW. Repeats suppressed for 60s.")
        return nil
    end
    if res.status >= 400 and res.status < 500 and res.status ~= 408 and res.status ~= 429 then
        -- Pricing answered and refused this request (a bad scope id, a key it
        -- does not accept): it is up, so this is not a breaker failure. Before
        -- 2.8.1 it was, and the breaker is per tenant, so one customer id
        -- pricing refused switched the GLOBAL check off for the whole tenant.
        event_util.breaker_success(dict, bkey)
        log_throttled(dict, "warn", "mg_refused", "[aforo-margin-guard] Pricing refused the ",
            scope_type, " check with HTTP ", res.status, " -- fail-open ALLOW, breaker unchanged. ",
            "Repeats suppressed for 60s.")
        return nil
    end
    if res.status ~= 200 then
        breaker_failure(conf, dict, bkey)
        log_throttled(dict, "warn", "mg_status", "[aforo-margin-guard] Non-200 response: ",
            res.status, " -- fail-open ALLOW. Repeats suppressed for 60s.")
        return nil
    end

    local body = cjson.decode(res.body)
    local verdict = type(body) == "table" and body.verdict
    if type(verdict) ~= "string" then
        breaker_failure(conf, dict, bkey)
        log_throttled(dict, "warn", "mg_body", "[aforo-margin-guard] Response has no verdict -- ",
            "fail-open ALLOW. Repeats suppressed for 60s.")
        return nil
    end

    event_util.breaker_success(dict, bkey)

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
    local dict = event_util.cache_dict()

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
        if #customer_id > MAX_SCOPE_ID then
            -- Pricing refuses a scopeId over 128 characters with 400.
            log_throttled(dict, "warn", "mg_long_customer", "[aforo-margin-guard] Customer id longer than ",
                MAX_SCOPE_ID, " characters: CUSTOMER scope not checked (GLOBAL still is). ",
                "Repeats suppressed for 60s.")
        else
            scopes[2] = { "CUSTOMER", customer_id }
        end
    end

    local bkey = "aforo:mg:cb:" .. ngx.md5(tenant_id .. "\n" .. base_url)
    local warn = false
    for _, scope in ipairs(scopes) do
        local entry, skipped = quick_check(conf, dict, bkey, base_url, tenant_id, scope[1], scope[2])
        if skipped == "breaker" then
            -- Open breaker: the other scope would be skipped too.
            break
        end
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
        log_throttled(event_util.cache_dict(), "err", "mg_error",
            "[aforo-margin-guard] Check failed (", tostring(refused),
            ") -- fail-open ALLOW. Repeats suppressed for 60s.")
        return false
    end
    return refused == true
end

return M
