-- Aforo Compound Metering Module for Kong Gateway
-- Extracts multiple metric measurements from API response bodies using JSONPath
-- and emits compound usage events to the Aforo usage ingestor service.
--
-- Runs in the `log` phase (zero latency impact on client response).
-- Requires: resty.http, cjson

local cjson = require("cjson.safe")

local M = {}

-- ────────────────────────────────────────────────────────────
-- JSONPath-lite: supports simple dotted paths and array indices
-- e.g., "$.usage.prompt_tokens", "$.data[0].tokens"
-- ────────────────────────────────────────────────────────────

local function resolve_jsonpath(obj, path)
    if not obj or not path then return nil end
    -- Strip leading "$." prefix
    local clean = path:match("^%$%.(.+)$") or path
    local current = obj
    for segment in clean:gmatch("[^%.]+") do
        if current == nil then return nil end
        -- Handle array index: segment[0]
        local key, idx = segment:match("^(.+)%[(%d+)%]$")
        if key then
            current = current[key]
            if type(current) == "table" then
                current = current[tonumber(idx) + 1] -- Lua 1-indexed
            else
                return nil
            end
        else
            if type(current) ~= "table" then return nil end
            current = current[segment]
        end
    end
    return current
end

-- ────────────────────────────────────────────────────────────
-- Extract compound measurements from response body
-- ────────────────────────────────────────────────────────────

function M.extract_measurements(response_body, extraction_paths, dimension_paths)
    if not response_body or response_body == "" then return nil end

    local ok, parsed = pcall(cjson.decode, response_body)
    if not ok or not parsed then
        kong.log.debug("[aforo-compound] Response body is not valid JSON, skipping extraction")
        return nil
    end

    local measurements = {}
    for jsonpath, metric_name in pairs(extraction_paths or {}) do
        local value = resolve_jsonpath(parsed, jsonpath)
        if value and type(value) == "number" and value > 0 then
            local measurement = {
                metricName = metric_name,
                quantity = value,
            }
            -- Extract optional dimension key for this metric
            if dimension_paths then
                for dim_path, dim_key in pairs(dimension_paths) do
                    local dim_value = resolve_jsonpath(parsed, dim_path)
                    if dim_value and type(dim_value) == "string" then
                        measurement.dimensionKey = dim_value
                        break -- one dimension per measurement
                    end
                end
            end
            table.insert(measurements, measurement)
        end
        -- Zero or nil values silently skipped
    end

    return #measurements > 0 and measurements or nil
end

-- ────────────────────────────────────────────────────────────
-- Deterministic correlationId (FROZEN — A+ compound-key freeze, 2026-07-05)
--
-- Dedup-safety basis: the ingestor types correlationId as a UUID and
-- CompoundEventDecomposer derives EVERY per-metric dedup key from it —
--   correlationId:metricName[:dimensionKey]:index
-- — so the correlationId is the dedup ROOT for the whole compound event.
-- The pre-freeze random-uuid call minted a NEW random id per build; any
-- wiring that rebuilds the event per delivery attempt (or any future
-- redelivery transport) would decompose to NEW keys → double-billing.
-- Now the id is derived purely from the request's stable identity, so
-- rebuilding it any number of times within the same request — including
-- across handler.lua's 3 flush retries — yields a byte-identical
-- correlationId and the ingest dedups instead of double-billing.
-- Identity preference mirrors handler.lua's frozen standard key:
-- client X-Request-Id header (caller-controlled dedup contract) >
-- ngx.var.request_id (nginx per-request id, stable through the log
-- phase) > one-time random LAST RESORT (dedup opt-out for that single
-- event; effectively unreachable — ngx.var.request_id always exists
-- under nginx). NEVER put a clock or per-call random back in here.
-- ────────────────────────────────────────────────────────────

-- Lua gotcha: "" is TRUTHY. An empty client-supplied X-Request-Id must
-- never become the seed — every such request would derive the SAME
-- correlationId, and the server would silently dedup real events as
-- replays (revenue loss, undetectable because the shared id is a valid
-- UUID). Normalize empty to nil so the identity chain falls through.
local function nonempty(v)
    if v == nil or v == "" then return nil end
    return v
end

-- resty.jit-uuid is bundled with OpenResty/Kong; loaded lazily + pcall-guarded so this
-- module still loads under the plain-Lua unit tests. Replaces a broken PDK uuid call: the
-- `kong` global exposes no `tools` field on Kong 3.x, so it crashed the build. Random v4 —
-- the last-resort correlationId is a documented dedup opt-out (see the block above).
local _jit_uuid
local function random_uuid()
    if _jit_uuid == nil then
        local ok, mod = pcall(require, "resty.jit-uuid")
        _jit_uuid = (ok and type(mod) == "table" and mod) or false
    end
    if _jit_uuid and _jit_uuid.generate_v4 then
        return _jit_uuid.generate_v4()
    end
    return nil
end

-- ISO-8601 UTC with milliseconds ("2026-09-30T15:48:29.554Z"), the format the
-- ingestor's occurredAt (java.time.Instant) expects and the other four gateways
-- send. A bare number is read as epoch SECONDS by Jackson, so the old
-- ngx.now() * 1000 (epoch millis) parsed as the year 58717 and every event
-- failed the ingestor's future-timestamp check.
local function iso8601_utc(t)
    local sec = math.floor(t)
    local ms = math.floor((t - sec) * 1000 + 0.5)
    if ms >= 1000 then
        sec = sec + 1
        ms = ms - 1000
    end
    return os.date("!%Y-%m-%dT%H:%M:%S", sec) .. string.format(".%03dZ", ms)
end

local function derive_correlation_id(seed)
    local hex = ngx.md5("aforo-compound:" .. seed)
    -- Format as an RFC-4122 v3-style UUID (version nibble 3, variant
    -- 10xx) so the ingestor's UUID-typed correlationId field parses it.
    -- (n % 4) + 8 == (n & 0x3) | 0x8 — arithmetic form, no bit library.
    local variant = string.format("%x", (tonumber(hex:sub(17, 17), 16) % 4) + 8)
    return hex:sub(1, 8) .. "-" .. hex:sub(9, 12) ..
           "-3" .. hex:sub(14, 16) ..
           "-" .. variant .. hex:sub(18, 20) ..
           "-" .. hex:sub(21, 32)
end

-- ────────────────────────────────────────────────────────────
-- Build CompoundUsageEventRequest from extracted measurements
-- ────────────────────────────────────────────────────────────

function M.build_compound_event(customer_id, measurements, metadata, product_type)
    if not measurements or #measurements == 0 then return nil end

    local seed = nonempty(kong.request.get_header("X-Request-Id"))
        or nonempty(ngx.var.request_id)
    local correlation_id
    if seed then
        correlation_id = derive_correlation_id(seed)
    else
        correlation_id = random_uuid() -- last resort: random v4, NOT retry-safe
        kong.log.warn("[aforo-compound] no stable request identity — ",
                      "random correlationId is a dedup opt-out for this event")
    end

    return {
        correlationId = correlation_id,
        customerId    = customer_id,
        productType   = product_type or "API",
        occurredAt    = iso8601_utc(ngx.now()),
        metadata      = metadata,
        measurements  = measurements,
    }
end

-- ────────────────────────────────────────────────────────────
-- Default extraction paths for common API patterns
-- ────────────────────────────────────────────────────────────

M.DEFAULT_LLM_PATHS = {
    ["$.usage.prompt_tokens"]     = "input-tokens",
    ["$.usage.completion_tokens"] = "output-tokens",
    ["$.usage.total_tokens"]      = "total-tokens",
}

M.DEFAULT_CDN_PATHS = {
    ["$.bandwidth.in_bytes"]  = "bandwidth-in-gb",
    ["$.bandwidth.out_bytes"] = "bandwidth-out-gb",
    ["$.compute.seconds"]     = "compute-seconds",
    ["$.request_count"]       = "request-count",
}

M.DEFAULT_PAYMENT_PATHS = {
    ["$.transaction.amount"]     = "transaction-amount",
    ["$.transaction.fee_percent"] = "fee-percentage",
    ["$.transaction.fee_fixed"]   = "fee-fixed",
}

M.DEFAULT_DIMENSION_PATHS = {
    ["$.model"]  = "model-name",
    ["$.region"] = "region",
}

M._iso8601_utc = iso8601_utc

return M
