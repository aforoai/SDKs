-- Unit tests for aforo-metering Kong plugin
-- Run with: busted spec/

local handler = require("handler")

-- Minimal PDK mock
local mock_kong = {
    request = {
        _headers = {},
        get_header = function(name)
            return mock_kong.request._headers[name]
        end,
        get_headers = function()
            return mock_kong.request._headers
        end,
        get_method = function() return "GET" end,
        get_path = function() return "/v1/accounts/123" end,
        get_raw_body = function() return nil end,
        get_query = function() return {} end,
    },
    response = {
        get_status = function() return 200 end,
        get_header = function(name) return nil end,
    },
    client = {
        get_consumer = function() return nil end,
    },
    router = {
        get_service = function() return { name = "test-svc" } end,
        get_route = function() return { name = "test-route" } end,
    },
    ctx = { shared = {} },
    log = {
        info = function(...) end,
        warn = function(...) end,
        err = function(...) end,
    },
    tools = {
        uuid = function() return "test-uuid" end,
    },
}

-- Replace global kong
_G.kong = mock_kong

describe("aforo-metering handler", function()

    before_each(function()
        mock_kong.request._headers = {}
        mock_kong.ctx.shared = {}
    end)

    describe("access phase", function()

        it("stashes W3C trace context from request headers", function()
            mock_kong.request._headers = {
                ["traceparent"] = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                ["tracestate"] = "congo=t61rcWkgMzE",
                ["x-trace-id"] = "legacy-trace-123",
                ["x-request-id"] = "req-456",
            }

            local conf = {}
            handler:access(conf)

            assert.is_not_nil(mock_kong.ctx.shared.aforo_trace)
            assert.equals(
                "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                mock_kong.ctx.shared.aforo_trace.traceparent
            )
            assert.equals("congo=t61rcWkgMzE", mock_kong.ctx.shared.aforo_trace.tracestate)
            assert.equals("legacy-trace-123", mock_kong.ctx.shared.aforo_trace.xTraceId)
            assert.equals("req-456", mock_kong.ctx.shared.aforo_trace.xRequestId)
        end)

        it("stashes nil values when trace headers are absent", function()
            mock_kong.request._headers = {}

            local conf = {}
            handler:access(conf)

            assert.is_not_nil(mock_kong.ctx.shared.aforo_trace)
            assert.is_nil(mock_kong.ctx.shared.aforo_trace.traceparent)
            assert.is_nil(mock_kong.ctx.shared.aforo_trace.tracestate)
            assert.is_nil(mock_kong.ctx.shared.aforo_trace.xTraceId)
            assert.is_nil(mock_kong.ctx.shared.aforo_trace.xRequestId)
        end)
    end)

    -- ── Security regression tests ───────────────────────────────
    -- Lock in the 2026-04-23 IDOR fix (advisory findings #7-#10).
    -- These assertions must hold on every v2.x+ release.
    describe("resolve_customer_id (security regression)", function()

        it("prefers JWT customer_id over consumer identity", function()
            mock_kong.ctx.shared = {
                aforo_jwt_claims = { customer_id = "cust_from_jwt" }
            }
            local consumer = { username = "cust_from_consumer" }
            local headers = { ["x-customer-id"] = "cust_forged_header" }

            local result = handler._resolve_customer_id({}, consumer, headers)
            assert.equals("cust_from_jwt", result)
        end)

        it("IGNORES x-customer-id request header", function()
            mock_kong.ctx.shared = {}  -- no JWT
            local consumer = nil
            local headers = { ["x-customer-id"] = "cust_forged_header" }

            local result = handler._resolve_customer_id({}, consumer, headers)
            -- Header is IGNORED. Without JWT or consumer, returns nil.
            -- Must NEVER return "cust_forged_header".
            assert.is_nil(result)
        end)

        it("IGNORES ?customer_id= query parameter", function()
            mock_kong.ctx.shared = {}
            mock_kong.request.get_query = function()
                return { customer_id = "cust_forged_query" }
            end

            local result = handler._resolve_customer_id({ customer_id_source = "query_param" }, nil, {})
            -- customer_id_source="query_param" is no longer accepted.
            -- The legacy config value must never reach into the query string.
            assert.is_nil(result)

            mock_kong.request.get_query = function() return {} end  -- reset
        end)

        it("falls back to Kong consumer identity when no JWT", function()
            mock_kong.ctx.shared = {}
            local consumer = { custom_id = "consumer_custom_1" }

            local result = handler._resolve_customer_id({}, consumer, {})
            assert.equals("consumer_custom_1", result)
        end)

        it("IGNORES customer_id_source='header' legacy config", function()
            mock_kong.ctx.shared = {}
            local headers = { ["x-customer-id"] = "cust_forged" }

            local result = handler._resolve_customer_id(
                { customer_id_source = "header" }, nil, headers)
            -- customer_id_source="header" was removed from the schema
            -- one_of list 2026-04-23. A stale config that still carries
            -- the value must NOT cause the header to be trusted.
            assert.is_nil(result)
        end)
    end)
end)
