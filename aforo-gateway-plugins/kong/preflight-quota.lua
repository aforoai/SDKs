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
-- than refusing.
--
-- Configuration (schema.lua):
--   preflight_quota_enabled       boolean (default false)
--   preflight_quota_url           string  (default: aforo_endpoint's origin + /api/v1/quota/check)
--   preflight_quota_api_key       string  (default: api_key)
--   preflight_quota_timeout_ms    integer (default 100)
--   preflight_quota_cache_ttl_ms  integer (default 1000; 0 disables the cache)
--   preflight_quota_fail_open     boolean (default true)

local http = require("resty.http")
local cjson = require("cjson.safe")

local M = {}

-- Cached in the existing aforo_buffer dict, as the metric mappings are:
-- requiring a second lua_shared_dict adds a deployment step operators forget.
-- (This module used to name its own "aforo_preflight_cache" dict, which no
-- install declared, so the cache silently never existed.)
local CACHE_DICT = "aforo_buffer"

local QUOTA_CHECK_PATH = "/api/v1/quota/check"

-- Same shape as handler.lua's throttle: a check that runs on every request
-- would otherwise log on every request while the ingestor is unreachable.
local function warn_throttled(dict, key, ...)
    if not dict then
        kong.log.warn(...)
        return
    end
    if dict:add("aforo:warn:" .. key, 1, 60) then
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

-- Returns true when it has answered the request (429 / 503), so the caller
-- stops: in Kong's access phase kong.response.exit only records the response,
-- and the rest of the handler would otherwise still run.
--
-- customer_id must be the JWT-validated claim or the Kong consumer identity
-- (handler.lua's resolve_customer_id). Never a request header: this decides
-- whose quota is spent, and a client-settable value would let one customer
-- borrow another's.
function M.check(conf, customer_id, metric_name)
    if not conf.preflight_quota_enabled then return false end
    -- No verified identity, nothing to check against. The log phase refuses to
    -- meter such a request too.
    if not customer_id or customer_id == "" then return false end

    local dict = ngx.shared[CACHE_DICT]

    local url = quota_url(conf)
    if not url then
        return fallback(conf, dict, "no preflight_quota_url and aforo_endpoint has no http(s) origin")
    end

    -- Tenant is part of the key: one gateway can front several tenants'
    -- plugin instances, and customer ids are only unique within a tenant.
    local cache_key = "aforo:preflight:" .. (conf.tenant_id or "") .. ":" .. customer_id
        .. ":" .. (metric_name or "_all")
    local ttl_ms = conf.preflight_quota_cache_ttl_ms or 1000
    -- Only ALLOW is cached. A DENY is re-asked every time so a top-up or a new
    -- window unblocks the customer immediately, not a TTL later.
    if dict and ttl_ms > 0 and dict:get(cache_key) == "ALLOW" then
        return false
    end

    local httpc = http.new()
    httpc:set_timeout(conf.preflight_quota_timeout_ms or 100)

    local res, err = httpc:request_uri(url, {
        method = "POST",
        body = cjson.encode({
            customerId = customer_id,
            metricName = metric_name,
        }),
        -- X-API-Key alone, never Authorization: Bearer -- same reason as the
        -- ingest flush in handler.lua. The ingestor's ApiKeyAuthFilter reads
        -- only X-API-Key, and an API key sent as Bearer is parsed as a JWT and
        -- rejected 401 before that filter runs, even alongside X-API-Key.
        headers = {
            ["Content-Type"] = "application/json",
            ["X-API-Key"]    = conf.preflight_quota_api_key or conf.api_key or "",
            ["X-Tenant-Id"]  = conf.tenant_id or "",
        },
    })

    if not res then
        return fallback(conf, dict, "error: " .. tostring(err))
    end

    if res.status ~= 200 then
        -- 401/403 is a credential problem, not an outage; say so, since it will
        -- not fix itself. /api/v1/quota/check needs quotas:read (or OWNER /
        -- ADMIN / DEVELOPER) once RBAC is enforced, which an ingest-only key
        -- scoped usage:ingest does not carry -- hence preflight_quota_api_key.
        local hint = (res.status == 401 or res.status == 403)
            and " -- check preflight_quota_api_key (needs quotas:read)" or ""
        return fallback(conf, dict, "status " .. res.status .. hint)
    end

    local result = cjson.decode(res.body)
    if type(result) ~= "table" then
        return fallback(conf, dict, "unreadable response body")
    end

    -- The controller returns the decision flat; tolerate the platform's
    -- {success, data} envelope too in case a gateway in front adds it.
    local data = type(result.data) == "table" and result.data or result

    if data.decision == "DENY" then
        local retry_after = tonumber(data.retryAfterMs) and math.ceil(data.retryAfterMs / 1000) or 60
        local headers = {
            ["Retry-After"] = tostring(retry_after),
            ["Content-Type"] = "application/json",
        }
        if type(data.headers) == "table" then
            for k, v in pairs(data.headers) do
                headers[k] = v
            end
        end
        kong.response.exit(429, {
            message = data.reason or "Quota exceeded",
            retryAfter = retry_after,
        }, headers)
        return true
    end

    if data.decision == "ALLOW" and dict and ttl_ms > 0 then
        dict:set(cache_key, "ALLOW", ttl_ms / 1000)
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
