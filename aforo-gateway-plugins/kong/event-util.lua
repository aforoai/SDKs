-- Event helpers shared by handler.lua and compound-metering.lua, so both
-- build events the ingestor accepts the same way: one UUID source that works
-- on every supported Kong, and one occurredAt format.

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
        -- Never leave this nil: both callers use it inside idempotency keys on
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
-- Drop metric (2026-07-05, delivery guarantee; carried into 2.6.0)
--
-- Permanent event loss is counted, not only logged:
--   1. per-reason counters in the shared dict ("aforo_dropped:<reason>" in
--      lua_shared_dict aforo_buffer) -- always on, readable from any worker
--   2. Prometheus aforo_metering_dropped_events_total{reason} when Kong's
--      prometheus plugin is loaded. Every touch is pcall-guarded: a metrics
--      failure never breaks metering or request handling.
-- Reasons: buffer_overflow, rejected (the ingestor refused a batch or a
-- lone event), ingestor_rejected (per-event errors in a 2xx answer),
-- expired (too old for the ingestor), too_large, missing_fields,
-- invalid_field. Returns the cumulative count for the reason, or nil.
-- Safe in request (log phase) and timer (flush) contexts.
-- ────────────────────────────────────────────────────────────
local DROP_DICT = "aforo_buffer"
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
    local dict = ngx.shared and ngx.shared[DROP_DICT]
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

return M
