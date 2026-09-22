-- Unit tests for aforo-metering Kong plugin
-- Run with: busted spec/

-- ── ngx / resty.http mocks ─────────────────────────────────────
-- Installed BEFORE requiring the handler so it binds to them. The shared dict
-- implements the list operations the event buffer relies on with OpenResty's
-- semantics (atomic per call; list ops on a non-list key fail).
local function new_shared_dict()
    local d = { store = {}, fail_push = false }
    function d:get(k) return self.store[k] end
    function d:set(k, v) self.store[k] = v; return true end
    function d:add(k, v)
        if self.store[k] ~= nil then return false, "exists" end
        self.store[k] = v; return true
    end
    function d:delete(k) self.store[k] = nil end
    local function list(self, k, create)
        local v = self.store[k]
        if v == nil then
            if not create then return nil end
            v = { __list = true }; self.store[k] = v
        end
        if type(v) ~= "table" or not v.__list then return nil, "value not a list" end
        return v
    end
    function d:rpush(k, v)
        if self.fail_push then return nil, "no memory" end
        local l, err = list(self, k, true); if not l then return nil, err end
        l[#l + 1] = v; return #l
    end
    function d:lpush(k, v)
        if self.fail_push then return nil, "no memory" end
        local l, err = list(self, k, true); if not l then return nil, err end
        table.insert(l, 1, v); return #l
    end
    function d:lpop(k)
        local l, err = list(self, k, false); if not l then return nil, err end
        local v = table.remove(l, 1)
        if #l == 0 then self.store[k] = nil end
        return v
    end
    function d:rpop(k)
        local l, err = list(self, k, false); if not l then return nil, err end
        local v = table.remove(l)
        if #l == 0 then self.store[k] = nil end
        return v
    end
    function d:llen(k)
        local l, err = list(self, k, false)
        if err then return nil, err end
        return l and #l or 0
    end
    return d
end

_G.ngx = _G.ngx or {}
ngx.shared = { aforo_buffer = new_shared_dict() }
ngx.timers = {}
ngx.timer = { at = function(delay, fn, ...) table.insert(ngx.timers, { delay = delay, fn = fn, args = { ... } }); return true end }
ngx.now = function() return 1788268682.221 end
ngx.sleeps = {}
ngx.sleep = function(s) table.insert(ngx.sleeps, s) end
ngx.worker = ngx.worker or { pid = function() return 1 end }
ngx.escape_uri = ngx.escape_uri or function(s) return s end

-- resty.http mock: records every request and answers from a queue of
-- scripted responses ({status=...} or {err="timeout"}); default 202.
local http_mock = { requests = {}, responses = {} }
package.loaded["resty.http"] = {
    new = function()
        return {
            set_timeout = function() end,
            request_uri = function(_, url, params)
                table.insert(http_mock.requests, { url = url, params = params })
                if http_mock.on_request then http_mock.on_request(#http_mock.requests) end
                local r = table.remove(http_mock.responses, 1) or { status = 202 }
                if r.err then return nil, r.err end
                return { status = r.status, body = r.body or "", headers = r.headers or {} }
            end,
        }
    end,
}

local cjson = require("cjson.safe")
local handler = require("handler")

-- Minimal PDK mock.
-- Declared before it is assigned: the accessors below refer to mock_kong, and
-- inside its own table constructor a `local mock_kong = {...}` is not yet in
-- scope -- they resolved the nil global instead and every access-phase test
-- failed with "attempt to index global 'mock_kong'".
local mock_kong
mock_kong = {
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
        -- Records instead of exiting, as Kong's access phase does: exit only
        -- stores the response and the handler keeps running unless it returns.
        _exit = nil,
        _set_headers = {},
        exit = function(status, body, headers)
            mock_kong.response._exit = { status = status, body = body, headers = headers }
        end,
        set_header = function(name, value)
            mock_kong.response._set_headers[name] = value
        end,
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
    -- ── Event buffer (shared-dict list) ─────────────────────────
    -- Locks in the 2026-09-21 fix: the buffer was a JSON array under one key,
    -- appended by get/decode/insert/set and drained by get/delete, so
    -- concurrent workers lost events. It is now a list touched only by atomic
    -- rpush / lpop / lpush / rpop.
    describe("event buffer", function()
        local BUFFER_KEY = "aforo:events"
        local dict
        local conf = {
            aforo_endpoint = "http://ingestor.test/v1/ingest/batch",
            api_key = "sk_test_key",
            tenant_id = "tenant_1",
            default_metric = "api_calls",
            flush_count = 50,
            flush_interval_ms = 5000,
            exclude_paths = {},
            exclude_status_codes = {},
        }

        local function log_request(customer_id)
            mock_kong.ctx.shared = { aforo_jwt_claims = { customer_id = customer_id } }
            handler:log(conf)
        end

        local function buffered()
            local l = dict.store[BUFFER_KEY]
            local out = {}
            for i = 1, (l and #l or 0) do out[i] = cjson.decode(l[i]) end
            return out
        end

        local function fill(n, prefix)
            for i = 1, n do
                dict:rpush(BUFFER_KEY, cjson.encode({ customerId = (prefix or "c") .. i }))
            end
        end

        local function sent_events(i)
            return cjson.decode(http_mock.requests[i].params.body).events
        end

        before_each(function()
            dict = new_shared_dict()
            ngx.shared.aforo_buffer = dict
            ngx.timers = {}
            http_mock.requests = {}
            http_mock.responses = {}
            http_mock.on_request = nil
        end)

        it("appends each event as its own list element with a single atomic push", function()
            -- Record every operation that touches the buffer key: the fix is
            -- precisely that no read-modify-write sequence remains.
            local ops = {}
            for _, name in ipairs({ "get", "set", "rpush", "lpush", "lpop", "rpop", "delete" }) do
                local orig = dict[name]
                dict[name] = function(self, k, ...)
                    if k == BUFFER_KEY then table.insert(ops, name) end
                    return orig(self, k, ...)
                end
            end

            log_request("cust_a")
            log_request("cust_b")
            log_request("cust_c")

            assert.same({ "rpush", "rpush", "rpush" }, ops)
            local events = buffered()
            assert.equals(3, #events)
            assert.equals("cust_a", events[1].customerId)
            assert.equals("cust_c", events[3].customerId)
            -- Only the first event, into an empty buffer, schedules the timed flush.
            assert.equals(1, #ngx.timers)
            assert.equals(5, ngx.timers[1].delay)
        end)

        it("schedules an immediate flush once flush_count events are buffered", function()
            fill(49)
            log_request("cust_50")
            assert.equals(1, #ngx.timers)
            assert.equals(0, ngx.timers[1].delay)
        end)

        it("caps the buffer at MAX_BUFFER_SIZE, dropping the newest, and still schedules a flush", function()
            fill(10000)
            log_request("cust_overflow")
            local events = buffered()
            assert.equals(10000, #events)
            assert.equals("c10000", events[10000].customerId)
            -- A full buffer must not stop flushing forever.
            assert.equals(1, #ngx.timers)
            -- ...but not one flush per dropped request.
            log_request("cust_overflow_2")
            assert.equals(1, #ngx.timers)
        end)

        it("flushes with X-API-Key alone and empties the buffer", function()
            fill(3)
            handler._flush_buffer(false, conf)

            assert.equals(1, #http_mock.requests)
            local headers = http_mock.requests[1].params.headers
            assert.equals("sk_test_key", headers["X-API-Key"])
            assert.is_nil(headers["Authorization"])
            assert.equals(3, #sent_events(1))
            assert.equals(0, #buffered())
        end)

        it("drains a backlog in batches the ingestor accepts (<= 1000)", function()
            fill(2500)
            handler._flush_buffer(false, conf)

            assert.equals(3, #http_mock.requests)
            assert.equals(1000, #sent_events(1))
            assert.equals(1000, #sent_events(2))
            assert.equals(500, #sent_events(3))
            assert.equals("c1", sent_events(1)[1].customerId)
            assert.equals("c2500", sent_events(3)[500].customerId)
            assert.equals(0, #buffered())
        end)

        it("drops a batch rejected with 4xx and keeps draining the rest", function()
            fill(1500)
            http_mock.responses = { { status = 400, body = "bad event" } }
            handler._flush_buffer(false, conf)

            -- One attempt for the rejected batch (no retry), one for the remainder.
            assert.equals(2, #http_mock.requests)
            assert.equals(500, #sent_events(2))
            assert.equals(0, #buffered())
        end)

        it("re-buffers on 5xx ahead of events that arrived during the attempt", function()
            fill(2, "old")
            http_mock.responses = { { status = 503 }, { status = 503 }, { status = 503 } }
            http_mock.on_request = function(n)
                if n == 1 then dict:rpush(BUFFER_KEY, cjson.encode({ customerId = "new1" })) end
            end
            handler._flush_buffer(false, conf)

            assert.equals(3, #http_mock.requests)
            local events = buffered()
            assert.equals(3, #events)
            assert.equals("old1", events[1].customerId)
            assert.equals("old2", events[2].customerId)
            assert.equals("new1", events[3].customerId)
        end)

        it("re-buffers on timeout and on 429, which invite a retry", function()
            fill(1)
            http_mock.responses = { { err = "timeout" }, { err = "timeout" }, { err = "timeout" } }
            handler._flush_buffer(false, conf)
            assert.equals(1, #buffered())

            http_mock.responses = { { status = 429 }, { status = 429 }, { status = 429 } }
            handler._flush_buffer(false, conf)
            assert.equals(1, #buffered())
        end)

        it("honours Retry-After on 429 and re-buffers past the cap", function()
            fill(1)
            ngx.sleeps = {}
            http_mock.responses = {
                { status = 429, headers = { ["Retry-After"] = "7" } },
                { status = 202 },
            }
            handler._flush_buffer(false, conf)
            assert.same({ 7 }, ngx.sleeps)
            assert.equals(0, #buffered())

            fill(1)
            ngx.sleeps = {}
            http_mock.requests = {}
            http_mock.responses = { { status = 429, headers = { ["Retry-After"] = "3600" } } }
            handler._flush_buffer(false, conf)
            -- No hour-long sleep inside the timer: one attempt, then re-buffered.
            assert.equals(1, #http_mock.requests)
            assert.same({}, ngx.sleeps)
            assert.equals(1, #buffered())
        end)

        it("keeps the oldest when a re-buffer would exceed MAX_BUFFER_SIZE", function()
            fill(10, "old")
            http_mock.responses = { { status = 500 }, { status = 500 }, { status = 500 } }
            http_mock.on_request = function(n)
                -- The buffer refills to the cap while the batch is in flight.
                if n == 1 then fill(10000, "new") end
            end
            handler._flush_buffer(false, conf)

            local events = buffered()
            assert.equals(10000, #events)
            assert.equals("old1", events[1].customerId)
            assert.equals("old10", events[10].customerId)
            assert.equals("new9990", events[10000].customerId)
        end)
    end)
    -- ── productType ─────────────────────────────────────────────
    describe("product_type", function()
        local BUFFER_KEY = "aforo:events"
        local dict
        local function conf(pt)
            return {
                aforo_endpoint = "http://ingestor.test/v1/ingest/batch",
                api_key = "sk_test_key",
                default_metric = "api_calls",
                product_type = pt,
                mcp_enabled = true,
                exclude_paths = {},
                exclude_status_codes = {},
            }
        end
        local function buffered()
            local l = dict.store[BUFFER_KEY]
            local out = {}
            for i = 1, (l and #l or 0) do out[i] = cjson.decode(l[i]) end
            return out
        end
        local function log(c, method, raw_body, headers)
            mock_kong.request._headers = headers or {}
            mock_kong.ctx.shared = {
                aforo_jwt_claims = { customer_id = "cust_a" },
                aforo_raw_body = raw_body,
            }
            local orig = mock_kong.request.get_method
            mock_kong.request.get_method = function() return method or "GET" end
            handler:log(c)
            mock_kong.request.get_method = orig
        end
        local TOOL_CALL = '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search"}}'

        before_each(function()
            dict = new_shared_dict()
            ngx.shared.aforo_buffer = dict
            ngx.timers = {}
        end)

        it("defaults to API on every event", function()
            log(conf(nil))
            assert.equals("API", buffered()[1].productType)
        end)

        it("trims and upper-cases the configured value, passing unknown types through", function()
            log(conf("  agentic_api "))
            log(conf("NEW_TYPE"))
            local events = buffered()
            assert.equals("AGENTIC_API", events[1].productType)
            assert.equals("NEW_TYPE", events[2].productType)
        end)

        it("skips events missing the fields their type requires", function()
            log(conf("GRAPHQL_API"))
            log(conf("AI_AGENT"))
            -- X-Agent-Id is client-settable, never a source for agentId.
            log(conf("AI_AGENT"), "GET", nil, { ["x-agent-id"] = "agent_forged", ["Mcp-Session-Id"] = "s1" })
            assert.equals(0, #buffered())
        end)

        it("sends an MCP tool call as MCP_SERVER only when agentId is known", function()
            log(conf("API"), "POST", TOOL_CALL, { ["x-agent-id"] = "agent_1" })
            log(conf("API"), "POST", TOOL_CALL, {})
            local events = buffered()
            assert.equals(2, #events)
            assert.equals("MCP_SERVER", events[1].productType)
            assert.equals("search", events[1].toolName)
            assert.equals("API", events[2].productType)
        end)
    end)
    -- ── Pre-flight quota check ──────────────────────────────────
    describe("preflight quota", function()
        local dict
        local function conf(overrides)
            local c = {
                aforo_endpoint = "https://usage-ingestor.test/v1/ingest/batch",
                api_key = "sk_ingest",
                tenant_id = "tenant_1",
                default_metric = "api_calls",
                preflight_quota_enabled = true,
                preflight_quota_timeout_ms = 100,
                preflight_quota_cache_ttl_ms = 1000,
                preflight_quota_fail_open = true,
            }
            for k, v in pairs(overrides or {}) do c[k] = v end
            return c
        end

        local function with_customer(id)
            mock_kong.ctx.shared = { aforo_jwt_claims = { customer_id = id } }
        end

        before_each(function()
            dict = new_shared_dict()
            ngx.shared.aforo_buffer = dict
            http_mock.requests = {}
            http_mock.responses = {}
            http_mock.on_request = nil
            mock_kong.response._exit = nil
            mock_kong.response._set_headers = {}
        end)

        -- The access phase resets ctx.shared.aforo_trace but keeps the JWT
        -- claims we stash, as Kong would after validation.
        local function access(c)
            handler:access(c)
        end

        it("makes no call and never blocks when disabled", function()
            with_customer("cust_a")
            http_mock.responses = { { status = 200, body = '{"decision":"DENY"}' } }
            access(conf({ preflight_quota_enabled = false }))
            assert.equals(0, #http_mock.requests)
            assert.is_nil(mock_kong.response._exit)
        end)

        it("posts to /api/v1/quota/check with X-API-Key and the verified customer", function()
            with_customer("cust_jwt")
            mock_kong.request._headers = { ["x-customer-id"] = "cust_forged" }
            http_mock.responses = { { status = 200, body = '{"decision":"ALLOW"}' } }
            access(conf())

            assert.equals(1, #http_mock.requests)
            local req = http_mock.requests[1]
            assert.equals("https://usage-ingestor.test/api/v1/quota/check", req.url)
            assert.equals("POST", req.params.method)
            assert.equals("sk_ingest", req.params.headers["X-API-Key"])
            assert.is_nil(req.params.headers["Authorization"])
            local body = cjson.decode(req.params.body)
            assert.equals("cust_jwt", body.customerId)
            assert.equals("api_calls", body.metricName)
            assert.is_nil(mock_kong.response._exit)
        end)

        it("answers 429 on DENY with Retry-After", function()
            with_customer("cust_a")
            http_mock.responses = { { status = 200,
                body = '{"decision":"DENY","reason":"Wallet empty","retryAfterMs":30000}' } }
            access(conf())
            assert.is_not_nil(mock_kong.response._exit)
            assert.equals(429, mock_kong.response._exit.status)
            assert.equals("30", mock_kong.response._exit.headers["Retry-After"])
        end)

        it("fails open on timeout and on non-200", function()
            with_customer("cust_a")
            http_mock.responses = { { err = "timeout" } }
            access(conf())
            assert.is_nil(mock_kong.response._exit)

            http_mock.responses = { { status = 500 } }
            access(conf())
            assert.is_nil(mock_kong.response._exit)
            assert.equals(2, #http_mock.requests)
        end)

        it("refuses with 503 on error only when fail-open is turned off", function()
            with_customer("cust_a")
            http_mock.responses = { { err = "timeout" } }
            access(conf({ preflight_quota_fail_open = false }))
            assert.equals(503, mock_kong.response._exit.status)
        end)

        it("caches ALLOW per tenant/customer/metric but never DENY", function()
            with_customer("cust_a")
            http_mock.responses = { { status = 200, body = '{"decision":"ALLOW"}' } }
            access(conf())
            access(conf())
            assert.equals(1, #http_mock.requests)

            with_customer("cust_b")
            http_mock.responses = {
                { status = 200, body = '{"decision":"DENY"}' },
                { status = 200, body = '{"decision":"DENY"}' },
            }
            access(conf())
            access(conf())
            assert.equals(3, #http_mock.requests)
        end)

        it("skips the check when no verified customer is known", function()
            mock_kong.ctx.shared = {}
            mock_kong.request._headers = { ["x-customer-id"] = "cust_forged" }
            access(conf())
            assert.equals(0, #http_mock.requests)
        end)
    end)
end)
