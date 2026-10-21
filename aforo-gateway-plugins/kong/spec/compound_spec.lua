-- compound-metering.lua and the event-util.lua helpers it shares with handler.lua.
-- Run with: busted spec/

local cjson = require("cjson.safe")

_G.ngx = {
    now = function() return 1788268682.221 end,
    worker = { pid = function() return 1 end },
}
-- The PDK without kong.tools, as in Kong 3.x: the module used to call
-- kong.tools.uuid(), which raised here.
_G.kong = { log = { debug = function() end, warn = function() end } }

package.path = "./?.lua;" .. package.path
local compound = require("compound-metering")
local event_util = require("event-util")

describe("compound metering", function()
    local LLM_BODY = cjson.encode({
        model = "gpt-x",
        usage = { prompt_tokens = 120, completion_tokens = 30, total_tokens = 150 },
    })

    it("builds an event the ingestor accepts: ISO-8601 occurredAt and a correlation id", function()
        local measurements = compound.extract_measurements(LLM_BODY, compound.DEFAULT_LLM_PATHS,
            compound.DEFAULT_DIMENSION_PATHS)
        local event
        assert.has_no.errors(function()
            event = compound.build_compound_event("cust-1", measurements, { route = "chat" })
        end)
        assert.equals("cust-1", event.customerId)
        assert.equals("API", event.productType)
        -- A string the ingestor cannot misread, not epoch milliseconds.
        assert.equals("2026-09-01T13:18:02.221Z", event.occurredAt)
        assert.equals("string", type(event.correlationId))
        assert.not_equals(event.correlationId, compound.build_compound_event("cust-1", measurements).correlationId)
        assert.equals(3, #event.measurements)
        local by_metric = {}
        for _, m in ipairs(event.measurements) do by_metric[m.metricName] = m end
        assert.equals(120, by_metric["input-tokens"].quantity)
        assert.equals("gpt-x", by_metric["input-tokens"].dimensionKey)
    end)

    it("passes an explicit productType through", function()
        local m = compound.extract_measurements(LLM_BODY, compound.DEFAULT_LLM_PATHS)
        assert.equals("AI_AGENT", compound.build_compound_event("cust-1", m, nil, "AI_AGENT").productType)
    end)

    it("bills byte counts to byte metrics, not GB metrics", function()
        local body = cjson.encode({ bandwidth = { in_bytes = 1000000000, out_bytes = 5 } })
        local m = compound.extract_measurements(body, compound.DEFAULT_CDN_PATHS)
        local by_metric = {}
        for _, x in ipairs(m) do by_metric[x.metricName] = x.quantity end
        assert.equals(1000000000, by_metric["bandwidth-in-bytes"])
        assert.equals(5, by_metric["bandwidth-out-bytes"])
        for name in pairs(compound.DEFAULT_CDN_PATHS) do
            assert.is_nil(compound.DEFAULT_CDN_PATHS[name]:find("%-gb$"))
        end
    end)

    it("skips zero, missing and non-numeric values, and non-JSON bodies", function()
        local body = cjson.encode({ usage = { prompt_tokens = 0, completion_tokens = cjson.null,
                                              total_tokens = "12" } })
        assert.is_nil(compound.extract_measurements(body, compound.DEFAULT_LLM_PATHS))
        assert.is_nil(compound.extract_measurements("not json", compound.DEFAULT_LLM_PATHS))
        assert.is_nil(compound.build_compound_event("cust-1", nil))
    end)

    it("formats occurredAt with millisecond rounding", function()
        assert.equals("2026-09-01T13:18:02.000Z", event_util.iso8601_utc(1788268682))
        assert.equals("2026-09-01T13:18:03.000Z", event_util.iso8601_utc(1788268682.9996))
    end)
end)
