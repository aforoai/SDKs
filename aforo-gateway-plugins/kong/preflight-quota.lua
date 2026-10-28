-- Aforo Pre-Flight Quota Check for Kong Gateway
-- Runs in the `access` phase (before proxying to the upstream), called from
-- handler.lua. Asks the usage-ingestor's POST /api/v1/quota/check whether this
-- customer may make this call (rate limit, prepaid wallet, cumulative quota)
-- and answers 429 on DENY.
--
-- Off unless preflight_quota_enabled is set: it adds a synchronous hop to every
-- request that misses the local cache, which is a latency cost an operator has
-- to opt into.
--
-- Fails OPEN by default. Timeout, connection error, non-200 or an unreadable
-- body all let the request through: a quota check that is down must not become
-- an outage of the customer's own API. preflight_quota_fail_open = false makes
-- those cases answer 503 instead, for deployments where over-serving costs more
-- than refusing (prepaid wallets, hard quotas).
--
-- Circuit breaker (2.8.0, G334). After preflight_quota_breaker_threshold
-- consecutive failures (default 5) the check stops calling the ingestor for
-- preflight_quota_breaker_cooldown_s seconds (default 10) and applies the
-- fail mode at once, so an outage no longer costs every request the full
-- timeout. Then one request probes: a success closes the breaker, a failure
-- opens it for another cool-down. Shared by all workers (aforo_cache dict),
-- per quota-check URL and tenant. A threshold of 0 turns the breaker off.
--
-- DENY is cached (2.8.0, G333) until the ingestor's retryAfterMs, at most
-- 60 s (5 s when the answer gives none), and answered 429 with the remaining
-- Retry-After from the cache. Before, every request of a refused customer
-- asked the ingestor again.
--
-- The request names the quantity the call will be billed (estimatedQuantity,
-- 2.8.0): a fixed quantity_source, else 1. A quantity the upstream reports
-- in its response (X-Aforo-Quantity, response_size) is not known yet.
--
-- Configuration (schema.lua):
--   preflight_quota_enabled            boolean (default false)
--   preflight_quota_url                string  (default: aforo_endpoint's origin + /api/v1/quota/check)
--   preflight_quota_api_key            string  (default: api_key)
--   preflight_quota_timeout_ms         integer (default 300)
--   preflight_quota_cache_ttl_ms       integer (default 1000; 0 disables the ALLOW/WARN
--                                      and DENY caches)
--   preflight_quota_fail_open          boolean (default true)
--   preflight_quota_breaker_threshold  integer (default 5; 0 disables the breaker)
--   preflight_quota_breaker_cooldown_s integer (default 10)

local http = require("resty.http")
local cjson = require("cjson.safe")

local function require_sibling(name)
    local ok, mod = pcall(require, "kong.plugins.aforo-metering." .. name)
    if ok then return mod end
    return require(name)
end
local event_util = require_sibling("event-util")

local M = {}

local QUOTA_CHECK_PATH = "/api/v1/quota/check"

-- Kong to Aforo is a call over the internet, usually to another region: 100 ms
-- (the old default) timed out often enough that the check silently failed
-- open (2026-10-19). Raised to 300 ms; preflight_quota_timeout_ms overrides.
local DEFAULT_TIMEOUT_MS = 300

local DENY_DEFAULT_SECONDS = 5
local DENY_MAX_SECONDS = 60
local DEFAULT_BREAKER_THRESHOLD = 5
local DEFAULT_BREAKER_COOLDOWN = 10

-- Same shape as handler.lua's throttle: a check that runs on every request
-- would otherwise log on every request while the ingestor is unreachable.
local function warn_throttled(dict, key, ...)
    if not dict then
        kong.log.warn(...)
        return
    end
    if dict:safe_add("aforo:warn:" .. key, 1, 60) then
        kong.log.warn(...)
    end
end

-- The quota check lives on the same ingestor the events are flushed to, so
-- unless told otherwise derive it from aforo_endpoint rather than making the
-- operator configure the host twice and keep the two in step.
local function quota_url(conf)
    if conf.preflight_quota_url and conf.preflight_quota_url ~= "" then
        return conf.preflight_quota_url
    end
    local origin = conf.aforo_endpoint and string.match(conf.aforo_endpoint, "^(https?://[^/]+)")
    return origin and (origin .. QUOTA_CHECK_PATH) or nil
end

-- Could not get a decision. Returns true when the request was answered here.
local function fallback(conf, dict, reason)
    if conf.preflight_quota_fail_open == false then
        warn_throttled(dict, "preflight_fail_closed",
            "[aforo-preflight] Quota check unavailable (", reason, "). ",
            "preflight_quota_fail_open=false, so requests are refused with 503. ",
            "Repeats suppressed for 60s.")
        kong.response.exit(503, { message = "Quota check unavailable" },
            { ["Retry-After"] = "1" })
        return true
    end
    warn_throttled(dict, "preflight_fail_open",
        "[aforo-preflight] Quota check unavailable (", reason, "). ",
        "Failing OPEN -- quotas are NOT being enforced. Repeats suppressed for 60s.")
    return false
end

-- ── Circuit breaker ─────────────────────────────────────────
-- State and transitions: event_util.breaker_* (shared with margin-guard.lua).
local function breaker_settings(conf)
    return event_util.breaker_settings(conf.preflight_quota_breaker_threshold,
        conf.preflight_quota_breaker_cooldown_s, DEFAULT_BREAKER_THRESHOLD, DEFAULT_BREAKER_COOLDOWN)
end

-- true when the call may go ahead, false when the breaker says skip it.
local function breaker_allows(dict, bkey, conf)
    local threshold = breaker_settings(conf)
    -- Half-open: exactly one request probes; it holds the probe for at
    -- most timeout + 1 s, so a probe whose worker died is replaced.
    local timeout_s = (tonumber(conf.preflight_quota_timeout_ms) or DEFAULT_TIMEOUT_MS) / 1000
    return event_util.breaker_allows(dict, bkey, threshold, timeout_s + 1)
end

local function breaker_success(dict, bkey)
    event_util.breaker_success(dict, bkey)
end

local function breaker_failure(dict, bkey, conf)
    local threshold, cooldown = breaker_settings(conf)
    local opened, fails, tripped = event_util.breaker_failure(dict, bkey, threshold, cooldown)
    if opened then
        warn_throttled(dict, "preflight_breaker_open",
            "[aforo-preflight] Quota check failed ", tripped and "its probe" or (tostring(fails)
            .. " times in a row"), "; not calling it for ", cooldown, "s (",
            conf.preflight_quota_fail_open == false and "refusing with 503" or "failing OPEN",
            " meanwhile). Repeats suppressed for 60s.")
    end
end

-- The quantity to ask about: a positive number or 1.
local function estimated_quantity(quantity)
    local q = tonumber(quantity)
    if q and q > 0 and q == q and q ~= math.huge then return q end
    return 1
end

local function deny_response(retry_after, reason, headers)
    local h = {}
    if type(headers) == "table" then
        for k, v in pairs(headers) do h[k] = v end
    end
    h["Retry-After"] = tostring(retry_after)
    h["Content-Type"] = "application/json"
    kong.response.exit(429, {
        message = reason or "Quota exceeded",
        retryAfter = retry_after,
    }, h)
    return true
end

-- Returns true when it has answered the request (429 / 503), so the caller
-- stops: in Kong's access phase kong.response.exit only records the response,
-- and the rest of the handler would otherwise still run.
--
-- customer_id must be the JWT-validated claim or the Kong consumer identity
-- (handler.lua's resolve_customer_id). Never a request header: this decides
-- whose quota is spent, and a client-settable value would let one customer
-- borrow another's.
function M.check(conf, customer_id, metric_name, quantity)
    if not conf.preflight_quota_enabled then return false end
    -- No verified identity, nothing to check against. The log phase refuses to
    -- meter such a request too.
    if not customer_id or customer_id == "" then return false end

    local dict = event_util.cache_dict()

    local url = quota_url(conf)
    if not url then
        return fallback(conf, dict, "no preflight_quota_url and aforo_endpoint has no http(s) origin")
    end

    local qty = estimated_quantity(quantity)

    -- Tenant is part of the key: one gateway can front several tenants'
    -- plugin instances, and customer ids are only unique within a tenant.
    local cache_key = "aforo:preflight:" .. (conf.tenant_id or "") .. ":" .. customer_id
        .. ":" .. (metric_name or "_all") .. ":" .. tostring(qty)
    local ttl_ms = conf.preflight_quota_cache_ttl_ms or 1000
    -- ALLOW and WARN are cached for preflight_quota_cache_ttl_ms. WARN lets the
    -- call through just as ALLOW does, and the ingestor answers it for every
    -- customer near their limit and for overage plans past it (2026-10-19):
    -- uncached, those customers cost one quota call per request. A cached
    -- WARN still marks the response with X-RateLimit-Warning. DENY is cached
    -- until its Retry-After (see the module header).
    if dict and ttl_ms > 0 then
        local cached = dict:get(cache_key)
        if cached == "ALLOW" then
            return false
        elseif cached == "WARN" then
            kong.response.set_header("X-RateLimit-Warning", "approaching-limit")
            return false
        elseif type(cached) == "string" and cached:sub(1, 5) == "DENY:" then
            local entry = cjson.decode(cached:sub(6))
            if type(entry) == "table" and tonumber(entry.until_at) then
                local left = math.ceil(tonumber(entry.until_at) - ngx.now())
                if left >= 1 then
                    return deny_response(left, entry.reason, entry.headers)
                end
            end
        end
    end

    local bkey = "aforo:preflight:cb:" .. ngx.md5((conf.tenant_id or "") .. "\n" .. url)
    if not breaker_allows(dict, bkey, conf) then
        return fallback(conf, dict, "circuit breaker open after repeated failures")
    end

    local httpc = http.new()
    httpc:set_timeout(conf.preflight_quota_timeout_ms or DEFAULT_TIMEOUT_MS)

    local res, err = httpc:request_uri(url, {
        method = "POST",
        body = cjson.encode({
            customerId = customer_id,
            metricName = metric_name,
            estimatedQuantity = qty,
        }),
        -- X-API-Key alone, never Authorization: Bearer -- same reason as the
        -- ingest flush in event-buffer.lua. The ingestor's ApiKeyAuthFilter
        -- reads only X-API-Key, and an API key sent as Bearer is parsed as a
        -- JWT and rejected 401 before that filter runs, even alongside X-API-Key.
        headers = {
            ["Content-Type"] = "application/json",
            ["X-API-Key"]    = conf.preflight_quota_api_key or conf.api_key or "",
            ["X-Tenant-Id"]  = conf.tenant_id or "",
        },
    })

    if not res then
        breaker_failure(dict, bkey, conf)
        return fallback(conf, dict, "error: " .. tostring(err))
    end

    if res.status ~= 200 then
        breaker_failure(dict, bkey, conf)
        -- 401/403 is a credential problem, not an outage; say so, since it will
        -- not fix itself. The key must be one the ingestor accepts for
        -- /api/v1/quota/check -- hence preflight_quota_api_key.
        local hint = (res.status == 401 or res.status == 403)
            and " -- the ingestor refused the key: check preflight_quota_api_key (default api_key)" or ""
        return fallback(conf, dict, "status " .. res.status .. hint)
    end

    local result = cjson.decode(res.body)
    if type(result) ~= "table" then
        breaker_failure(dict, bkey, conf)
        return fallback(conf, dict, "unreadable response body")
    end
    breaker_success(dict, bkey)

    -- The controller returns the decision flat; tolerate the platform's
    -- {success, data} envelope too in case a gateway in front adds it.
    local data = type(result.data) == "table" and result.data or result

    if data.decision == "DENY" then
        -- Whole seconds, at least 1, and the same value in the header and the
        -- body: the ingestor's own Retry-After header is retryAfterMs rounded
        -- DOWN, so a wait under a second used to reach the client as
        -- "Retry-After: 0" -- an invitation to retry at once.
        local retry_ms = tonumber(data.retryAfterMs)
        local retry_after = (retry_ms and retry_ms > 0) and math.max(1, math.ceil(retry_ms / 1000))
            or DENY_DEFAULT_SECONDS
        if retry_after > DENY_MAX_SECONDS then retry_after = DENY_MAX_SECONDS end
        local headers = type(data.headers) == "table" and data.headers or nil
        local reason = type(data.reason) == "string" and data.reason or nil
        if dict and ttl_ms > 0 then
            local entry = cjson.encode({ until_at = ngx.now() + retry_after, reason = reason,
                                         headers = headers })
            -- safe_set: a cache never evicts anything; a full dict just misses.
            if entry then dict:safe_set(cache_key, "DENY:" .. entry, retry_after) end
        end
        return deny_response(retry_after, reason, headers)
    end

    if (data.decision == "ALLOW" or data.decision == "WARN") and dict and ttl_ms > 0 then
        dict:safe_set(cache_key, data.decision, ttl_ms / 1000)
    end

    if data.decision == "WARN" then
        kong.response.set_header("X-RateLimit-Warning", "approaching-limit")
    end
    if type(data.headers) == "table" then
        for k, v in pairs(data.headers) do
            kong.response.set_header(k, v)
        end
    end
    return false
end

return M
