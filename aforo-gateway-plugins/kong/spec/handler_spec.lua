-- Unit tests for aforo-metering Kong plugin
-- Run with: busted spec/

-- ── ngx / resty.http mocks ─────────────────────────────────────
-- Installed BEFORE requiring the handler so it binds to them. The shared dict
-- implements the list operations the event buffer relies on with OpenResty's
-- semantics (atomic per call; list ops on a non-list key fail).
local function new_shared_dict()
    -- Memory is modelled for lists, as the real dict behaves: each element
    -- takes a slab slot, pushes fail with "no memory" when the dict is full
    -- (they evict nothing), and free_space() reports what is left.
    local d = { store = {}, fail_push = false, cap = 10485760, used = 0 }
    local function slot(v)
        local n = #v + 48
        if n > 2048 then return math.ceil(n / 4096) * 4096 end
        local p = 16
        while p < n do p = p * 2 end
        return p
    end
    function d:get(k) return self.store[k] end
    function d:set(k, v) self.store[k] = v; return true end
    function d:add(k, v)
        if self.store[k] ~= nil then return false, "exists" end
        self.store[k] = v; return true
    end
    d.safe_set = d.set
    d.safe_add = d.add
    function d:delete(k)
        local v = self.store[k]
        if type(v) == "table" and v.__list then
            for _, e in ipairs(v) do self.used = self.used - slot(e) end
        end
        self.store[k] = nil
    end
    local function list(self, k, create)
        local v = self.store[k]
        if v == nil then
            if not create then return nil end
            v = { __list = true }; self.store[k] = v
        end
        if type(v) ~= "table" or not v.__list then return nil, "value not a list" end
        return v
    end
    local function room(self, v)
        if self.fail_push or self.used + slot(v) > self.cap then return false end
        return true
    end
    function d:rpush(k, v)
        if not room(self, v) then return nil, "no memory" end
        local l, err = list(self, k, true); if not l then return nil, err end
        l[#l + 1] = v; self.used = self.used + slot(v); return #l
    end
    function d:lpush(k, v)
        if not room(self, v) then return nil, "no memory" end
        local l, err = list(self, k, true); if not l then return nil, err end
        table.insert(l, 1, v); self.used = self.used + slot(v); return #l
    end
    function d:lpop(k)
        local l, err = list(self, k, false); if not l then return nil, err end
        local v = table.remove(l, 1)
        if v then self.used = self.used - slot(v) end
        if #l == 0 then self.store[k] = nil end
        return v
    end
    function d:rpop(k)
        local l, err = list(self, k, false); if not l then return nil, err end
        local v = table.remove(l)
        if v then self.used = self.used - slot(v) end
        if #l == 0 then self.store[k] = nil end
        return v
    end
    function d:llen(k)
        local l, err = list(self, k, false)
        if err then return nil, err end
        return l and #l or 0
    end
    function d:incr(k, v, init)
        local cur = self.store[k]
        if cur == nil then
            if init == nil then return nil, "not found" end
            cur = init
        end
        self.store[k] = cur + v
        return self.store[k]
    end
    function d:capacity() return self.cap end
    function d:free_space() return math.max(0, self.cap - self.used) end
    return d
end

_G.ngx = _G.ngx or {}
ngx.shared = { aforo_buffer = new_shared_dict() }
ngx.timers = {}
ngx.timer = {
    at = function(delay, fn, ...) table.insert(ngx.timers, { delay = delay, fn = fn, args = { ... } }); return true end,
    every = function(delay, fn, ...) table.insert(ngx.timers, { every = true, delay = delay, fn = fn, args = { ... } }); return true end,
}
ngx.now = function() return 1788268682.221 end
ngx.sleeps = {}
ngx.sleep = function(s) table.insert(ngx.sleeps, s) end
ngx.worker = ngx.worker or { pid = function() return 1 end }
ngx.worker.id = ngx.worker.id or function() return 0 end
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
            })
            mock_kong.request.get_path = orig
            local encoded = raw(c)[1]
            assert.is_nil(encoded:find("[\128-\255]"), "malformed bytes reached the batch body")
            local e = cjson.decode(encoded)
            assert.is_nil(e.trace.traceparent)
            assert.equals("first", e.trace.xTraceId)
            assert.is_nil(e.trace.xRequestId)
            assert.equals("vendor=1", e.trace.tracestate)
            -- Only the malformed byte and the control character are escaped.
            assert.equals(512, #e.endpointPath)
            assert.equals("/caf%E9/%00x ppp", e.endpointPath:sub(1, 16))
        end)

        it("keeps valid Unicode unchanged: paths, tool names, metric names, customer ids", function()
            local c = conf({ mcp_enabled = true })
            local orig_path, orig_method = mock_kong.request.get_path, mock_kong.request.get_method
            mock_kong.request.get_path = function() return "/café/ü" end
            log(c, "kündin", nil, { ["X-Aforo-Metric"] = "nachrichten_gesendet_ü" })
            mock_kong.request.get_method = function() return "POST" end
            mock_kong.ctx.shared = { aforo_jwt_claims = { customer_id = "cust_a" },
                aforo_raw_body = '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"t b é","_meta":{"agent_id":"a1"}}}' }
            mock_kong.request._headers, mock_kong.response._headers = {}, {}
            handler:log(c)
            mock_kong.request.get_path, mock_kong.request.get_method = orig_path, orig_method
            local evs = buffered(c)
            assert.equals("/café/ü", evs[1].endpointPath)
            assert.equals("nachrichten_gesendet_ü", evs[1].metricName)
            assert.equals("kündin", evs[1].customerId)
            assert.equals("t b é", evs[2].toolName)
        end)

        it("counts identity limits in characters as the ingestor does, not bytes", function()
            local c = conf()
            log(c, string.rep("\195\169", 40))            -- 'é' x 40: 40 characters, 80 bytes
            log(c, string.rep("\240\159\152\128", 32))    -- 32 emoji: 64 UTF-16 units -- at the limit
            log(c, string.rep("\240\159\152\128", 33))    -- 66 units: over customerId's 64
            log(c, "bad\255id")                           -- not text: would poison the batch
            local ids = {}
            for i, e in ipairs(buffered(c)) do ids[i] = #e.customerId end
            assert.same({ 80, 128 }, ids)
        end)

        it("skips the event when an upstream identity header is present but unusable", function()
            local c = conf({ product_type = "AI_AGENT", agent_id = "default-agent",
                             agent_id_header = "X-Aforo-Agent-Id", session_id_header = "X-Aforo-Session-Id" })
            local long_agent = "support-agent-production-eu-west-1-v2"   -- 37 characters
            log(c, "c1", nil, { ["X-Aforo-Agent-Id"] = long_agent })
            log(c, "c2", nil, { ["X-Aforo-Session-Id"] = "sess\1ion" })
            log(conf(), "c3", nil, { ["X-Aforo-Metric"] = "sms\255sent" })
            assert.equals(0, #buffered(c))
            assert.equals(0, #buffered(conf()))
            -- Absent headers still fall back as designed.
            log(c, "c4")
            assert.equals("default-agent", buffered(c)[1].agentId)
        end)

        it("with mcp_meter_non_tool_calls, also meters the other messages of a mixed batch", function()
            local c = conf({ mcp_enabled = true, mcp_meter_non_tool_calls = true })
            local orig_method = mock_kong.request.get_method
            mock_kong.request.get_method = function() return "POST" end
            mock_kong.request._headers, mock_kong.response._headers = {}, {}
            mock_kong.ctx.shared = { aforo_jwt_claims = { customer_id = "cust_a" }, aforo_raw_body = cjson.encode({
                { jsonrpc = "2.0", id = 1, method = "tools/list" },
                { jsonrpc = "2.0", id = 2, method = "tools/call", params = { name = "search" } },
            }) }
            handler:log(c)
            mock_kong.request.get_method = orig_method
            local evs = buffered(c)
            assert.equals(2, #evs)
            assert.equals("search", evs[1].toolName)
            assert.equals("api_calls", evs[2].metricName)
            assert.is_nil(evs[2].toolName)
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

        -- ── review 2: delivery ──────────────────────────────────
        it("moves an instance's events kept on 401 to its rotated api_key, and stops using the old one", function()
            local old = conf({ api_key = "sk_revoked", __plugin_id = "plugin-1" })
            log(old, "c1"); log(old, "c2")
            http_mock.responses = { { status = 401 } }
            handler._flush_buffer(false, old)        -- 401: kept
            -- The operator rotates the key of the same plugin instance.
            local new = conf({ api_key = "sk_rotated", __plugin_id = "plugin-1" })
            log(new, "c3")
            for _, t in ipairs(ngx.timers) do run(t) end   -- every pending timer, stale ones included
            local keys = {}
            for _, r in ipairs(http_mock.requests) do keys[#keys + 1] = r.params.headers["X-API-Key"] end
            assert.same({ "sk_revoked", "sk_rotated" }, keys)
            local ids = {}
            for _, e in ipairs(sent(2)) do ids[#ids + 1] = e.customerId end
            assert.same({ "c1", "c2", "c3" }, ids)   -- the old events first, in order
            assert.equals(0, #buffered(old))
            assert.equals(0, #buffered(new))
            assert.is_nil(dict:get(handler._buffer_key(old) .. ":conf"))  -- the old buffer is retired
        end)

        it("never moves another instance's events on a rotation", function()
            local A = conf({ api_key = "sk_shared", __plugin_id = "plugin-A" })
            local B = conf({ api_key = "sk_shared", __plugin_id = "plugin-B" })
            log(A, "a1"); log(B, "b1")
            log(conf({ api_key = "sk_new", __plugin_id = "plugin-A" }), "a2")   -- A rotates
            assert.equals(1, #buffered(B))
            assert.equals("b1", buffered(B)[1].customerId)
            local moved = buffered(conf({ api_key = "sk_new", __plugin_id = "plugin-A" }))
            assert.equals(2, #moved)
        end)

        it("sends a push from a worker still on the old settings to the new buffer", function()
            local old = conf({ api_key = "sk_old", __plugin_id = "plugin-1" })
            local new = conf({ api_key = "sk_new", __plugin_id = "plugin-1" })
            log(old, "c1"); log(new, "c2")
            log(old, "c3")                           -- a worker that has not reloaded yet
            assert.equals(0, #buffered(old))
            assert.equals(3, #buffered(new))
        end)

        it("re-arms a timed flush after a worker exit (reload)", function()
            local c = conf()
            log(c, "c1")
            local t = table.remove(ngx.timers, 1)
            http_mock.responses = { { status = 503 } }
            t.fn(true, unpack(t.args))               -- premature: worker exiting; send fails, kept
            assert.equals(1, #buffered(c))
            ngx.timers = {}                          -- new worker: no timers survive
            log(c, "c2")
            assert.equals(1, #ngx.timers, "no timed flush armed")
        end)

        it("re-arms flushes on worker 0 with no traffic at all", function()
            local c = conf()
            log(c, "c1")
            local k = handler._buffer_key(c)
            ngx.timers = {}
            dict:delete(k .. ":pending")             -- the timer died with its worker
            handler:init_worker()
            assert.equals(1, #ngx.timers)
            assert.is_true(ngx.timers[1].every)
            local every = table.remove(ngx.timers, 1)
            every.fn(false)
            assert.equals(1, #ngx.timers)            -- a timed flush for the stranded buffer
            run(table.remove(ngx.timers, 1))
            assert.equals(0, #buffered(c))
        end)

        it("keeps at most the newest 500 events for a destination the ingestor refuses", function()
            local c = conf({ flush_count = 100000 })
            for i = 1, 1200 do log(c, "c" .. i) end
            http_mock.responses = { { status = 401 } }
            handler._flush_buffer(false, c)
            local left = buffered(c)
            assert.equals(500, #left)
            assert.equals("c701", left[1].customerId)
            assert.equals("c1200", left[500].customerId)
            log(c, "c1201")                           -- full: the oldest makes room
            left = buffered(c)
            assert.equals(500, #left)
            assert.equals("c702", left[1].customerId)
            assert.equals("c1201", left[500].customerId)
        end)

        it("drops events older than 72 hours when the ingestor refuses the destination", function()
            local c = conf()
            local k = handler._buffer_key(c)
            dict:rpush(k, cjson.encode({ customerId = "old", occurredAt = "2026-08-01T00:00:00.000Z" }))
            log(c, "fresh")
            http_mock.responses = { { status = 403 } }
            handler._flush_buffer(false, c)
            local left = buffered(c)
            assert.equals(1, #left)
            assert.equals("fresh", left[1].customerId)
        end)

        it("never lets a refused destination stop a healthy one from buffering", function()
            dict.cap = 256 * 1024                     -- a small dict
            local A = conf({ flush_count = 100000 })
            local B = conf({ tenant_id = "tenantB", api_key = "sk_B", flush_count = 100000,
                             aforo_endpoint = "http://ingestor-b.test/v1/ingest/batch" })
            for i = 1, 600 do log(A, "a" .. i) end    -- A fills the dict to the brim
            local a_before = #buffered(A)
            assert.is_true(a_before < 600)
            dict:set(handler._buffer_key(A) .. ":held", true)   -- A's key is refused (401)
            for i = 1, 100 do log(B, "b" .. i) end
            assert.equals(100, #buffered(B))          -- B lost nothing
            assert.is_true(#buffered(A) < a_before)   -- A made the room
            -- A refused destination gets no room at others' expense: with the
            -- dict full of B's events, A's push evicts none of them.
            while dict:free_space() > 1024 do log(B, "b_fill") end
            local b_now = #buffered(B)
            log(A, "a_new")
            assert.equals(b_now, #buffered(B))
        end)

        it("never refuses events while the dict has room, whatever happened before", function()
            dict.cap = 64 * 1024
            local A = conf({ flush_count = 100000 })
            while dict:free_space() > 4096 do log(A, "a") end   -- full
            dict:delete(handler._buffer_key(A))               -- drained (or evicted) by anyone
            log(A, "after")
            assert.equals(1, #buffered(A))
        end)

        it("treats a 400 for every part of the batch as a refused request, not 2n-1 POSTs", function()
            local c = conf({ flush_count = 100000 })
            for i = 1, 1000 do log(c, "c" .. i) end
            respond_by_body(function() return 400 end)
            handler._flush_buffer(false, c)
            assert.equals(3, #http_mock.requests)     -- the batch and its two halves
            assert.equals(500, #buffered(c))          -- kept, as for a 404 (the newest 500)
            assert.is_true(dict:get(handler._buffer_key(c) .. ":held"))
        end)

        it("checks the flush time budget before every POST", function()
            local c = conf({ flush_count = 100000 })
            for i = 1, 16 do log(c, "c" .. i) end
            local clock = ngx.now()
            local orig_now = ngx.now
            ngx.now = function() return clock end
            respond_by_body(function(body)
                clock = clock + 61                      -- every POST takes "a minute"
                return body:find('"c3"', 1, true) and 400 or 202
            end)
            handler._flush_buffer(false, c)
            ngx.now = orig_now
            assert.equals(1, #http_mock.requests)     -- no bisection past the budget
            assert.equals(16, #buffered(c))
        end)

        it("only ever releases its own flush lock", function()
            local c = conf()
            log(c, "c1")
            local k = handler._buffer_key(c)
            http_mock.on_request = function()
                dict:set(k .. ":lock", "another-flush")   -- the lock expired and was taken over
            end
            handler._flush_buffer(false, c)
            assert.equals("another-flush", dict:get(k .. ":lock"))
        end)

        it("does not bisect on the way out", function()
            local c = conf()
            for i = 1, 8 do log(c, "c" .. i) end
            http_mock.responses = { { status = 400 } }
            handler._flush_buffer(true, c)
            assert.equals(1, #http_mock.requests)
            assert.equals(8, #buffered(c))
        end)

        it("skips an event whose identity is over the ingestor's limit, with the reason", function()
            local c = conf({ product_type = "AI_AGENT", agent_id = string.rep("a", 37) })
            log(c, "c1")
            assert.equals(0, #buffered(c))
        end)
        -- ── review 3 ────────────────────────────────────────────
        it("R1: a 413 batch whose halves are still too big is split further, not held", function()
            -- A proxy in front of the ingestor takes at most ~250 events per body.
            local c = conf({ flush_count = 100000 })
            for i = 1, 1000 do log(c, "c" .. i) end
            respond_by_body(function(body)
                local _, n = body:gsub('"customerId"', "")
                return n > 250 and 413 or 202
            end)
            handler._flush_buffer(false, c)
            handler._flush_buffer(false, c)          -- and a second flush, for good measure
            assert.is_nil(dict:get(handler._buffer_key(c) .. ":held"), "destination marked refused")
            assert.equals(1000, #customers_delivered())
        end)

        it("R2: one instance's stale key does not hold another instance's events", function()
            -- Two services of one tenant, same endpoint. Service A still has a
            -- revoked key; service B was rotated to a good one.
            local A = conf({ api_key = "sk_revoked", flush_count = 100000 })
            local B = conf({ api_key = "sk_good", flush_count = 100000 })
            http_mock.on_request = function(n)
                local key = http_mock.requests[n].params.headers["X-API-Key"]
                http_mock.requests[n].status = key == "sk_good" and 202 or 401
                table.insert(http_mock.responses, 1, { status = http_mock.requests[n].status })
            end
            for i = 1, 5 do log(B, "b" .. i) end
            log(A, "a1")                             -- A's request happens to be the last one
            handler._flush_buffer(false, B)          -- B's own timer / flush
            local b_sent = 0
            for i, r in ipairs(http_mock.requests) do
                if r.status == 202 then
                    for _, e in ipairs(sent(i)) do if e.customerId:sub(1, 1) == "b" then b_sent = b_sent + 1 end end
                end
            end
            assert.equals(5, b_sent)
        end)

        it("R3: UTF-8 validity matrix (customerId)", function()
            local c = conf()
            local cases = {
                { "\224\160\128", true },  { "\224\159\191", false }, -- E0 A0 80 ok, E0 9F BF overlong
                { "\237\159\191", true },  { "\237\160\128", false }, -- ED 9F BF ok, ED A0 80 surrogate
                { "\238\128\128", true },  { "\239\191\191", true },  -- EE 80 80, EF BF BF
                { "\240\144\128\128", true }, { "\240\143\191\191", false }, -- U+10000, overlong
                { "\244\143\191\191", true }, { "\244\144\128\128", false }, -- U+10FFFF, > U+10FFFF
                { "\245\128\128\128", false }, { "\192\128", false }, { "\193\191", false },
                { "\194\128", true }, { "x\226\130", false }, { "x\240\159\152", false }, { "x\195", false },
                { "\128", false }, { "a\237\190\128b", false },
            }
            local want = {}
            for i, case in ipairs(cases) do
                log(c, "id" .. i .. "-" .. case[1])
                if case[2] then want[#want + 1] = "id" .. i .. "-" .. case[1] end
            end
            local got = {}
            for i, e in ipairs(buffered(c)) do got[i] = e.customerId end
            assert.same(want, got)
        end)

        it("R4: a refused destination keeps its NEWEST events, as the docs and the log say", function()
            local c = conf({ flush_count = 100000 })
            for i = 1, 1000 do log(c, "old" .. i) end
            http_mock.responses = { { status = 401 } }
            handler._flush_buffer(false, c)          -- refused: held, 1000 kept
            for i = 1, 300 do log(c, "new" .. i) end -- the next flush interval's traffic
            http_mock.responses = { { status = 401 } }
            handler._flush_buffer(false, c)
            local left = buffered(c)
            assert.equals("new300", left[#left].customerId)
        end)

        it("R6: held is cleared once the key works, even if the 202 reports a transient per-event error", function()
            local c = conf({ flush_count = 100000 })
            log(c, "c1"); log(c, "c2")
            http_mock.responses = { { status = 401 } }
            handler._flush_buffer(false, c)
            http_mock.responses = { { status = 202, body = '{"accepted":1,"failed":1,"errors":['
                .. '{"index":0,"message":"The event could not be stored: deadlock"}]}' } }
            handler._flush_buffer(false, c)
            assert.is_nil(dict:get(handler._buffer_key(c) .. ":held"))
        end)

        it("R7: events a re-buffer drops are reported even inside the 60 s log throttle", function()
            local c = conf({ flush_count = 100000 })
            local errs = {}
            local orig = mock_kong.log.err
            mock_kong.log.err = function(...) errs[#errs + 1] = table.concat({ ... }) end
            for i = 1, 10 do log(c, "c" .. i) end
            http_mock.responses = { { status = 503 }, { status = 503 }, { status = 503 } }
            handler._flush_buffer(false, c)          -- first failure: logged, nothing dropped
            -- Second failure 5 s later: the buffer filled up meanwhile, so the re-buffer drops.
            http_mock.responses = { { status = 503 }, { status = 503 }, { status = 503 } }
            local k = handler._buffer_key(c)
            http_mock.on_request = function(n)
                if n == 4 then for i = 1, 10000 do dict:rpush(k, cjson.encode({ customerId = "n" .. i })) end end
            end
            handler._flush_buffer(false, c)
            mock_kong.log.err = orig
            local reported = false
            for _, l in ipairs(errs) do if l:find("dropped", 1, true) then reported = true end end
            assert.equals(10000, #buffered(c))       -- 10 events were dropped by the second flush...
            assert.is_true(reported, "...and no log line says so")
        end)

        it("R2b: a timer flush (as in production) sends B's events with whichever key was pushed last", function()
            local A = conf({ api_key = "sk_revoked", flush_count = 100000 })
            local B = conf({ api_key = "sk_good", flush_count = 100000 })
            for i = 1, 5 do log(B, "b" .. i) end
            log(A, "a1")
            http_mock.responses = { { status = 401 } }
            run(table.remove(ngx.timers, 1))         -- the pending timed flush
            assert.equals("sk_good", http_mock.requests[1].params.headers["X-API-Key"])
        end)
    end)
    -- ── Billing correctness (2026-10-12) ────────────────────────
    describe("billing correctness", function()
        local dict
        local function conf(o)
            local c = {
                aforo_endpoint = "http://ingestor.test/v1/ingest/batch",
                api_key = "sk_A", tenant_id = "tenantA", default_metric = "api_calls",
                metric_header = "X-Aforo-Metric", quantity_header = "X-Aforo-Quantity",
                agent_id_header = "X-Aforo-Agent-Id", session_id_header = "X-Aforo-Session-Id",
                exclude_paths = { "/health", "/ready", "/metrics" }, exclude_status_codes = {},
            }
            for k, v in pairs(o or {}) do c[k] = v end
            return c
        end
        local MCP = { mcp_enabled = true }
        -- One request. opts: method, path, body (the access-phase stash),
        -- headers (request), response (headers), var (ngx.var).
        local function log(c, opts)
            opts = opts or {}
            mock_kong.request._headers = opts.headers or {}
            mock_kong.response._headers = opts.response or {}
            mock_kong.ctx.shared = { aforo_jwt_claims = { customer_id = "cust_a" }, aforo_raw_body = opts.body }
            ngx.var = opts.var or { request_id = "kongreq" }
            local m, p = mock_kong.request.get_method, mock_kong.request.get_path
            mock_kong.request.get_method = function() return opts.method or "GET" end
            mock_kong.request.get_path = function() return opts.path or "/v1/accounts/123" end
            handler:log(c)
            mock_kong.request.get_method, mock_kong.request.get_path = m, p
            ngx.var = nil
        end
        local function buffered(c)
            local l = dict.store[handler._buffer_key(c)] or {}
            local out = {}
            for i, e in ipairs(l) do out[i] = cjson.decode(e) end
            return out
        end
        local function tool_call(name, meta)
            return cjson.encode({ jsonrpc = "2.0", id = 1, method = "tools/call",
                                  params = { name = name, _meta = meta } })
        end

        before_each(function()
            dict = new_shared_dict()
            ngx.shared.aforo_buffer = dict
            ngx.timers = {}
        end)

        it("excludes a path and what is below it, not every path sharing its prefix", function()
            local c = conf()
            for _, p in ipairs({ "/healthcare/patients/42", "/metrics-api/v1/series", "/ready-meals/orders",
                                 "/health", "/health/live", "/metrics" }) do
                log(c, { path = p })
            end
            local paths = {}
            for i, e in ipairs(buffered(c)) do paths[i] = e.endpointPath end
            assert.same({ "/healthcare/patients/42", "/metrics-api/v1/series", "/ready-meals/orders" }, paths)
        end)

        it("bills response_size from the bytes actually sent, also without Content-Length", function()
            local c = conf({ quantity_source = "response_size" })
            log(c, { var = { request_id = "r1", body_bytes_sent = "5000" } })  -- chunked: no Content-Length
            assert.equals(5000, buffered(c)[1].quantity)
        end)

        it("reports the whole request time, not Kong's own latency", function()
            local c = conf(MCP)
            log(c, { response = { ["X-Kong-Proxy-Latency"] = "2" }, var = { request_id = "r1", request_time = "0.504" } })
            log(c, { method = "POST", body = tool_call("search", { agent_id = "a1" }),
                     response = { ["X-Kong-Proxy-Latency"] = "2" }, var = { request_id = "r2", request_time = "0.504" } })
            local evs = buffered(c)
            assert.equals(504, evs[1].responseTimeMs)
            assert.equals(504, evs[2].responseTimeMs)
            assert.equals(504, evs[2].executionDurationMs)
        end)

        it("keeps metadata.endpoint_path with include_metadata=false", function()
            local c = conf({ include_metadata = false })
            log(c, { path = "/v1/sms" })
            local e = buffered(c)[1]
            assert.same({ endpoint_path = "/v1/sms" }, e.metadata)
        end)

        it("survives any MCP body, and still bills a tools/call without a usable name", function()
            local c = conf(MCP)
            local bodies = { "1", '"text"', "null", "[]", "[1,2]", "{}",
                '{"jsonrpc":"2.0","method":"tools/call","params":null}',
                '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search","_meta":null}}',
                '{"jsonrpc":"2.0","method":"tools/call","params":{"name":42}}' }
            for i, body in ipairs(bodies) do
                assert.has_no.errors(function()
                    log(c, { method = "POST", body = body, var = { request_id = "r" .. i } })
                end, body)
            end
            local tools = {}
            for _, e in ipairs(buffered(c)) do
                if e.toolName then tools[#tools + 1] = e.toolName end
            end
            assert.same({ "unknown", "search", "unknown" }, tools)
        end)

        it("bills each tools/call in a JSON-RPC batch, and none of the protocol messages", function()
            local c = conf(MCP)
            local batch = '[' .. tool_call("search", { agent_id = "a1" }) .. ','
                .. '{"jsonrpc":"2.0","id":2,"method":"ping"},'
                .. tool_call("fetch", { agent_id = "a1" }) .. ']'
            log(c, { method = "POST", body = batch })
            local evs = buffered(c)
            assert.equals(2, #evs)
            assert.equals("search", evs[1].toolName)
            assert.equals("fetch", evs[2].toolName)
            assert.not_equals(evs[1].idempotencyKey, evs[2].idempotencyKey)
        end)

        it("does not bill MCP protocol messages unless mcp_meter_non_tool_calls is set", function()
            local msgs = {
                '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
                '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
                '{"jsonrpc":"2.0","id":3,"method":"ping"}',
                '{"jsonrpc":"2.0","method":"notifications/initialized"}',
            }
            local c = conf(MCP)
            for _, m in ipairs(msgs) do log(c, { method = "POST", body = m }) end
            assert.equals(0, #buffered(c))
            -- Not JSON-RPC at all: unaffected.
            log(c, { method = "POST", body = '{"hello":"world"}' })
            log(c, { method = "GET" })
            assert.equals(2, #buffered(c))

            dict = new_shared_dict(); ngx.shared.aforo_buffer = dict
            local on = conf({ mcp_enabled = true, mcp_meter_non_tool_calls = true })
            for _, m in ipairs(msgs) do log(on, { method = "POST", body = m }) end
            local evs = buffered(on)
            assert.equals(4, #evs)
            assert.equals("api_calls", evs[1].metricName)
        end)

        it("takes the MCP agent from _meta, then the agent response header, then config -- never X-Agent-Id", function()
            local c = conf({ mcp_enabled = true, agent_id = "agent_cfg" })
            local forged = { ["x-agent-id"] = "forged", ["X-Agent-Id"] = "forged" }
            log(c, { method = "POST", body = tool_call("t", { agent_id = "agent_meta" }), headers = forged,
                     response = { ["X-Aforo-Agent-Id"] = "agent_hdr" } })
            log(c, { method = "POST", body = tool_call("t"), headers = forged,
                     response = { ["X-Aforo-Agent-Id"] = "agent_hdr" } })
            log(c, { method = "POST", body = tool_call("t"), headers = forged })
            local ids = {}
            for i, e in ipairs(buffered(c)) do ids[i] = e.agentId end
            assert.same({ "agent_meta", "agent_hdr", "agent_cfg" }, ids)
        end)

        it("on an AI_AGENT route, takes MCP agent and session from config and the upstream only", function()
            local c = conf({ mcp_enabled = true, product_type = "AI_AGENT", agent_id = "agent_cfg" })
            log(c, { method = "POST", body = tool_call("t", { agent_id = "agent_meta" }),
                     headers = { ["Mcp-Session-Id"] = "client-session" }, var = { request_id = "kongreq1" } })
            log(c, { method = "POST", body = tool_call("t", { agent_id = "agent_meta" }),
                     response = { ["X-Aforo-Session-Id"] = "sess-42" }, var = { request_id = "kongreq2" } })
            local evs = buffered(c)
            assert.equals("agent_cfg", evs[1].agentId)
            assert.equals("kongreq1", evs[1].sessionId)
            assert.equals("sess-42", evs[2].sessionId)
        end)

        it("names an MCP tool call by the metric header, then the mappings, then mcp_server.tool_invocations", function()
            local c = conf({ mcp_enabled = true, default_metric = "api_calls",
                             metric_mappings = { { path_pattern = "^/mcp/premium", metric_name = "premium_tools" } } })
            local body = tool_call("t", { agent_id = "a1" })
            log(c, { method = "POST", path = "/mcp", body = body, response = { ["X-Aforo-Metric"] = "tool_x" } })
            log(c, { method = "POST", path = "/mcp/premium", body = body })
            log(c, { method = "POST", path = "/mcp", body = body })
            local names = {}
            for i, e in ipairs(buffered(c)) do names[i] = e.metricName end
            assert.same({ "tool_x", "premium_tools", "mcp_server.tool_invocations" }, names)
        end)

        it("reads a tools/call body that Kong spooled to a file", function()
            local path = os.tmpname()
            local f = io.open(path, "wb"); f:write(tool_call("big_tool", { agent_id = "a1" })); f:close()
            local orig_raw = mock_kong.request.get_raw_body
            mock_kong.request.get_raw_body = function() return nil, "request body did not fit into client body buffer" end
            ngx.req = { get_body_file = function() return path end }
            local c = conf(MCP)
            mock_kong.ctx.shared = {}
            handler:access(c)
            local stash = mock_kong.ctx.shared.aforo_raw_body
            mock_kong.request.get_raw_body = orig_raw
            ngx.req = nil
            os.remove(path)
            log(c, { method = "POST", body = stash })
            assert.equals("big_tool", buffered(c)[1].toolName)
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
            local with_meta = '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search",'
                .. '"_meta":{"agent_id":"agent_1"}}}'
            log(conf("API"), "POST", with_meta, {})
            local configured = conf("API"); configured.agent_id = "agent_cfg"
            log(configured, "POST", TOOL_CALL, {})
            log(conf("API"), "POST", TOOL_CALL, {})
            -- X-Agent-Id is the client's to set: never a source for agentId.
            log(conf("API"), "POST", TOOL_CALL, { ["x-agent-id"] = "agent_forged", ["X-Agent-Id"] = "agent_forged" })
            local events = buffered()
            assert.equals(4, #events)
            assert.equals("MCP_SERVER", events[1].productType)
            assert.equals("search", events[1].toolName)
            assert.equals("agent_1", events[1].agentId)
            assert.equals("MCP_SERVER", events[2].productType)
            assert.equals("agent_cfg", events[2].agentId)
            assert.equals("API", events[3].productType)
            assert.equals("API", events[4].productType)
            assert.is_nil(events[4].agentId)
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
