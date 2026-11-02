-- Helpers shared by the plugin's modules: one UUID source that works on every
-- supported Kong, one occurredAt format, the drop counters, and the shared
-- dict used for caches (cache_dict).

local M = {}

-- UUID source (2026-09-01 fix).
--
-- handler.lua's call sites previously reached for the uuid helper through the
-- PDK global. `kong.tools` is not part of the PDK in Kong 3.x, so that raised
-- "attempt to index field 'tools' (a nil value)" and aborted the entire log
-- phase -- meaning no event was buffered and the plugin metered nothing. The
-- module also moved between releases: kong.tools.utils.uuid before Kong 3.9,
-- kong.tools.uuid.uuid from 3.9 on. Resolve once at load with a fallback chain
-- so the plugin spans both without a version check.
local uuid
do
    local function try(mod_name, fn_name)
        local ok, mod = pcall(require, mod_name)
        if ok and type(mod) == "table" and type(mod[fn_name]) == "function" then
            return mod[fn_name]
        end
        return nil
    end

    uuid = try("kong.tools.uuid", "uuid")        -- Kong >= 3.9
        or try("kong.tools.utils", "uuid")       -- Kong <  3.9

    if not uuid then
        local ok, jit_uuid = pcall(require, "resty.jit-uuid")
        if ok and type(jit_uuid) == "table" and type(jit_uuid.generate_v4) == "function" then
            pcall(jit_uuid.seed)
            uuid = jit_uuid.generate_v4
        end
    end

    if not uuid then
        -- Never leave this nil: callers use it inside idempotency keys on
        -- the metering hot path, and a nil here takes down the log phase again.
        -- Not a real UUID, but unique enough to keep events distinct.
        uuid = function()
            return string.format("%d-%d-%d", ngx.worker.pid(), ngx.now() * 1000, math.random(1e9))
        end
    end
end

M.uuid = uuid

-- Format an epoch timestamp as ISO-8601 UTC with milliseconds.
--
-- 2026-09-01 fix. occurredAt was emitted as `ngx.now() * 1000`, i.e. a bare
-- number of epoch MILLIseconds. The ingestor deserialises occurredAt into a
-- java.time.Instant, and Jackson reads a bare number as epoch SECONDS -- so
-- 1788268682221 was read as the year 58637 and every single event was rejected
-- with "Event timestamp is too far in the future". Gateway-metered usage never
-- persisted at all.
--
-- It failed quietly in the worst way: /v1/ingest/batch answers 202 with a
-- per-event `failed` count rather than an HTTP error, so the plugin's own
-- flush logged success and moved on. Emitting a string removes the ambiguity
-- entirely -- there is no unit to misread.
local function iso8601_utc(epoch_seconds)
    local secs = math.floor(epoch_seconds)
    local ms = math.floor((epoch_seconds - secs) * 1000 + 0.5)
    if ms >= 1000 then
        secs = secs + 1
        ms = 0
    end
    return string.format("%s.%03dZ", os.date("!%Y-%m-%dT%H:%M:%S", secs), ms)
end

M.iso8601_utc = iso8601_utc

-- ────────────────────────────────────────────────────────────
-- Shared dicts (2.8.0, G323)
--
-- aforo_buffer holds the events and the delivery state of each buffer.
-- aforo_cache holds everything else this plugin writes to shared memory:
-- the pre-flight quota cache and breaker, the margin guard cache, the
-- rate-limit policy cache, the metric mappings, warning throttles and the
-- drop / revocation counters. Before 2.8.0 all of it shared aforo_buffer,
-- so caches and counters competed with buffered events for the same 10 MB:
-- a full dict refused new events (rpush never evicts), and incr() with an
-- init value evicts the least recently used entries like set() does.
--
-- aforo_cache is optional for upgrades: when it is not declared, caches
-- fall back to aforo_buffer and the worker logs one error saying so. When
-- neither is declared, cache_dict() returns nil and every caller works
-- uncached (and logs that once).
-- ────────────────────────────────────────────────────────────
local CACHE_DICT = "aforo_cache"
local EVENT_DICT = "aforo_buffer"
M.CACHE_DICT = CACHE_DICT
M.EVENT_DICT = EVENT_DICT

local cache_dict_warned = false

local function log_err(...)
    if kong and kong.log and kong.log.err then kong.log.err(...) end
end

function M.cache_dict()
    local shared = ngx and ngx.shared
    if not shared then return nil end
    local dict = shared[CACHE_DICT]
    if dict then return dict end
    dict = shared[EVENT_DICT]
    if not cache_dict_warned then
        cache_dict_warned = true
        if dict then
            log_err("[aforo-metering] Shared dict '", CACHE_DICT, "' is not declared: caches, ",
                "warning throttles and counters share '", EVENT_DICT, "' with buffered events, ",
                "so they can crowd events out of it. Add `lua_shared_dict ", CACHE_DICT,
                " 5m` (kong.conf: nginx_http_lua_shared_dict = ", CACHE_DICT, " 5m). Logged once per worker.")
        else
            log_err("[aforo-metering] Shared dicts '", CACHE_DICT, "' and '", EVENT_DICT,
                "' are not declared: nothing is cached, so the margin guard, pre-flight quota and rate-limit ",
                "checks call their services on every request, and no event is metered. Add ",
                "`lua_shared_dict ", EVENT_DICT, " 10m` and `lua_shared_dict ", CACHE_DICT,
                " 5m`. Logged once per worker.")
        end
    end
    return dict
end

function M._reset_cache_dict_warning()
    cache_dict_warned = false
end

-- ────────────────────────────────────────────────────────────
-- Drop metric (2026-07-05, delivery guarantee; carried into 2.6.0)
--
-- Permanent event loss is counted, not only logged:
--   1. per-reason counters in the shared dict ("aforo_dropped:<reason>" in
--      lua_shared_dict aforo_cache, else aforo_buffer) -- always on, readable
--      from any worker
--   2. Prometheus aforo_metering_dropped_events_total{reason} when Kong's
--      prometheus plugin is loaded. Every touch is pcall-guarded: a metrics
--      failure never breaks metering or request handling.
-- Reasons: buffer_overflow, rejected (the ingestor refused a batch or a
-- lone event), ingestor_rejected (per-event errors in a 2xx answer),
-- expired (too old for the ingestor), too_large, missing_fields,
-- invalid_field. Returns the cumulative count for the reason, or nil.
-- Safe in request (log phase) and timer (flush) contexts.
-- ────────────────────────────────────────────────────────────
local DROP_KEY_PREFIX = "aforo_dropped:"
local prometheus_drop_counter  -- nil = not yet resolved; false = unavailable

local function get_prometheus_drop_counter()
    if prometheus_drop_counter ~= nil then
        return prometheus_drop_counter or nil
    end
    local ok, exporter = pcall(require, "kong.plugins.prometheus.exporter")
    if ok and type(exporter) == "table" and type(exporter.get_prometheus) == "function" then
        local got, prom = pcall(exporter.get_prometheus)
        if got and prom and type(prom.counter) == "function" then
            local reg, counter = pcall(prom.counter, prom,
                "aforo_metering_dropped_events_total",
                "Usage events permanently dropped by the aforo-metering plugin",
                { "reason" })
            if reg and counter then
                prometheus_drop_counter = counter
                return counter
            end
        end
    end
    prometheus_drop_counter = false
    return nil
end

function M.record_drop(reason, count)
    count = tonumber(count) or 0
    if count <= 0 then return nil end
    local total
    local dict = M.cache_dict()
    if dict then
        total = dict:incr(DROP_KEY_PREFIX .. reason, count, 0)
    end
    local counter = get_prometheus_drop_counter()
    if counter then
        pcall(counter.inc, counter, count, { reason })
    end
    return total
end

function M._reset_drop_counter()
    prometheus_drop_counter = nil
end

-- ── Circuit breaker (shared by preflight-quota.lua and margin-guard.lua) ──
-- State lives in a shared dict so all workers agree. bkey is the caller's
-- breaker key; the keys used under it:
--   <bkey>:fails   consecutive failures (expires after cooldown * 6 of quiet,
--                  so old failures do not add up)
--   <bkey>:open    breaker open, expires at the end of the cool-down
--   <bkey>:tripped breaker has opened and no probe has succeeded since
--   <bkey>:probe   one request is probing
-- threshold <= 0 or no dict: the breaker is off and always allows.

-- Normalises a threshold / cool-down pair: nil threshold -> default_threshold,
-- cool-down at least 1 s.
function M.breaker_settings(threshold, cooldown, default_threshold, default_cooldown)
    threshold = tonumber(threshold)
    if threshold == nil then threshold = default_threshold end
    cooldown = tonumber(cooldown) or default_cooldown
    if cooldown < 1 then cooldown = 1 end
    return threshold, cooldown
end

-- true when the call may go ahead, false when the breaker says skip it.
-- probe_ttl_s: how long a half-open probe holds its claim (the call's timeout
-- plus a margin), so a probe whose worker died is replaced.
function M.breaker_allows(dict, bkey, threshold, probe_ttl_s)
    if not dict or threshold <= 0 then return true end
    if dict:get(bkey .. ":open") then return false end
    if dict:get(bkey .. ":tripped") then
        local claimed = dict:safe_add(bkey .. ":probe", 1, probe_ttl_s)
        return claimed and true or false
    end
    return true
end

function M.breaker_success(dict, bkey)
    if not dict then return end
    dict:delete(bkey .. ":fails")
    dict:delete(bkey .. ":tripped")
    dict:delete(bkey .. ":probe")
end

-- Records a failure. Returns (opened, fails, was_tripped): opened is true when
-- this failure opened (or re-opened, after a failed probe) the breaker.
function M.breaker_failure(dict, bkey, threshold, cooldown)
    if not dict or threshold <= 0 then return false, 0, false end
    local tripped = dict:get(bkey .. ":tripped") and true or false
    local fails = 0
    if not tripped then
        fails = dict:incr(bkey .. ":fails", 1, 0, cooldown * 6) or 0
    end
    if tripped or fails >= threshold then
        dict:safe_set(bkey .. ":open", 1, cooldown)
        dict:safe_set(bkey .. ":tripped", 1, cooldown * 60)
        dict:delete(bkey .. ":probe")
        dict:delete(bkey .. ":fails")
        return true, fails, tripped
    end
    return false, fails, tripped
end

return M
