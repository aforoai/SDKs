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
-- Stand-in for ngx.md5: distinct inputs give distinct keys, which is all the
-- buffer and mappings keys need here.
ngx.md5 = ngx.md5 or function(s) return (s:gsub("[^%w]", "_")) end

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
        -- Upstream response headers (X-Aforo-*), set per test.
        _headers = {},
        get_header = function(name)
            return mock_kong.response._headers[name]
        end,
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
        debug = function(...) end,
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
        mock_kong.response._headers = {}
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
        local BUFFER_KEY = handler._buffer_key(conf)

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
            -- The timed flush every non-empty buffer keeps pending, plus one immediate.
            assert.equals(2, #ngx.timers)
            assert.equals(5, ngx.timers[1].delay)
            assert.equals(0, ngx.timers[2].delay)
        end)

        it("caps the buffer at MAX_BUFFER_SIZE, dropping the newest, and still schedules a flush", function()
            fill(10000)
            log_request("cust_overflow")
            local events = buffered()
            assert.equals(10000, #events)
            assert.equals("c10000", events[10000].customerId)
            -- A full buffer must not stop flushing forever.
            assert.equals(2, #ngx.timers)
            assert.equals(0, ngx.timers[2].delay)
            -- ...but not one flush per dropped request.
            log_request("cust_overflow_2")
            assert.equals(2, #ngx.timers)
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

        it("drops a batch rejected with a permanent 4xx and keeps draining the rest", function()
            fill(1500)
            http_mock.responses = { { status = 422, body = "unprocessable" } }
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
    -- ── Delivery (2026-10-12) ───────────────────────────────────
    -- The metering-path review's findings, as tests of the fixed behaviour.
    describe("delivery", function()
        local dict
        local function conf(o)
            local c = {
                aforo_endpoint = "http://ingestor.test/v1/ingest/batch",
                api_key = "sk_A", tenant_id = "tenantA",
                default_metric = "api_calls", flush_count = 50, flush_interval_ms = 5000,
                quantity_header = "X-Aforo-Quantity", metric_header = "X-Aforo-Metric",
                exclude_paths = {}, exclude_status_codes = { 401, 403, 429 },
            }
            for k, v in pairs(o or {}) do c[k] = v end
            return c
        end
        local function log(c, cust, headers, response_headers)
            mock_kong.request._headers = headers or {}
            mock_kong.response._headers = response_headers or {}
            mock_kong.ctx.shared = { aforo_jwt_claims = { customer_id = cust or "cust_a" } }
            handler:log(c)
        end
        local function raw(c)
            return dict.store[handler._buffer_key(c)] or {}
        end
        local function buffered(c)
            local out = {}
            for i, e in ipairs(raw(c)) do out[i] = cjson.decode(e) end
            return out
        end
        local function sent(i) return cjson.decode(http_mock.requests[i].params.body).events end
        local function run(t) t.fn(false, unpack(t.args)) end
        local function timers_at(delay)
            local n = 0
            for _, t in ipairs(ngx.timers) do if t.delay == delay then n = n + 1 end end
            return n
        end
        local function customers_delivered()
            local out = {}
            for i, r in ipairs(http_mock.requests) do
                if r.status == 202 then
                    for _, e in ipairs(sent(i)) do out[#out + 1] = e.customerId end
                end
            end
            table.sort(out)
            return out
        end
        -- Answer each POST by looking at what it carries.
        local function respond_by_body(fn)
            http_mock.on_request = function(n)
                local status = fn(http_mock.requests[n].params.body)
                http_mock.requests[n].status = status
                table.insert(http_mock.responses, 1, { status = status })
            end
        end

        before_each(function()
            dict = new_shared_dict()
            ngx.shared.aforo_buffer = dict
            ngx.timers, ngx.sleeps = {}, {}
            http_mock.requests, http_mock.responses, http_mock.on_request = {}, {}, nil
        end)

        it("keeps a timed flush pending after a failed flush, so low traffic still drains", function()
            local c = conf()
            log(c, "c1"); log(c, "c2"); log(c, "c3")
            assert.equals(1, #ngx.timers)
            http_mock.responses = { { status = 503 }, { status = 503 }, { status = 503 } }
            run(table.remove(ngx.timers, 1))
            assert.equals(3, #buffered(c))
            -- Already rescheduled: no need to wait for flush_count more requests.
            assert.equals(1, #ngx.timers)
            assert.equals(5, ngx.timers[1].delay)
            run(table.remove(ngx.timers, 1))      -- ingestor healthy again
            assert.equals(0, #buffered(c))
            assert.equals(3, #sent(4))
        end)

        it("runs at most one immediate flush per buffer, and none during backoff", function()
            local c = conf({ flush_count = 5 })
            local k = handler._buffer_key(c)
            dict:set(k .. ":lock", true)          -- a flush is running in another worker
            for i = 1, 200 do log(c, "c" .. i) end
            assert.equals(1, #ngx.timers)         -- just the pending timed flush
            assert.equals(0, timers_at(0))
            dict:delete(k .. ":lock")
            for i = 201, 400 do log(c, "c" .. i) end
            assert.equals(1, timers_at(0))        -- one immediate flush, not one per request

            ngx.timers = {}
            dict:delete(k .. ":kick")
            dict:set(k .. ":backoff", true)       -- the last flush failed
            for i = 401, 450 do log(c, "c" .. i) end
            assert.equals(0, timers_at(0))
        end)

        it("an immediate flush that finds a flush running leaves it alone", function()
            local c = conf({ flush_count = 1 })
            log(c, "c1")
            local kick
            for _, t in ipairs(ngx.timers) do if t.delay == 0 then kick = t end end
            dict:set(handler._buffer_key(c) .. ":lock", true)
            run(kick)
            assert.equals(0, #http_mock.requests)
            assert.equals(1, #buffered(c))
        end)

        it("makes one quick send when the worker is exiting, and keeps what fails", function()
            local c = conf()
            log(c, "c1"); log(c, "c2")
            local t = table.remove(ngx.timers, 1)
            t.fn(true, unpack(t.args))            -- premature: reload / shutdown
            assert.equals(1, #http_mock.requests)
            assert.equals(2, #sent(1))
            assert.equals(0, #buffered(c))

            log(c, "c3")
            http_mock.responses = { { status = 503 } }
            handler._flush_buffer(true, c)
            assert.equals(2, #http_mock.requests) -- one attempt, no retries
            assert.same({}, ngx.sleeps)
            assert.equals(1, #buffered(c))
        end)

        it("flushes each plugin instance's events with its own key and endpoint", function()
            local A = conf()
            local B = conf({ api_key = "sk_B", tenant_id = "tenantB",
                             aforo_endpoint = "http://ingestor-b.test/v1/ingest/batch" })
            log(A, "cust_of_A"); log(B, "cust_of_B")
            assert.equals(2, #ngx.timers)
            run(table.remove(ngx.timers, 1)); run(table.remove(ngx.timers, 1))
            assert.equals(2, #http_mock.requests)
            local by_url = {}
            for i, r in ipairs(http_mock.requests) do by_url[r.url] = { r = r, events = sent(i) } end
            local a, b = by_url["http://ingestor.test/v1/ingest/batch"], by_url["http://ingestor-b.test/v1/ingest/batch"]
            assert.equals("sk_A", a.r.params.headers["X-API-Key"])
            assert.equals("tenantA", a.r.params.headers["X-Tenant-Id"])
            assert.equals(1, #a.events)
            assert.equals("cust_of_A", a.events[1].customerId)
            assert.equals("sk_B", b.r.params.headers["X-API-Key"])
            assert.equals("tenantB", b.r.params.headers["X-Tenant-Id"])
            assert.equals(1, #b.events)
            assert.equals("cust_of_B", b.events[1].customerId)
        end)

        it("keeps the batch on 401, 403 and 404, without a retry storm", function()
            for _, status in ipairs({ 401, 403, 404 }) do
                dict = new_shared_dict(); ngx.shared.aforo_buffer = dict
                http_mock.requests = {}
                local c = conf()
                log(c, "c1"); log(c, "c2")
                http_mock.responses = { { status = status, body = '{"title":"Unauthorized"}' } }
                handler._flush_buffer(false, c)
                assert.equals(1, #http_mock.requests)
                assert.equals(2, #buffered(c))
            end
        end)

        it("re-sends only the events a 202 says could not be stored", function()
            local c = conf()
            log(c, "c1"); log(c, "c2"); log(c, "c3")
            http_mock.responses = { { status = 202, body = '{"accepted":1,"duplicates":0,"failed":2,"errors":['
                .. '{"index":0,"message":"The event could not be stored: connection refused"},'
                .. '{"index":2,"message":"metricName Metric name is required"}]}' } }
            handler._flush_buffer(false, c)
            local left = buffered(c)
            assert.equals(1, #left)
            assert.equals("c1", left[1].customerId)
        end)

        it("bisects a batch the ingestor answers 400, so one bad event costs only itself", function()
            local c = conf()
            for i = 1, 8 do log(c, "c" .. i) end
            respond_by_body(function(body) return body:find('"c5"', 1, true) and 400 or 202 end)
            handler._flush_buffer(false, c)
            assert.same({ "c1", "c2", "c3", "c4", "c6", "c7", "c8" }, customers_delivered())
            assert.equals(0, #buffered(c))
            assert.is_true(#http_mock.requests <= 7)  -- log2(8) levels, not one POST per event
        end)

        it("splits a batch the ingestor answers 413", function()
            local c = conf()
            for i = 1, 4 do log(c, "c" .. i) end
            respond_by_body(function(body)
                local _, n = body:gsub('"customerId"', "")
                return n > 2 and 413 or 202
            end)
            handler._flush_buffer(false, c)
            assert.same({ "c1", "c2", "c3", "c4" }, customers_delivered())
        end)

        it("drops a single event the ingestor answers 400, with the reason", function()
            local c = conf()
            log(c, "c1")
            http_mock.responses = { { status = 400, body = "Invalid UTF-8" } }
            handler._flush_buffer(false, c)
            assert.equals(1, #http_mock.requests)
            assert.equals(0, #buffered(c))
        end)

        it("gives every AGENTIC_API event a traceId the client cannot withhold", function()
            local c = conf({ product_type = "AGENTIC_API" })
            ngx.var = { request_id = "kongreq1" }
            log(c, "c1")
            log(c, "c2", { traceparent = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01" })
            log(c, "c3", { ["x-trace-id"] = "legacy-1" })
            log(c, "c4", { traceparent = "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
                           ["x-trace-id"] = "legacy-2" })
            ngx.var = nil
            local ids = {}
            for i, e in ipairs(buffered(c)) do ids[i] = e.traceId end
            assert.same({ "kongreq1", "4bf92f3577b34da6a3ce929d0e0e4736", "legacy-1", "legacy-2" }, ids)
        end)

        it("caches central mappings per tenant", function()
            local url = "http://catalog/internal/v1/metrics/gateway-mappings"
            local A = conf({ mappings_url = url })
            local B = conf({ tenant_id = "tenantB", api_key = "sk_B", mappings_url = url })
            dict:set(handler._mappings_key(A), cjson.encode({ { matchType = "PREFIX", value = "/v1/accounts",
                                                                 metricName = "tenantA_metric" } }))
            dict:set(handler._mappings_key(A) .. ":at", ngx.now())
            log(A, "a"); log(B, "b")
            assert.equals("tenantA_metric", buffered(A)[1].metricName)
            assert.equals("api_calls", buffered(B)[1].metricName)
        end)

        it("drops unusable client values instead of poisoning the batch", function()
            local c = conf()
            local orig = mock_kong.request.get_path
            mock_kong.request.get_path = function() return "/caf\233/\0x " .. string.rep("p", 600) end
            log(c, "c1", {
                traceparent = "00-\255\254-bad",
                ["x-trace-id"] = { "first", "second" },     -- a repeated header
                ["x-request-id"] = string.rep("x", 500),
                tracestate = "vendor=1",
            }, { ["X-Aforo-Metric"] = "sms\255sent" })
            mock_kong.request.get_path = orig
            local encoded = raw(c)[1]
            assert.is_nil(encoded:find("[\128-\255]"), "non-ASCII bytes reached the batch body")
            local e = cjson.decode(encoded)
            assert.is_nil(e.trace.traceparent)
            assert.equals("first", e.trace.xTraceId)
            assert.is_nil(e.trace.xRequestId)
            assert.equals("vendor=1", e.trace.tracestate)
            assert.equals("api_calls", e.metricName)    -- the unusable header metric is ignored
            assert.equals(512, #e.endpointPath)
            assert.equals("/caf%E9/%00x%20ppp", e.endpointPath:sub(1, 18))
        end)

        it("rounds quantity to the ingestor's 6 decimals and skips what rounds to 0", function()
            local c = conf()
            log(c, "c1", nil, { ["X-Aforo-Quantity"] = "0.3333333" })
            log(c, "c2", nil, { ["X-Aforo-Quantity"] = "0.0000001" })
            log(c, "c3", nil, { ["X-Aforo-Quantity"] = "1e15" })
            local evs = buffered(c)
            assert.equals(1, #evs)
            assert.equals(0.333333, evs[1].quantity)
        end)

        it("skips an event whose identity is over the ingestor's limit, with the reason", function()
            local c = conf({ product_type = "AI_AGENT", agent_id = string.rep("a", 37) })
            log(c, "c1")
            assert.equals(0, #buffered(c))
        end)
    end)
    -- ── productType ─────────────────────────────────────────────
    describe("product_type", function()
        local BUFFER_KEY = handler._buffer_key({ aforo_endpoint = "http://ingestor.test/v1/ingest/batch",
                                                 api_key = "sk_test_key" })
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
    -- ── AI_AGENT identity ───────────────────────────────────────
    -- agentId / sessionId come from operator config or the upstream RESPONSE
    -- only. Request headers are client-settable and must never be a source.
    describe("AI_AGENT identity", function()
        local BUFFER_KEY = handler._buffer_key({ aforo_endpoint = "http://ingestor.test/v1/ingest/batch",
                                                 api_key = "sk_test_key", tenant_id = "tenant_1" })
        local dict, warnings, orig_get_consumer, orig_warn

        -- Schema defaults spelled out: busted hands conf to the handler as-is,
        -- without the defaults Kong would fill in.
        local function conf(overrides)
            local c = {
                aforo_endpoint = "http://ingestor.test/v1/ingest/batch",
                api_key = "sk_test_key",
                tenant_id = "tenant_1",
                default_metric = "api_calls",
                product_type = "AI_AGENT",
                quantity_header = "X-Aforo-Quantity",
                agent_id_header = "X-Aforo-Agent-Id",
                session_id_header = "X-Aforo-Session-Id",
                exclude_paths = {},
                exclude_status_codes = {},
            }
            for k, v in pairs(overrides or {}) do c[k] = v end
            return c
        end
        local function buffered()
            local l = dict.store[BUFFER_KEY]
            local out = {}
            for i = 1, (l and #l or 0) do out[i] = cjson.decode(l[i]) end
            return out
        end
        -- One proxied request: request headers from the client, response
        -- headers from the upstream, request ID from Kong (nginx $request_id).
        -- The customer is the Kong consumer. The client's X-Request-Id is
        -- there to prove it is ignored.
        local function log(c, request_headers, response_headers)
            mock_kong.request._headers = request_headers or { ["X-Request-Id"] = "client-req-1" }
            mock_kong.response._headers = response_headers or {}
            ngx.var = { request_id = "kong-req-1" }
            handler:log(c)
        end

        before_each(function()
            dict = new_shared_dict()
            ngx.shared.aforo_buffer = dict
            ngx.timers = {}
            warnings = {}
            orig_get_consumer = mock_kong.client.get_consumer
            orig_warn = mock_kong.log.warn
            mock_kong.client.get_consumer = function()
                return { custom_id = "cust_acme", username = "acme-corp" }
            end
            mock_kong.log.warn = function(...)
                local parts = {}
                for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
                table.insert(warnings, table.concat(parts))
            end
        end)

        after_each(function()
            mock_kong.client.get_consumer = orig_get_consumer
            mock_kong.log.warn = orig_warn
            ngx.var = nil
        end)

        it("meters with config agent_id, one session per request", function()
            log(conf({ agent_id = "fraud-shield-agent" }))
            local events = buffered()
            assert.equals(1, #events)
            local e = events[1]
            assert.equals("AI_AGENT", e.productType)
            assert.equals("cust_acme", e.customerId)
            assert.equals("fraud-shield-agent", e.agentId)
            -- The session fallback is Kong's request ID, never the client's.
            assert.equals("kong-req-1", e.sessionId)
            assert.equals("kong-req-1", e.idempotencyKey)
            assert.equals(1, e.quantity)
        end)

        it("lets upstream response headers override config and report tokens", function()
            log(conf({ agent_id = "fraud-shield-agent" }), nil, {
                ["X-Aforo-Agent-Id"]   = "fraud-shield-v2",
                ["X-Aforo-Session-Id"] = "sess-42",
                ["X-Aforo-Quantity"]   = "2100",
            })
            local e = buffered()[1]
            assert.equals("AI_AGENT", e.productType)
            assert.equals("fraud-shield-v2", e.agentId)
            assert.equals("sess-42", e.sessionId)
            assert.equals(2100, e.quantity)
            assert.equals("kong-req-1", e.idempotencyKey)
        end)

        it("ignores a response header that is turned off (null)", function()
            -- Kong hands the handler nil for a setting configured as null.
            local c = conf({ agent_id = "fraud-shield-agent" })
            c.agent_id_header, c.session_id_header = nil, nil
            log(c, nil, {
                ["X-Aforo-Agent-Id"]   = "fraud-shield-v2",
                ["X-Aforo-Session-Id"] = "sess-42",
            })
            local e = buffered()[1]
            assert.equals("fraud-shield-agent", e.agentId)
            assert.equals("kong-req-1", e.sessionId)
        end)

        it("never reads agent or session IDs from client request headers", function()
            local forged = {
                ["X-Request-Id"]       = "client-req-1",
                ["X-Aforo-Agent-Id"]   = "agent_forged",
                ["x-aforo-agent-id"]   = "agent_forged",
                ["X-Agent-Id"]         = "agent_forged",
                ["x-agent-id"]         = "agent_forged",
                ["X-Aforo-Session-Id"] = "sess_forged",
                ["x-aforo-session-id"] = "sess_forged",
            }
            -- Configured: config wins over every forged header.
            log(conf({ agent_id = "fraud-shield-agent" }), forged)
            -- Not configured: the forged headers do not fill the gap.
            log(conf(), forged)
            local events = buffered()
            assert.equals(1, #events)
            assert.equals("fraud-shield-agent", events[1].agentId)
            assert.equals("kong-req-1", events[1].sessionId)
        end)

        it("skips an event with no agent ID anywhere and names the fix", function()
            log(conf())
            log(conf({ agent_id = "" }), nil, { ["X-Aforo-Agent-Id"] = "" })
            assert.equals(0, #buffered())
            -- Throttled: one warning per window, not one per request.
            assert.equals(1, #warnings)
            assert.truthy(warnings[1]:find("requires agentId", 1, true))
            assert.truthy(warnings[1]:find("config.agent_id", 1, true))
            assert.truthy(warnings[1]:find("X-Aforo-Agent-Id response header", 1, true))
        end)

        it("adds nothing to API events", function()
            -- As configured before these settings existed.
            local plain = conf({ product_type = "API" })
            plain.agent_id_header, plain.session_id_header = nil, nil
            log(plain)
            log(conf({ product_type = "API", agent_id = "fraud-shield-agent" }), nil, {
                ["X-Aforo-Agent-Id"]   = "fraud-shield-v2",
                ["X-Aforo-Session-Id"] = "sess-42",
            })
            local events = buffered()
            assert.equals(2, #events)
            assert.equals("API", events[2].productType)
            assert.is_nil(events[2].agentId)
            assert.is_nil(events[2].sessionId)
            assert.equals(1, events[2].quantity)
            -- Field for field the event an API service sent before these settings.
            assert.same(events[1], events[2])
        end)
    end)
    -- ── Idempotency key ─────────────────────────────────────────
    -- Locks in the 2026-10-12 fix. The key was the client's X-Request-Id and
    -- the ingestor silently drops a repeated (tenant, key), so a client that
    -- repeated one ID on every call was billed once. Only Kong may mint it.
    describe("idempotency key", function()
        local BUFFER_KEY = handler._buffer_key({ aforo_endpoint = "http://ingestor.test/v1/ingest/batch",
                                                 api_key = "sk_test_key", tenant_id = "tenant_1" })
        local CLIENT_ID = "client-chosen-id"
        local TOOL_CALL = '{"jsonrpc":"2.0","method":"tools/call",'
            .. '"params":{"name":"search","_meta":{"agent_id":"agent_1"}}}'
        local dict
        local conf = {
            aforo_endpoint = "http://ingestor.test/v1/ingest/batch",
            api_key = "sk_test_key",
            tenant_id = "tenant_1",
            default_metric = "api_calls",
            mcp_enabled = true,
            flush_count = 50,
            exclude_paths = {},
            exclude_status_codes = {},
        }
        local function buffered()
            local l = dict.store[BUFFER_KEY]
            local out = {}
            for i = 1, (l and #l or 0) do out[i] = cjson.decode(l[i]) end
            return out
        end
        local function keys()
            local out = {}
            for i, e in ipairs(buffered()) do out[i] = e.idempotencyKey end
            return out
        end
        -- One request with the client's chosen ID in every header the plugin
        -- used to read, and kong_id as nginx's $request_id (nil: none).
        local function log(kong_id, method, raw_body)
            mock_kong.request._headers = {
                ["X-Request-Id"]      = CLIENT_ID,
                ["X-Kong-Request-Id"] = CLIENT_ID,
            }
            mock_kong.ctx.shared = {
                aforo_jwt_claims = { customer_id = "cust_a" },
                aforo_raw_body = raw_body,
            }
            ngx.var = kong_id and { request_id = kong_id } or nil
            local orig = mock_kong.request.get_method
            mock_kong.request.get_method = function() return method or "GET" end
            handler:log(conf)
            mock_kong.request.get_method = orig
        end

        before_each(function()
            dict = new_shared_dict()
            ngx.shared.aforo_buffer = dict
            ngx.timers = {}
            http_mock.requests = {}
            http_mock.responses = {}
            http_mock.on_request = nil
        end)

        after_each(function()
            ngx.var = nil
            mock_kong.request.get_id = nil
        end)

        it("uses Kong's request ID, never the client's X-Request-Id", function()
            log("kong-id-1")
            log("kong-id-2")
            local k = keys()
            assert.same({ "kong-id-1", "kong-id-2" }, k)
            assert.not_equals(CLIENT_ID, k[1])
            assert.not_equals(CLIENT_ID, k[2])
        end)

        it("does the same for MCP tool calls", function()
            log("kong-id-1", "POST", TOOL_CALL)
            log("kong-id-2", "POST", TOOL_CALL)
            local events = buffered()
            assert.equals(2, #events)
            assert.equals("MCP_SERVER", events[1].productType)
            assert.not_equals(events[1].idempotencyKey, events[2].idempotencyKey)
            for i, e in ipairs(events) do
                assert.is_nil(e.idempotencyKey:find(CLIENT_ID, 1, true))
                assert.truthy(e.idempotencyKey:find(":kong-id-" .. i .. ":", 1, true))
            end
        end)

        it("prefers kong.request.get_id where the PDK has it", function()
            mock_kong.request.get_id = function() return "pdk-id-1" end
            log("nginx-id-1")
            assert.same({ "pdk-id-1" }, keys())
        end)

        it("falls back to a fresh UUID when Kong exposes no request ID", function()
            log(nil)
            log(nil)
            local k = keys()
            assert.equals(2, #k)
            assert.not_equals(k[1], k[2])
            assert.not_equals(CLIENT_ID, k[1])
            assert.not_equals(CLIENT_ID, k[2])
        end)

        it("keeps the same key through a re-buffer and a later retry", function()
            log("kong-id-1")
            http_mock.responses = { { status = 503 }, { status = 503 }, { status = 503 } }
            handler._flush_buffer(false, conf)
            assert.equals(1, #buffered())
            http_mock.responses = { { status = 202 } }
            handler._flush_buffer(false, conf)
            assert.equals(0, #buffered())
            -- Three failed attempts, then the re-buffered event sent: every one
            -- carried the key minted at log time, so the ingestor can still
            -- collapse a retry whose earlier attempt did land.
            assert.equals(4, #http_mock.requests)
            for i = 1, 4 do
                local sent = cjson.decode(http_mock.requests[i].params.body).events
                assert.equals(1, #sent)
                assert.equals("kong-id-1", sent[1].idempotencyKey)
            end
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
    -- ── Schema ──────────────────────────────────────────────────
    -- Kong validates the schema itself at startup and refuses to load the
    -- plugin on any violation, so these are checked without a running Kong.
    describe("schema", function()
        local config_fields, saved_typedefs

        lazy_setup(function()
            saved_typedefs = package.loaded["kong.db.schema.typedefs"]
            package.loaded["kong.db.schema.typedefs"] = { no_consumer = {}, protocols_http = {} }
            package.loaded["schema"] = nil
            local schema = require("schema")
            for _, f in ipairs(schema.fields) do
                if f.config then config_fields = f.config.fields end
            end
        end)

        lazy_teardown(function()
            package.loaded["kong.db.schema.typedefs"] = saved_typedefs
        end)

        local function field(name)
            for _, f in ipairs(config_fields) do
                if f[name] then return f[name] end
            end
        end

        it("keeps every description within Kong's 500-character limit", function()
            local too_long = {}
            local function walk(fields, prefix)
                for _, f in ipairs(fields) do
                    local name, def = next(f)
                    if def.description and #def.description > 500 then
                        too_long[#too_long + 1] = prefix .. name .. " (" .. #def.description .. ")"
                    end
                    if def.fields then walk(def.fields, prefix .. name .. ".") end
                    if def.elements and def.elements.fields then
                        walk(def.elements.fields, prefix .. name .. "[].")
                    end
                end
            end
            walk(config_fields, "config.")
            -- Longer and Kong fails at boot: "length must be at most 500".
            assert.same({}, too_long)
        end)

        it("declares the AI_AGENT identity settings", function()
            assert.equals("string", field("agent_id").type)
            assert.is_nil(field("agent_id").default)
            assert.equals("X-Aforo-Agent-Id", field("agent_id_header").default)
            assert.equals("X-Aforo-Session-Id", field("session_id_header").default)
        end)
    end)
end)
