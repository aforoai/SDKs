-- Aforo Compound Metering Module for Kong Gateway
-- Extracts multiple metric measurements from API response bodies using JSONPath
-- and emits compound usage events to the Aforo usage ingestor service.
--
-- Runs in the `log` phase (zero latency impact on client response).
-- Requires: resty.http, cjson
--
-- Not called by handler.lua yet; it ships in the rockspec for integrations
-- that build compound events themselves.

local cjson = require("cjson.safe")

-- Installed: kong.plugins.aforo-metering.event-util. From the source tree
-- (busted): the bare filename. Same fallback as handler.lua.
local function require_sibling(name)
    local ok, mod = pcall(require, "kong.plugins.aforo-metering." .. name)
    if ok then
        return mod
    end
    return require(name)
end

local event_util = require_sibling("event-util")

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
-- Build CompoundUsageEventRequest from extracted measurements
-- ────────────────────────────────────────────────────────────

function M.build_compound_event(customer_id, measurements, metadata, product_type)
    if not measurements or #measurements == 0 then return nil end

    -- 2026-10-12: kong.tools.uuid() does not exist in Kong 3.x (it raised), and
    -- occurredAt was epoch MILLIseconds, which the ingestor reads as seconds
    -- -- the same two faults handler.lua had, fixed the same way.
    return {
        correlationId = event_util.uuid(),
        customerId    = customer_id,
        productType   = product_type or "API",
        occurredAt    = event_util.iso8601_utc(ngx.now()),
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

-- Byte counts go to byte metrics. They used to be sent as bandwidth-in-gb /
-- -out-gb with the raw byte count as the quantity: a 1 GB transfer billed as a
-- billion GB. Renamed rather than converted, so no unit (GB or GiB?) and no
-- rounding is guessed here; the catalog metric decides how bytes are priced.
M.DEFAULT_CDN_PATHS = {
    ["$.bandwidth.in_bytes"]  = "bandwidth-in-bytes",
    ["$.bandwidth.out_bytes"] = "bandwidth-out-bytes",
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

return M
