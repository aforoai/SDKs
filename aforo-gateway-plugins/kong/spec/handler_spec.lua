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
    function d:incr(k, n, init)
        local v = self.store[k]
        if v == nil then
            if init == nil then return nil, "not found" end
            v = init
        end
        self.store[k] = v + n
        return self.store[k]
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
ngx.time = function() return 1788268682 end
ngx.var = ngx.var or {}
ngx.ctx = ngx.ctx or {}
ngx.null = ngx.null or {}
-- base64 (standard alphabet, padded), as ngx.decode_base64 / ngx.encode_base64.
do
    local B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    ngx.encode_base64 = function(data)
        local out = {}
        for i = 1, #data, 3 do
            local a, b, c = data:byte(i, i + 2)
            local n = a * 65536 + (b or 0) * 256 + (c or 0)
            local c1 = math.floor(n / 262144) % 64
            local c2 = math.floor(n / 4096) % 64
            local c3 = math.floor(n / 64) % 64
            local c4 = n % 64
            out[#out + 1] = B:sub(c1 + 1, c1 + 1) .. B:sub(c2 + 1, c2 + 1)
                .. (b and B:sub(c3 + 1, c3 + 1) or "=") .. (c and B:sub(c4 + 1, c4 + 1) or "=")
        end
        return table.concat(out)
    end
    ngx.decode_base64 = function(str)
        if type(str) ~= "string" or #str % 4 ~= 0 or str:find("[^%w%+/=]") then return nil end
        local out = {}
        for i = 1, #str, 4 do
            local n, pad = 0, 0
            for j = 0, 3 do
                local ch = str:sub(i + j, i + j)
                local v
                if ch == "=" then v = 0; pad = pad + 1 else v = B:find(ch, 1, true) - 1 end
                n = n * 64 + v
            end
            local bytes = string.char(math.floor(n / 65536) % 256, math.floor(n / 256) % 256, n % 256)
            out[#out + 1] = bytes:sub(1, 3 - pad)
        end
        return table.concat(out)
    end
end

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
        debug = function(...) end,
        info = function(...) end,
        warn = function(...) end,
        err = function(...) end,
    },
}

-- Replace global kong
_G.kong = mock_kong

-- The handler's idempotency-key fallback now uses resty.jit-uuid (real Kong bundles it);
-- kong.tools.uuid() was nil on the Kong 3.x PDK global and crashed the log phase. The old
-- mock provided a fake kong.tools.uuid, which is exactly what hid this bug — real Kong has
-- no kong.tools, so we don't mock one.
package.loaded["resty.jit-uuid"] = { generate_v4 = function() return "test-uuid" end }

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

        -- ── Body-buffering regression (log-phase get_raw_body fix) ──
        -- kong.request.get_raw_body() may only be called in access/rewrite.
        -- The log phase must read the body from kong.ctx.shared, never call
        -- get_raw_body() itself. These lock the access→log handoff so the
        -- phase error can't regress.
        it("buffers the raw request body during access when mcp_enabled", function()
            local body = '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search"}}'
            mock_kong.request.get_raw_body = function() return body end

            handler:access({ mcp_enabled = true })

            assert.equals(body, mock_kong.ctx.shared.aforo_raw_body)

            mock_kong.request.get_raw_body = function() return nil end  -- reset
        end)

        it("does NOT read the request body during access when mcp is disabled", function()
            local read = false
            mock_kong.request.get_raw_body = function() read = true; return "payload" end

            handler:access({})  -- mcp_enabled absent

            -- No body-inspecting detector is on, so we must not force nginx
            -- to buffer (or temp-file) the body just to size it.
            assert.is_false(read)
            assert.is_nil(mock_kong.ctx.shared.aforo_raw_body)

            mock_kong.request.get_raw_body = function() return nil end  -- reset
        end)
    end)

    -- ── Security regression tests ───────────────────────────────
    -- Lock in the 2026-04-23 IDOR fix (advisory findings #7-#10).
    -- These assertions must hold on every v2.x+ release.
    -- ════════════════════════════════════════════════════════════
    -- 2.2.0 merge: identity precedence, in-plugin RS256 verification,
    -- metric mappings, Retry-After, drop accounting
    -- ════════════════════════════════════════════════════════════

    -- Real RSA keys and signatures from the openssl CLI; resty.openssl.pkey is
    -- replaced by a shim that verifies with `openssl dgst -verify`, so a bad
    -- signature fails for the real reason and not because a mock said so.
    describe("in-plugin RS256 JWT verification", function()
        local tmp = os.tmpname() .. "_aforo_jwt"
        local pub_pem, other_pub_pem, priv_pem
        local NOW = 1788268682

        local function sh(cmd) return os.execute(cmd .. " >/dev/null 2>&1") end
        local function slurp(path)
            local f = assert(io.open(path, "rb")); local d = f:read("*all"); f:close(); return d
        end
        local function spit(path, data)
            local f = assert(io.open(path, "wb")); f:write(data); f:close()
        end
        local function b64url(data)
            return (ngx.encode_base64(data):gsub("+", "-"):gsub("/", "_"):gsub("=", ""))
        end
        local function sign(header, claims, key)
            local input = b64url(cjson.encode(header)) .. "." .. b64url(cjson.encode(claims))
            spit(tmp .. "/in", input)
            assert(sh("openssl dgst -sha256 -sign " .. tmp .. "/" .. (key or "k1") .. ".pem -out "
                .. tmp .. "/sig " .. tmp .. "/in"))
            return input .. "." .. b64url(slurp(tmp .. "/sig"))
        end
        local function claims(extra)
            local c = { customer_id = "cust_1", tenant_id = "t1", key_id = "key_1",
                        iss = "https://auth.aforo.ai", exp = NOW + 600 }
            for k, v in pairs(extra or {}) do c[k] = v end
            return c
        end
        local RS = { alg = "RS256", typ = "JWT" }

        setup(function()
            assert(sh("mkdir -p " .. tmp))
            assert(sh("openssl genrsa -out " .. tmp .. "/k1.pem 2048"))
            assert(sh("openssl rsa -in " .. tmp .. "/k1.pem -pubout -out " .. tmp .. "/k1.pub"))
            assert(sh("openssl genrsa -out " .. tmp .. "/k2.pem 2048"))
            assert(sh("openssl rsa -in " .. tmp .. "/k2.pem -pubout -out " .. tmp .. "/k2.pub"))
            pub_pem = slurp(tmp .. "/k1.pub")
            other_pub_pem = slurp(tmp .. "/k2.pub")
            priv_pem = slurp(tmp .. "/k1.pem")

            package.loaded["resty.openssl.pkey"] = {
                new = function(pem)
                    if type(pem) ~= "string" or not pem:find("-----BEGIN", 1, true) then
                        return nil, "not a PEM"
                    end
                    local private = pem:find("PRIVATE KEY", 1, true) ~= nil
                    return {
                        is_private = function() return private end,
                        verify = function(_, signature, input, digest)
                            assert(digest == "sha256")
                            spit(tmp .. "/v.pem", pem); spit(tmp .. "/v.sig", signature)
                            spit(tmp .. "/v.in", input)
                            local ok = sh("openssl dgst -sha256 -verify " .. tmp .. "/v.pem -signature "
                                .. tmp .. "/v.sig " .. tmp .. "/v.in")
                            return ok == true or ok == 0
                        end,
                    }
                end,
            }
            -- Redis is unreachable in unit tests: revocation checks fail open.
            package.loaded["resty.redis"] = {
                new = function()
                    return { set_timeout = function() end,
                             connect = function() return nil, "refused" end }
                end,
            }
        end)

        teardown(function()
            sh("rm -rf " .. tmp)
            package.loaded["resty.openssl.pkey"] = nil
            package.loaded["resty.redis"] = nil
        end)

        before_each(function()
            ngx.shared.aforo_buffer = new_shared_dict()
            mock_kong.ctx.shared = {}
        end)

        local function conf(extra)
            local c = { jwt_validation_enabled = true, jwt_issuer = "https://auth.aforo.ai",
                        jwt_public_key = pub_pem }
            for k, v in pairs(extra or {}) do c[k] = v end
            return c
        end

        it("accepts a correctly signed, unexpired RS256 token and marks it verified", function()
            local r = handler._validate_jwt(sign(RS, claims()), conf())
            assert.is_true(r.valid)
            assert.is_true(r.signature_verified)
            assert.equals("cust_1", r.customer_id)
            assert.equals("key_1", r.key_id)
        end)

        it("rejects a token signed by another key", function()
            local r = handler._validate_jwt(sign(RS, claims(), "k2"), conf())
            assert.is_false(r.valid)
            assert.equals("INVALID_SIGNATURE", r.reason)
        end)

        it("rejects a token whose payload was changed after signing", function()
            local t = sign(RS, claims())
            local h, _, sgn = t:match("^([^.]+)%.([^.]+)%.([^.]+)$")
            local forged = h .. "." .. b64url(cjson.encode(claims({ customer_id = "victim" }))) .. "." .. sgn
            local r = handler._validate_jwt(forged, conf())
            assert.is_false(r.valid)
            assert.equals("INVALID_SIGNATURE", r.reason)
        end)

        it("rejects alg=none, with or without a signature part", function()
            local unsigned = b64url(cjson.encode({ alg = "none" })) .. "." .. b64url(cjson.encode(claims()))
            for _, t in ipairs({ unsigned .. ".", unsigned .. ".AAAA" }) do
                local r = handler._validate_jwt(t, conf())
                assert.is_false(r.valid)
                assert.is_true(r.reason == "UNSUPPORTED_ALGORITHM" or r.reason == "MALFORMED_TOKEN")
            end
        end)

        it("rejects HS256 (the public key must never be usable as an HMAC secret)", function()
            local r = handler._validate_jwt(sign({ alg = "HS256", typ = "JWT" }, claims()), conf())
            assert.is_false(r.valid)
            assert.equals("UNSUPPORTED_ALGORITHM", r.reason)
        end)

        it("rejects an expired token and one with no exp, even when correctly signed", function()
            local r = handler._validate_jwt(sign(RS, claims({ exp = NOW - 1 })), conf())
            assert.is_false(r.valid)
            assert.equals("TOKEN_EXPIRED", r.reason)

            local c = claims(); c.exp = nil
            r = handler._validate_jwt(sign(RS, c), conf())
            assert.equals("TOKEN_EXPIRED", r.reason)

            r = handler._validate_jwt(sign(RS, claims({ exp = "tomorrow" })), conf())
            assert.equals("TOKEN_EXPIRED", r.reason)
        end)

        it("rejects a token that is not valid yet (nbf), allowing a minute of skew", function()
            local r = handler._validate_jwt(sign(RS, claims({ nbf = NOW + 3600 })), conf())
            assert.equals("TOKEN_NOT_YET_VALID", r.reason)
            r = handler._validate_jwt(sign(RS, claims({ nbf = NOW + 30 })), conf())
            assert.is_true(r.valid)
        end)

        it("checks the signature before the issuer: a forged token never reaches claim checks", function()
            local r = handler._validate_jwt(sign(RS, claims({ iss = "https://evil" }), "k2"), conf())
            assert.equals("INVALID_SIGNATURE", r.reason)
            r = handler._validate_jwt(sign(RS, claims({ iss = "https://evil" })), conf())
            assert.equals("INVALID_ISSUER", r.reason)
        end)

        it("fails closed with no jwt_public_key (jwt_jwks_uri alone verifies nothing)", function()
            local r = handler._validate_jwt(sign(RS, claims()),
                conf({ jwt_public_key = "", jwt_jwks_uri = "https://auth.aforo.ai/.well-known/jwks.json" }))
            assert.is_false(r.valid)
            assert.equals("INVALID_SIGNATURE", r.reason)
        end)

        it("refuses a private key in jwt_public_key and an unparseable one, even with the opt-out", function()
            for _, pem in ipairs({ priv_pem, "not a key" }) do
                local r = handler._validate_jwt(sign(RS, claims()),
                    conf({ jwt_public_key = pem, jwt_allow_unverified_signature = true }))
                assert.is_false(r.valid)
                assert.equals("INVALID_SIGNATURE", r.reason)
            end
        end)

        it("rejects an oversized token before doing any work", function()
            local r = handler._validate_jwt(string.rep("a", 9000), conf())
            assert.equals("MALFORMED_TOKEN", r.reason)
        end)

        it("jwt_allow_unverified_signature lets the token through but gives it no identity", function()
            local c = conf({ jwt_public_key = "", jwt_allow_unverified_signature = true })
            local forged = sign(RS, claims({ customer_id = "victim" }), "k2")
            local r = handler._validate_jwt(forged, c)
            assert.is_true(r.valid)
            assert.is_false(r.signature_verified)

            mock_kong.ctx.shared = { aforo_jwt_claims = r }
            assert.is_nil(handler._resolve_customer_id(c, nil, {}))
            -- A Kong consumer, when there is one, still identifies the caller.
            assert.equals("acme", handler._resolve_customer_id(c, { custom_id = "acme" }, {}))
        end)

        it("an unverifiable token counts as verified when Kong's jwt plugin verified the same token", function()
            local c = conf({ jwt_public_key = "", jwt_allow_unverified_signature = true })
            local t = sign(RS, claims())
            mock_kong.ctx.shared = { authenticated_jwt_token = t }
            assert.is_true(handler._validate_jwt(t, c).signature_verified)
            -- ...but not when Kong verified a different token.
            mock_kong.ctx.shared = { authenticated_jwt_token = sign(RS, claims({ customer_id = "x" })) }
            assert.is_false(handler._validate_jwt(t, c).signature_verified)
        end)

        it("access phase answers 401 for a bad signature and stashes nothing", function()
            mock_kong.request._headers = { ["Authorization"] = "Bearer " .. sign(RS, claims(), "k2") }
            mock_kong.response._exit = nil
            handler:access(conf({ jwt_public_key = pub_pem }))
            assert.equals(401, mock_kong.response._exit.status)
            assert.is_nil(mock_kong.ctx.shared.aforo_jwt_claims)
            mock_kong.response._exit = nil
        end)

        it("a different configured key is a different verifier (no stale key cache hit)", function()
            local t = sign(RS, claims())
            assert.is_true(handler._validate_jwt(t, conf()).valid)
            assert.is_false(handler._validate_jwt(t, conf({ jwt_public_key = other_pub_pem })).valid)
        end)
    end)

    describe("identity precedence", function()
        local function kong_token(payload)
            return "e30." .. (ngx.encode_base64(cjson.encode(payload)):gsub("+", "-"):gsub("/", "_"):gsub("=", "")) .. ".sig"
        end

        before_each(function() mock_kong.ctx.shared = {} end)

        it("consumer alone: custom_id, then username, then id", function()
            assert.equals("c1", handler._resolve_customer_id({}, { custom_id = "c1", username = "u", id = "i" }, {}))
            assert.equals("u", handler._resolve_customer_id({}, { username = "u", id = "i" }, {}))
            assert.equals("i", handler._resolve_customer_id({}, { id = "i" }, {}))
        end)

        it("customer_id_jwt_claim decides alone: over the consumer and over the in-plugin token", function()
            local conf = { customer_id_jwt_claim = "tenant_id", jwt_validation_enabled = true }
            mock_kong.ctx.shared = {
                authenticated_jwt_token = kong_token({ tenant_id = "from_kong_jwt" }),
                aforo_jwt_claims = { signature_verified = true, customer_id = "from_in_plugin" },
            }
            assert.equals("from_kong_jwt", handler._resolve_customer_id(conf, { custom_id = "issuer" }, {}))
            -- No Kong-verified token: nothing, not the consumer and not the in-plugin claim.
            mock_kong.ctx.shared = { aforo_jwt_claims = { signature_verified = true, customer_id = "from_in_plugin" } }
            assert.is_nil(handler._resolve_customer_id(conf, { custom_id = "issuer" }, {}))
        end)

        it("in-plugin verified claim beats the consumer; the consumer is the fallback when the token names no customer", function()
            mock_kong.ctx.shared = { aforo_jwt_claims = { signature_verified = true, customer_id = "from_in_plugin" } }
            assert.equals("from_in_plugin", handler._resolve_customer_id({}, { custom_id = "consumer" }, {}))
            mock_kong.ctx.shared = { aforo_jwt_claims = { signature_verified = true, customer_id = "" } }
            assert.equals("consumer", handler._resolve_customer_id({}, { custom_id = "consumer" }, {}))
        end)

        it("claims without signature_verified are never an identity", function()
            mock_kong.ctx.shared = { aforo_jwt_claims = { customer_id = "unverified" } }
            assert.is_nil(handler._resolve_customer_id({}, nil, {}))
            mock_kong.ctx.shared = { aforo_jwt_claims = { signature_verified = false, customer_id = "unverified" } }
            assert.is_nil(handler._resolve_customer_id({}, nil, {}))
        end)

        it("an id longer than 64 characters or blank is no identity, from any source", function()
            local long = string.rep("x", 65)
            assert.is_nil(handler._resolve_customer_id({}, { custom_id = long }, {}))
            assert.is_nil(handler._resolve_customer_id({}, { custom_id = "   " }, {}))
            mock_kong.ctx.shared = { aforo_jwt_claims = { signature_verified = true, customer_id = long } }
            assert.is_nil(handler._resolve_customer_id({}, nil, {}))
        end)
    end)

    describe("metric resolution", function()
        local dict
        before_each(function()
            dict = new_shared_dict()
            ngx.shared.aforo_buffer = dict
            ngx.timers = {}
            http_mock.requests = {}
            http_mock.responses = {}
            http_mock.on_request = nil
        end)

        local function resolve(conf, method, path, header_metric)
            return handler._resolve_metric_name(conf, method, path, "svc", "route", "consumer", header_metric)
        end

        it("falls back to default_metric, never to the per-endpoint default template", function()
            assert.equals("api_calls", resolve({ metric_name_pattern = "{method} {path}" }, "GET", "/a"))
            assert.equals("api_calls", resolve({}, "GET", "/a"))
            assert.equals("calls", resolve({ default_metric = "calls" }, "GET", "/a"))
        end)

        it("honours metric_name_pattern when it was set to something else (fixed name or template)", function()
            assert.equals("platform_api_calls", resolve({ metric_name_pattern = "platform_api_calls" }, "GET", "/a"))
            assert.equals("svc:GET", resolve({ metric_name_pattern = "{service}:{method}" }, "GET", "/a"))
            -- A "%" in the path is data, not a gsub capture reference.
            assert.equals("GET /a%20b", resolve({ metric_name_pattern = "{method} {path} " }, "GET", "/a%20b"):sub(1, 10))
        end)

        it("metric_mappings: first match wins, method is optional, a bad pattern is skipped", function()
            local conf = { metric_mappings = {
                { path_pattern = "^/api/sms/otp", metric_name = "otp_delivered" },
                { path_pattern = "[", metric_name = "broken" },
                { path_pattern = "^/api/sms", method = "post", metric_name = "sms_sent" },
                { path_pattern = "^/api", metric_name = "generic" },
            } }
            assert.equals("otp_delivered", resolve(conf, "POST", "/api/sms/otp/1"))
            assert.equals("sms_sent", resolve(conf, "POST", "/api/sms/send"))
            assert.equals("generic", resolve(conf, "GET", "/api/sms/send"))
            assert.equals("api_calls", resolve(conf, "GET", "/other"))
        end)

        it("order: response header, central mappings, metric_mappings, pattern, default", function()
            local conf = {
                tenant_id = "t1", mappings_url = "https://catalog.test/m",
                metric_mappings = { { path_pattern = "^/api", metric_name = "local_rule" } },
                metric_name_pattern = "fixed_name", default_metric = "fallback",
            }
            assert.equals("local_rule", resolve(conf, "GET", "/api/x"))  -- nothing cached yet
            dict:set("aforo:gateway_mappings:t1", cjson.encode({
                { matchType = "PREFIX", value = "/api/x", metricName = "central" } }))
            assert.equals("central", resolve(conf, "GET", "/api/x/1"))
            assert.equals("from_header", resolve(conf, "GET", "/api/x/1", "from_header"))
            assert.equals("local_rule", resolve(conf, "GET", "/api/y"))
            assert.equals("fixed_name", resolve(conf, "GET", "/z"))
            conf.metric_name_pattern = nil
            assert.equals("fallback", resolve(conf, "GET", "/z"))
        end)

        it("central rules compare plain strings: EXACT, PREFIX, CONTAINS; anything else never matches", function()
            assert.is_true(handler._mapping_matches("/a/b", { matchType = "EXACT", value = "/a/b" }))
            assert.is_false(handler._mapping_matches("/a/b/c", { matchType = "EXACT", value = "/a/b" }))
            assert.is_true(handler._mapping_matches("/a/b/c", { matchType = "PREFIX", value = "/a/b" }))
            assert.is_true(handler._mapping_matches("/x/a.b/c", { matchType = "CONTAINS", value = "a.b" }))
            assert.is_false(handler._mapping_matches("/x/aXb/c", { matchType = "CONTAINS", value = "a.b" }))
            assert.is_false(handler._mapping_matches("/a", { matchType = "REGEX", value = ".*" }))
            assert.is_false(handler._mapping_matches("/a", { matchType = "PREFIX", value = "" }))
        end)

        it("central mappings are cached per tenant", function()
            dict:set("aforo:gateway_mappings:t1", cjson.encode({
                { matchType = "PREFIX", value = "/", metricName = "t1_metric" } }))
            assert.equals("t1_metric", resolve({ tenant_id = "t1", mappings_url = "u" }, "GET", "/a"))
            assert.equals("api_calls", resolve({ tenant_id = "t2", mappings_url = "u" }, "GET", "/a"))
        end)

        it("the access phase only schedules the mappings fetch; it never calls out itself", function()
            local conf = { tenant_id = "t1", mappings_url = "https://catalog.test/m" }
            handler:access(conf)
            handler:access(conf)
            assert.equals(0, #http_mock.requests)
            assert.equals(1, #ngx.timers)            -- one fetch in flight, not one per request
            assert.equals(0, ngx.timers[1].delay)
        end)

        it("fetch stores the table (plain or enveloped) and keeps the old one when the catalog fails", function()
            local conf = { tenant_id = "t1", mappings_url = "https://catalog.test/m", mappings_timeout_ms = 3000 }
            http_mock.responses = { { status = 200, body = cjson.encode({ success = true, data = {
                mappings = { { matchType = "EXACT", value = "/a", metricName = "m_a" } }, cacheTtlSeconds = 120 } }) } }
            handler._fetch_mappings(false, conf)
            assert.equals("https://catalog.test/m?tenantId=t1", http_mock.requests[1].url)
            assert.is_nil(http_mock.requests[1].params.headers["X-API-Key"])
            assert.equals("m_a", resolve(conf, "GET", "/a"))

            http_mock.responses = { { status = 503 } }
            handler._fetch_mappings(false, conf)
            assert.equals("m_a", resolve(conf, "GET", "/a"))

            http_mock.responses = { { status = 200, body = "<html>" } }
            handler._fetch_mappings(false, conf)
            assert.equals("m_a", resolve(conf, "GET", "/a"))
        end)

        it("a failed fetch is not retried on every request", function()
            local conf = { tenant_id = "t1", mappings_url = "https://catalog.test/m", mappings_refresh_seconds = 300 }
            http_mock.responses = { { err = "timeout" } }
            handler._fetch_mappings(false, conf)
            ngx.timers = {}
            handler:access(conf)
            assert.equals(0, #ngx.timers)
        end)
    end)

    describe("log phase: metric, quantity and drops", function()
        local dict
        local base = {
            aforo_endpoint = "http://ingestor.test/v1/ingest/batch", api_key = "k", tenant_id = "t1",
            flush_count = 50, flush_interval_ms = 5000, exclude_paths = {}, exclude_status_codes = {},
            metric_header = "X-Aforo-Metric", quantity_header = "X-Aforo-Quantity",
        }
        local function conf(extra)
            local c = {}
            for k, v in pairs(base) do c[k] = v end
            for k, v in pairs(extra or {}) do c[k] = v end
            return c
        end
        local function buffered()
            local l = dict.store["aforo:events"]
            local out = {}
            for i = 1, l and #l or 0 do out[i] = cjson.decode(l[i]) end
            return out
        end

        before_each(function()
            dict = new_shared_dict()
            ngx.shared.aforo_buffer = dict
            ngx.timers = {}
            mock_kong.ctx.shared = {}
            mock_kong.request._headers = { ["X-Request-Id"] = "req-1" }
            mock_kong.client.get_consumer = function() return { custom_id = "cust_1" } end
        end)

        after_each(function()
            mock_kong.client.get_consumer = function() return nil end
            mock_kong.response.get_header = function() return nil end
            mock_kong.request.get_method = function() return "GET" end
            mock_kong.request._headers = {}
        end)

        it("uses the mapped metric and the configured product type", function()
            handler:log(conf({ product_type = " agentic_api ",
                metric_mappings = { { path_pattern = "^/v1/accounts", metric_name = "account_reads" } } }))
            local e = buffered()[1]
            assert.equals("account_reads", e.metricName)
            assert.equals("AGENTIC_API", e.productType)
            assert.equals("req-1", e.idempotencyKey)
            assert.equals("SUCCESS", e.executionStatus)
        end)

        it("takes metric and quantity from the upstream RESPONSE headers, never from the request", function()
            mock_kong.request._headers["X-Aforo-Metric"] = "forged_by_client"
            mock_kong.request._headers["X-Aforo-Quantity"] = "999"
            handler:log(conf())
            assert.equals("api_calls", buffered()[1].metricName)
            assert.equals(1, buffered()[1].quantity)

            mock_kong.response.get_header = function(name)
                return ({ ["X-Aforo-Metric"] = "call_minutes", ["X-Aforo-Quantity"] = "2.5" })[name]
            end
            mock_kong.request._headers["X-Request-Id"] = "req-2"
            handler:log(conf())
            assert.equals("call_minutes", buffered()[2].metricName)
            assert.equals(2.5, buffered()[2].quantity)
        end)

        it("ignores a quantity header that is not a positive finite number", function()
            for _, bad in ipairs({ "0", "-3", "abc", "nan", "inf", "1e99" }) do
                assert.equals(1, handler._resolve_quantity({ quantity_header = "X-Aforo-Quantity" }, 0, bad))
            end
        end)

        it("drops and counts an event whose metric name the ingestor would refuse on shape", function()
            mock_kong.response.get_header = function(name)
                if name == "X-Aforo-Metric" then return string.rep("m", 256) end
                return nil
            end
            handler:log(conf())
            assert.equals(0, #buffered())
            assert.equals(1, dict:get("aforo_dropped:invalid_metric"))

            mock_kong.response.get_header = function() return nil end
            handler:log(conf({ metric_name_pattern = "   " }))
            assert.equals(0, #buffered())
            assert.equals(2, dict:get("aforo_dropped:invalid_metric"))
        end)

        it("does not meter a CORS preflight", function()
            mock_kong.request.get_method = function() return "OPTIONS" end
            mock_kong.request._headers["Access-Control-Request-Method"] = "POST"
            handler:log(conf())
            assert.equals(0, #buffered())
        end)

        it("skips a zero quantity (response_size of an empty body)", function()
            handler:log(conf({ quantity_source = "response_size" }))
            assert.equals(0, #buffered())
        end)

        it("default exclusions and the outcome table still apply after the merge", function()
            mock_kong.response.get_status = function() return 429 end
            handler:log(conf({ exclude_status_codes = { 401, 403, 429 } }))
            assert.equals(0, #buffered())
            mock_kong.response.get_status = function() return 504 end
            handler:log(conf({ exclude_status_codes = { 401, 403, 429 } }))
            assert.equals("TIMEOUT", buffered()[1].executionStatus)
            mock_kong.request._headers["X-Request-Id"] = "req-9"
            handler:log(conf({ status_outcomes = { ["504"] = "failed" } }))
            assert.equals("FAILED", buffered()[2].executionStatus)
            mock_kong.response.get_status = function() return 200 end
        end)

        it("keyId metadata only comes from a verified token", function()
            mock_kong.ctx.shared = { aforo_jwt_claims = { signature_verified = false, customer_id = "x", key_id = "k_unverified" } }
            handler:log(conf({ include_metadata = false }))
            assert.is_nil(buffered()[1].metadata)
            mock_kong.ctx.shared = { aforo_jwt_claims = { signature_verified = true, customer_id = "cust_v", key_id = "k_ok" } }
            mock_kong.request._headers["X-Request-Id"] = "req-3"
            handler:log(conf({ include_metadata = false }))
            assert.equals("k_ok", buffered()[2].metadata.keyId)
            assert.equals("cust_v", buffered()[2].customerId)
        end)
    end)

    describe("flush: retries, Retry-After and drop accounting", function()
        local dict
        local conf = {
            aforo_endpoint = "http://ingestor.test/v1/ingest/batch", api_key = "k", tenant_id = "t1",
            flush_count = 50, flush_interval_ms = 5000,
        }
        local function push(n)
            for i = 1, n do
                dict:rpush("aforo:events", cjson.encode({ customerId = "c" .. i, idempotencyKey = "key-" .. i }))
            end
        end

        before_each(function()
            dict = new_shared_dict()
            ngx.shared.aforo_buffer = dict
            ngx.timers = {}
            ngx.sleeps = {}
            http_mock.requests = {}
            http_mock.responses = {}
            http_mock.on_request = nil
        end)

        it("honours Retry-After on 429 and sends the same bytes on every attempt", function()
            push(2)
            http_mock.responses = {
                { status = 429, headers = { ["Retry-After"] = "7" } },
                { status = 503 },
                { status = 202 },
            }
            handler._flush_buffer(false, conf)
            assert.equals(3, #http_mock.requests)
            assert.same({ 7, 2 }, ngx.sleeps)
            assert.equals(http_mock.requests[1].params.body, http_mock.requests[2].params.body)
            assert.equals(http_mock.requests[1].params.body, http_mock.requests[3].params.body)
            assert.is_not_nil(http_mock.requests[3].params.body:find('"idempotencyKey":"key-1"', 1, true))
            assert.equals(0, dict:llen("aforo:events"))
        end)

        it("a Retry-After past the cap stops the attempt and re-buffers instead of sleeping", function()
            push(2)
            http_mock.responses = { { status = 429, headers = { ["Retry-After"] = "600" } } }
            handler._flush_buffer(false, conf)
            assert.equals(1, #http_mock.requests)
            assert.same({}, ngx.sleeps)
            assert.equals(2, dict:llen("aforo:events"))
            -- and the re-buffered events keep their keys for the next flush
            assert.is_not_nil(dict.store["aforo:events"][1]:find('"idempotencyKey":"key-1"', 1, true))
        end)

        it("schedules a follow-up flush for what it could not send", function()
            push(2)
            http_mock.responses = { { status = 503 }, { status = 503 }, { status = 503 } }
            handler._flush_buffer(false, conf, "aforo:flush_now")
            assert.equals(2, dict:llen("aforo:events"))
            assert.equals(1, #ngx.timers)
            assert.equals(5, ngx.timers[1].delay)
            assert.is_nil(dict:get("aforo:flush_now"))   -- guard released
        end)

        it("one pending flush per kind, however many requests arrive", function()
            mock_kong.client.get_consumer = function() return { custom_id = "cust_1" } end
            mock_kong.request._headers = { ["X-Request-Id"] = "r" }
            local c = { flush_count = 2, flush_interval_ms = 5000, exclude_paths = {}, exclude_status_codes = {} }
            for _ = 1, 20 do handler:log(c) end
            mock_kong.client.get_consumer = function() return nil end
            assert.equals(2, #ngx.timers)   -- one timed, one immediate
        end)

        it("counts a permanent 4xx as dropped (reason rejected) and does not retry it", function()
            push(3)
            http_mock.responses = { { status = 400, body = "bad" } }
            handler._flush_buffer(false, conf)
            assert.equals(1, #http_mock.requests)
            assert.equals(3, dict:get("aforo_dropped:rejected"))
            assert.equals(0, dict:llen("aforo:events"))
        end)

        it("counts events the ingestor refused inside an accepted batch (e.g. unknown metric)", function()
            push(3)
            http_mock.responses = { { status = 202, body = cjson.encode({ success = true, data = {
                accepted = 2, duplicates = 0, failed = 1,
                errors = { { index = 1, message = "Unknown metric: nope" } } } }) } }
            handler._flush_buffer(false, conf)
            assert.equals(1, dict:get("aforo_dropped:ingestor_rejected"))
            assert.equals(1, #http_mock.requests)
        end)

        it("never blocks: the log phase makes no HTTP call and no sleep", function()
            mock_kong.client.get_consumer = function() return { custom_id = "cust_1" } end
            mock_kong.request._headers = { ["X-Request-Id"] = "r" }
            handler:log({ flush_count = 1, flush_interval_ms = 5000, exclude_paths = {}, exclude_status_codes = {} })
            mock_kong.client.get_consumer = function() return nil end
            assert.equals(0, #http_mock.requests)
            assert.same({}, ngx.sleeps)
        end)
    end)

    describe("resolve_customer_id (security regression)", function()

        it("prefers JWT customer_id over consumer identity", function()
            mock_kong.ctx.shared = {
                aforo_jwt_claims = { signature_verified = true, customer_id = "cust_from_jwt" }
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
            mock_kong.ctx.shared = { aforo_jwt_claims = { signature_verified = true, customer_id = customer_id } }
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
                aforo_jwt_claims = { signature_verified = true, customer_id = "cust_a" },
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
            mock_kong.ctx.shared = { aforo_jwt_claims = { signature_verified = true, customer_id = id } }
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


    -- ── customer_id_jwt_claim: identity from the Kong-verified JWT ──
    -- The claim is read ONLY from kong.ctx.shared.authenticated_jwt_token,
    -- which Kong's jwt plugin sets after verifying the signature. A token a
    -- client merely sends in a header must never become a billing identity.
    describe("resolve_customer_id with customer_id_jwt_claim", function()
        local cjson_stub = package.loaded["cjson.safe"]
        local saved_decode, saved_ngx
        local payloads

        -- "h.<payload key>.s": base64 decode is stubbed to identity and the
        -- JSON decode looks the payload key up in `payloads`.
        local function token(key) return "h." .. key .. ".s" end

        before_each(function()
            saved_decode = cjson_stub.decode
            saved_ngx = _G.ngx
            payloads = {
                WORKSPCE = { tenant_id = "tenant_acme", sub = "user-1" },
                IMPERSON = { tenant_id = "tenant_acme", impersonated_by = "staff-9" },
                EMERGNCY = { tenant_id = "tenant_acme", emergency = true },
                NOTENANT = { sub = "svc" },
                BLANKTEN = { tenant_id = "   " },
                NUMTENAN = { tenant_id = 42 },
                FORGEDHD = { tenant_id = "tenant_victim" },
                LONGTENT = { tenant_id = string.rep("x", 65) },
                PADDEDTN = { tenant_id = "  tenant_acme " },
                FALSEIMP = { tenant_id = "tenant_acme", impersonated_by = false },
            }
            cjson_stub.decode = function(str) return payloads[str] end
            _G.ngx = { decode_base64 = function(str) return str end, ctx = {} }
            mock_kong.ctx.shared = {}
            mock_kong.request._headers = {}
        end)

        after_each(function()
            cjson_stub.decode = saved_decode
            _G.ngx = saved_ngx
            mock_kong.ctx.shared = {}
            mock_kong.request._headers = {}
        end)

        local conf = {
            customer_id_jwt_claim = "tenant_id",
            customer_id_jwt_exclude_claims = { "impersonated_by", "emergency" },
        }
        local issuer_consumer = { username = "aforo-jwt-issuer", custom_id = "aforo-platform-issuer" }

        it("uses the claim of the Kong-verified token", function()
            mock_kong.ctx.shared = { authenticated_jwt_token = token("WORKSPCE") }
            assert.equals("tenant_acme", handler._resolve_customer_id(conf, issuer_consumer, {}))
        end)

        it("never falls back to the shared issuer consumer", function()
            mock_kong.ctx.shared = { authenticated_jwt_token = token("NOTENANT") }
            assert.is_nil(handler._resolve_customer_id(conf, issuer_consumer, {}))
        end)

        it("returns nil when Kong verified no token, even with a consumer", function()
            assert.is_nil(handler._resolve_customer_id(conf, issuer_consumer, {}))
        end)

        it("IGNORES a token that is only in the Authorization header", function()
            mock_kong.request._headers = {
                ["Authorization"] = "Bearer " .. token("FORGEDHD"),
                ["X-Tenant-Id"] = "tenant_victim",
            }
            assert.is_nil(handler._resolve_customer_id(conf, nil,
                { authorization = "Bearer " .. token("FORGEDHD"), ["x-tenant-id"] = "tenant_victim" }))
        end)

        it("skips impersonation and emergency tokens", function()
            mock_kong.ctx.shared = { authenticated_jwt_token = token("IMPERSON") }
            assert.is_nil(handler._resolve_customer_id(conf, issuer_consumer, {}))
            mock_kong.ctx.shared = { authenticated_jwt_token = token("EMERGNCY") }
            assert.is_nil(handler._resolve_customer_id(conf, issuer_consumer, {}))
        end)

        it("an excluded claim that is false does not skip", function()
            mock_kong.ctx.shared = { authenticated_jwt_token = token("FALSEIMP") }
            assert.equals("tenant_acme", handler._resolve_customer_id(conf, nil, {}))
        end)

        it("rejects blank, non-string and over-long claim values", function()
            for _, key in ipairs({ "BLANKTEN", "NUMTENAN", "LONGTENT" }) do
                mock_kong.ctx.shared = { authenticated_jwt_token = token(key) }
                assert.is_nil(handler._resolve_customer_id(conf, issuer_consumer, {}))
            end
        end)

        it("trims surrounding whitespace", function()
            mock_kong.ctx.shared = { authenticated_jwt_token = token("PADDEDTN") }
            assert.equals("tenant_acme", handler._resolve_customer_id(conf, nil, {}))
        end)

        it("returns nil for an undecodable token", function()
            mock_kong.ctx.shared = { authenticated_jwt_token = "not-a-jwt" }
            assert.is_nil(handler._resolve_customer_id(conf, issuer_consumer, {}))
            mock_kong.ctx.shared = { authenticated_jwt_token = token("UNKNOWN_") }
            assert.is_nil(handler._resolve_customer_id(conf, issuer_consumer, {}))
        end)

        it("reads the pre-3.x ngx.ctx location", function()
            _G.ngx.ctx.authenticated_jwt_token = token("WORKSPCE")
            assert.equals("tenant_acme", handler._resolve_customer_id(conf, nil, {}))
        end)

        it("the Kong-verified claim decides even when the plugin validated an Aforo JWT too", function()
            mock_kong.ctx.shared = {
                aforo_jwt_claims = { signature_verified = true, customer_id = "cust_from_aforo_jwt" },
                authenticated_jwt_token = token("WORKSPCE"),
            }
            assert.equals("tenant_acme", handler._resolve_customer_id(conf, nil, {}))
        end)

        it("without the option, the consumer source is unchanged", function()
            mock_kong.ctx.shared = { authenticated_jwt_token = token("WORKSPCE") }
            assert.equals("aforo-platform-issuer",
                handler._resolve_customer_id({}, issuer_consumer, {}))
        end)
    end)

    -- ── No verified identity -> no event ──
    describe("log phase without a customer identity", function()
        local saved_ngx, writes

        before_each(function()
            saved_ngx = _G.ngx
            writes = 0
            local dict = new_shared_dict()
            local rpush = dict.rpush
            dict.rpush = function(self, k, v) writes = writes + 1; return rpush(self, k, v) end
            _G.ngx = setmetatable({
                shared = { aforo_buffer = dict },
                now = function() return 1790784909.554 end,
                timer = { at = function() return true end },
                var = {},
                ctx = {},
            }, { __index = saved_ngx })
            mock_kong.ctx.shared = {}
            mock_kong.request._headers = { ["X-Request-Id"] = "req-1" }
            mock_kong.log.debug = function() end
        end)

        after_each(function()
            _G.ngx = saved_ngx
            mock_kong.ctx.shared = {}
            mock_kong.request._headers = {}
            mock_kong.client.get_consumer = function() return nil end
        end)

        local conf = {
            aforo_endpoint = "http://ingest", api_key = "k", tenant_id = "t",
            metric_name_pattern = "platform_api_calls", quantity_source = "1",
            exclude_paths = {}, exclude_status_codes = { 401, 403, 429 },
            include_metadata = false, flush_count = 50, flush_interval_ms = 5000,
        }

        it("buffers nothing when no identity resolves", function()
            handler:log(conf)
            assert.equals(0, writes)
        end)

        it("buffers the event when a consumer is present", function()
            mock_kong.client.get_consumer = function() return { custom_id = "cust_1" } end
            handler:log(conf)
            assert.is_true(writes > 0)
        end)
    end)

    -- ── Drop metric (2026-07-05, A+ delivery-guarantee prompt 3) ──
    -- record_drop() maintains cumulative per-reason drop counters in the
    -- shared dict (plus an optional Prometheus counter when Kong's
    -- prometheus plugin is loaded — unavailable in this test env, which
    -- itself exercises the pcall-guarded fallback path).
    describe("record_drop (drop metric)", function()

        local dict_store
        local mock_dict

        before_each(function()
            dict_store = {}
            mock_dict = {
                incr = function(self, key, value, init)  -- luacheck: ignore 212
                    dict_store[key] = (dict_store[key] or init or 0) + value
                    return dict_store[key]
                end,
            }
            _G.ngx = _G.ngx or {}
            _G.ngx.shared = { aforo_buffer = mock_dict }
        end)

        it("accumulates a cumulative total per reason", function()
            assert.equals(1, handler._record_drop("buffer_overflow", 1))
            assert.equals(2, handler._record_drop("buffer_overflow", 1))
            assert.equals(2, dict_store["aforo_dropped:buffer_overflow"])
        end)

        it("counts multi-event drops (flush exhaustion) by batch size", function()
            assert.equals(37, handler._record_drop("flush_exhausted", 37))
            assert.equals(50, handler._record_drop("flush_exhausted", 13))
        end)

        it("keeps separate counters per reason", function()
            handler._record_drop("buffer_overflow", 1)
            handler._record_drop("flush_exhausted", 5)
            assert.equals(1, dict_store["aforo_dropped:buffer_overflow"])
            assert.equals(5, dict_store["aforo_dropped:flush_exhausted"])
        end)

        it("returns nil (and does not error) when the shared dict is missing", function()
            _G.ngx.shared = {}
            -- Must not raise: a metrics failure must never break metering.
            assert.is_nil(handler._record_drop("buffer_overflow", 1))
        end)
    end)

    -- ── AGENTIC_API detection (P0-5, docs/final/111 Session 4) ──
    -- Per descriptor eventSchema.inferenceRule = HAS_TRACE, an event with
    -- a resolvable W3C traceparent (or x-trace-id fallback) classifies as
    -- AGENTIC_API. MCP JSON-RPC still wins when both signals coexist —
    -- the log-phase caller only consults this helper in the else branch.
    describe("extract_agentic_trace_id (AGENTIC_API classification)", function()

        it("extracts the 32-hex trace_id from a well-formed traceparent", function()
            local trace = {
                traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            }
            assert.equals(
                "4bf92f3577b34da6a3ce929d0e0e4736",
                handler._extract_agentic_trace_id(trace)
            )
        end)

        it("returns nil when trace context is nil (no header captured)", function()
            assert.is_nil(handler._extract_agentic_trace_id(nil))
        end)

        it("returns nil when trace is empty (no headers present)", function()
            assert.is_nil(handler._extract_agentic_trace_id({}))
        end)

        it("rejects traceparent with wrong field count (fail-safe)", function()
            local trace = { traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-01" }
            assert.is_nil(handler._extract_agentic_trace_id(trace))
        end)

        it("rejects traceparent with version=ff per W3C spec", function()
            local trace = {
                traceparent = "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            }
            assert.is_nil(handler._extract_agentic_trace_id(trace))
        end)

        it("rejects traceparent with all-zero trace_id per W3C spec", function()
            local trace = {
                traceparent = "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
            }
            assert.is_nil(handler._extract_agentic_trace_id(trace))
        end)

        it("rejects traceparent with all-zero parent_id per W3C spec", function()
            local trace = {
                traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
            }
            assert.is_nil(handler._extract_agentic_trace_id(trace))
        end)

        it("rejects traceparent with non-hex trace_id", function()
            local trace = {
                traceparent = "00-ZZZZ2f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            }
            assert.is_nil(handler._extract_agentic_trace_id(trace))
        end)

        it("falls back to x-trace-id for non-OTel callers", function()
            local trace = { xTraceId = "legacy-agent-run-42" }
            assert.equals(
                "legacy-agent-run-42",
                handler._extract_agentic_trace_id(trace)
            )
        end)

        it("trims whitespace from x-trace-id fallback", function()
            local trace = { xTraceId = "  legacy-42  " }
            assert.equals("legacy-42", handler._extract_agentic_trace_id(trace))
        end)

        it("returns nil when x-trace-id is empty after trim", function()
            assert.is_nil(handler._extract_agentic_trace_id({ xTraceId = "   " }))
        end)

        it("prefers traceparent over x-trace-id when both present", function()
            local trace = {
                traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                xTraceId = "legacy-would-lose",
            }
            assert.equals(
                "4bf92f3577b34da6a3ce929d0e0e4736",
                handler._extract_agentic_trace_id(trace)
            )
        end)

        it("falls back to x-trace-id when traceparent is malformed", function()
            local trace = {
                traceparent = "not-a-real-traceparent",
                xTraceId = "legacy-42",
            }
            assert.equals("legacy-42", handler._extract_agentic_trace_id(trace))
        end)
    end)

    -- ── MCP idempotencyKey FROZEN — no clock component (2026-07-12) ──
    -- Peer-parity lock with Apigee/AWS/Azure/MuleSoft. Same class as the
    -- A+ delivery-guarantee prompt 4 concern that Rule #21 codifies for
    -- the compound path: a per-evaluation clock in the dedup ROOT makes
    -- every replay look like a new event → double-bill under redelivery.
    --
    -- These are STATIC-SOURCE assertions on handler.lua (not behavioral
    -- runtime tests): they lock the discipline into the source so the
    -- regression can't sneak in via a future PR. A behavioral test would
    -- need to drive the full log-phase which requires ngx.shared /
    -- kong.log / kong.router mocks the current spec does not provision.
    describe("MCP idempotencyKey — no clock component (regression lock)", function()

        local source
        setup(function()
            local f = io.open("./handler.lua", "rb")
            if not f then f = io.open("handler.lua", "rb") end
            assert.is_not_nil(f, "handler.lua must be readable from spec/ cwd")
            source = f:read("*all")
            f:close()
        end)

        it("event.idempotencyKey line does not concatenate ngx.now()", function()
            -- Find every source line that assigns event.idempotencyKey and
            -- verify none of them include ngx.now() (or os.time / os.clock).
            for line in source:gmatch("[^\n]+") do
                if line:find("event%.idempotencyKey%s*=") then
                    assert.is_nil(line:find("ngx%.now"),
                        "clock component ngx.now() in idempotencyKey — "
                            .. "breaks retry dedup, double-bills on redelivery. "
                            .. "Line: " .. line)
                    assert.is_nil(line:find("os%.time"),
                        "clock component os.time() in idempotencyKey — see above")
                    assert.is_nil(line:find("os%.clock"),
                        "clock component os.clock() in idempotencyKey — see above")
                end
            end
        end)

        it("carries a FROZEN comment near the MCP idempotencyKey", function()
            -- Discipline lock: ensure a future edit can't quietly re-add a
            -- clock without seeing this rationale block.
            assert.is_not_nil(
                source:find("Idempotency key FROZEN"),
                "MCP idempotencyKey must carry a FROZEN comment explaining "
                    .. "why no clock component may appear (post-P0-5 self-review)"
            )
        end)
    end)

    -- ── Idempotency-key fallback must NOT touch kong.tools (Kong 3.x crash) ──
    -- kong.tools is nil on the kong PDK global (Kong 3.x). The previous
    -- generate_idempotency_key fell back to kong.tools.uuid(), which raised
    -- "attempt to index field 'tools'" and crashed the log phase — every request
    -- without an X-Request-Id emitted ZERO events. The old mock hid it by providing
    -- a fake kong.tools.uuid; real Kong has none.
    describe("generate_idempotency_key (Kong 3.x crash regression)", function()

        it("uses the request id verbatim when present", function()
            assert.equals("req-123", handler._generate_idempotency_key("req-123"))
        end)

        it("falls back to a generated uuid when no request id is present", function()
            assert.equals("test-uuid", handler._generate_idempotency_key(nil))
        end)

        it("source never references kong.tools (would crash on Kong 3.x)", function()
            local f = io.open("./handler.lua", "rb") or io.open("handler.lua", "rb")
            assert.is_not_nil(f, "handler.lua must be readable from spec/ cwd")
            local src = f:read("*all"); f:close()
            assert.is_nil(src:find("kong%.tools"),
                "handler.lua must not reference kong.tools — it is nil on the Kong 3.x "
                    .. "PDK global and crashes the log phase. Use resty.jit-uuid / random_uuid().")
        end)
    end)

    -- ── executionStatus mapping (OUTCOME_BASED pricing) ──
    -- Shared rule, identical in all five gateway plugins (README
    -- "Execution status mapping"). nil means "omit the field".
    describe("outcome_from_status (executionStatus mapping)", function()
        local f = handler._outcome_from_status

        it("maps 2xx and 3xx to SUCCESS", function()
            for _, s in ipairs({ 200, 201, 204, 299, 301, 302, 304, 399 }) do
                assert.equals("SUCCESS", f(s), "status " .. s)
            end
        end)

        it("maps 408 and 504 to TIMEOUT", function()
            assert.equals("TIMEOUT", f(408))
            assert.equals("TIMEOUT", f(504))
        end)

        it("maps 499 (client closed request) to CANCELLED", function()
            assert.equals("CANCELLED", f(499))
        end)

        it("maps only 400 and 422 to VALIDATION_FAILED", function()
            assert.equals("VALIDATION_FAILED", f(400))
            assert.equals("VALIDATION_FAILED", f(422))
        end)

        it("maps 401, 403 and 429 to BLOCKED", function()
            for _, s in ipairs({ 401, 403, 429 }) do
                assert.equals("BLOCKED", f(s), "status " .. s)
            end
        end)

        it("maps 404 and every other 4xx/5xx to ERROR", function()
            for _, s in ipairs({ 402, 404, 405, 409, 410, 413, 451, 500, 502, 503, 599 }) do
                assert.equals("ERROR", f(s), "status " .. s)
            end
        end)

        it("accepts numeric strings", function()
            assert.equals("SUCCESS", f("200"))
            assert.equals("TIMEOUT", f("504"))
        end)

        it("returns nil (field omitted) when the status is not determinable", function()
            assert.is_nil(f(nil))
            assert.is_nil(f(0))
            assert.is_nil(f(101))
            assert.is_nil(f(600))
            assert.is_nil(f(-1))
            assert.is_nil(f("abc"))
            assert.is_nil(f(""))
        end)

        it("an override wins over the default table", function()
            local o = { ["404"] = "VALIDATION_FAILED", ["429"] = "ERROR", ["202"] = "PENDING" }
            assert.equals("VALIDATION_FAILED", f(404, o))
            assert.equals("ERROR", f(429, o))
            assert.equals("PENDING", f(202, o))
            assert.equals("BLOCKED", f(403, o), "unlisted codes keep the default")
        end)

        it("override values are case-insensitive; invalid ones are ignored", function()
            assert.equals("PARTIAL", f(206, { ["206"] = "partial" }))
            assert.equals("ERROR", f(404, { ["404"] = "NOT_A_STATUS" }))
            assert.equals("ERROR", f(404, { ["404"] = 7 }))
            assert.equals("SUCCESS", f(200, "not-a-table"))
        end)

        it("an override cannot make an undeterminable status billable", function()
            assert.is_nil(f(101, { ["101"] = "SUCCESS" }))
            assert.is_nil(f(0, { ["0"] = "SUCCESS" }))
        end)

        it("every event path stamps executionStatus via a helper with the overrides (source lock)", function()
            local fh = io.open("./handler.lua", "rb") or io.open("handler.lua", "rb")
            assert.is_not_nil(fh, "handler.lua must be readable from spec/ cwd")
            local src = fh:read("*all"); fh:close()
            local n = 0
            for line in src:gmatch("[^\n]+") do
                if line:find("event%.executionStatus%s*=") then
                    n = n + 1
                    local ok = line:find("outcome_from_status%(status, conf%.status_outcomes%)", 1)
                        or line:find("grpc_outcome%(grpc_code, status, conf%.status_outcomes%)", 1)
                    assert.is_not_nil(ok,
                        "executionStatus must come from outcome_from_status()/grpc_outcome() "
                        .. "with conf.status_outcomes. Line: " .. line)
                end
            end
            -- MCP, gRPC, GraphQL, standard/AGENTIC_API. WebSocket leaves it
            -- unset (101 is not a final outcome).
            assert.equals(4, n)
        end)
    end)

    describe("gRPC outcome (grpc-status wins over the HTTP status)", function()
        local g = handler._grpc_outcome

        it("maps grpc-status to the outcome table", function()
            assert.equals("SUCCESS", g(0, 200))
            assert.equals("CANCELLED", g(1, 200))
            assert.equals("VALIDATION_FAILED", g(3, 200))
            assert.equals("TIMEOUT", g(4, 200))
            assert.equals("BLOCKED", g(7, 200))
            assert.equals("BLOCKED", g(8, 200))
            assert.equals("VALIDATION_FAILED", g(9, 200))
            assert.equals("VALIDATION_FAILED", g(11, 200))
            assert.equals("BLOCKED", g(16, 200))
        end)

        it("a failure on an HTTP 200 is not SUCCESS", function()
            for _, c in ipairs({ 2, 5, 6, 10, 12, 13, 14, 15 }) do
                assert.equals("ERROR", g(c, 200), "grpc-status " .. c)
            end
        end)

        it("missing grpc-status falls back to the HTTP mapping", function()
            assert.equals("SUCCESS", g(nil, 200))
            assert.equals("ERROR", g(nil, 502))
            assert.equals("BLOCKED", g(nil, 401))
            assert.is_nil(g(nil, 0))
        end)

        it("HTTP overrides apply through the equivalent code", function()
            local o = { ["401"] = "FAILED", ["500"] = "PARTIAL" }
            assert.equals("FAILED", g(16, 200, o), "UNAUTHENTICATED shares 401's outcome")
            assert.equals("PARTIAL", g(13, 200, o), "unmapped codes share 500's outcome")
            assert.equals("BLOCKED", g(7, 200, o))
        end)

        it("every mapped code reaches the override for its own HTTP equivalent", function()
            local o = { ["404"] = "VALIDATION_FAILED", ["503"] = "TIMEOUT",
                        ["501"] = "FAILED", ["409"] = "PARTIAL" }
            assert.equals("VALIDATION_FAILED", g(5, 200, o), "NOT_FOUND is 404")
            assert.equals("TIMEOUT", g(14, 200, o), "UNAVAILABLE is 503")
            assert.equals("FAILED", g(12, 200, o), "UNIMPLEMENTED is 501")
            assert.equals("PARTIAL", g(6, 200, o), "ALREADY_EXISTS is 409")
            assert.equals("PARTIAL", g(10, 200, o), "ABORTED is 409")
            -- A 500 override does not sweep NOT_FOUND / UNAVAILABLE into it.
            assert.equals("ERROR", g(5, 200, { ["500"] = "PENDING" }))
        end)

        it("a code outside 0-16 is ERROR, not the HTTP 200 fallback", function()
            assert.equals("ERROR", g(17, 200))
        end)

        describe("read_grpc_status_code", function()
            local r = handler._read_grpc_status_code
            local saved_get_header, saved_var

            before_each(function()
                saved_get_header = mock_kong.response.get_header
                _G.ngx = _G.ngx or {}
                saved_var = _G.ngx.var
            end)

            after_each(function()
                mock_kong.response.get_header = saved_get_header
                _G.ngx.var = saved_var
            end)

            local function setup(header, upstream_trailer, sent_trailer)
                mock_kong.response.get_header = function(name)
                    if name == "grpc-status" then return header end
                    return nil
                end
                _G.ngx.var = {
                    upstream_trailer_grpc_status = upstream_trailer,
                    sent_trailer_grpc_status = sent_trailer,
                }
            end

            it("reads a trailers-only header first", function()
                setup("16", "0", nil)
                assert.equals(16, r())
            end)

            it("reads the upstream trailer when there is no header", function()
                setup(nil, "4", nil)
                assert.equals(4, r())
            end)

            it("reads the sent trailer last", function()
                setup(nil, nil, "3")
                assert.equals(3, r())
            end)

            it("returns nil when nothing readable is present", function()
                setup(nil, nil, nil)
                assert.is_nil(r())
                setup("abc", "-1", "1.5")
                assert.is_nil(r())
            end)

            it("accepts a code above 16 so it is not read as success", function()
                setup(nil, "17", nil)
                assert.equals(17, r())
            end)

            it("grpcStatusCode label uses the read code, else the HTTP status", function()
                local e = handler._extract_grpc_status
                assert.equals("INTERNAL", e(200, 13))
                assert.equals("OK", e(200, nil))
                assert.equals("UNKNOWN", e(200, 17))
                assert.equals("PERMISSION_DENIED", e(403, nil))
            end)
        end)
    end)

    describe("idempotency keys (Rule #21)", function()
        local function source()
            local fh = io.open("./handler.lua", "rb") or io.open("handler.lua", "rb")
            local src = fh:read("*all"); fh:close()
            return src
        end

        it("no idempotency key or its fallback contains a clock", function()
            local src = source()
            -- Collect each `event.idempotencyKey = ...` statement (it may span
            -- continuation lines ending in `..`).
            local stmts, cur = {}, nil
            for line in src:gmatch("[^\n]+") do
                if line:find("event%.idempotencyKey%s*=") then
                    cur = line
                elseif cur then
                    cur = cur .. " " .. line
                end
                if cur and not line:find("%.%.%s*$") then
                    table.insert(stmts, cur); cur = nil
                end
            end
            -- MCP, gRPC, GraphQL, WebSocket, standard
            assert.equals(5, #stmts)
            for _, st in ipairs(stmts) do
                assert.is_nil(st:find("ngx%.now"), "clock in key: " .. st)
                assert.is_nil(st:find("os%.time"), "clock in key: " .. st)
                assert.is_nil(st:find("os%.clock"), "clock in key: " .. st)
            end
        end)

        it("never calls kong.tools (nil on the Kong 3.x PDK)", function()
            local src = source()
            for line in src:gmatch("[^\n]+") do
                if not line:find("^%s*%-%-") then
                    assert.is_nil(line:find("kong%.tools%."), "kong.tools use: " .. line)
                end
            end
        end)
    end)

    describe("gRPC detection", function()
        local detect = handler._detect_grpc_call

        it("extracts service and method from the HTTP/2 path", function()
            local info = detect("application/grpc", "/acme.UserService/GetUser", "")
            assert.equals("acme.UserService", info.grpc_service)
            assert.equals("GetUser", info.grpc_method)
            assert.equals("UNARY", info.grpc_call_type)
            assert.is_false(info.is_grpc_web)
        end)

        it("strips the configured route prefix", function()
            local info = detect("application/grpc-web+proto", "/grpc/acme.S/M", "/grpc")
            assert.equals("acme.S", info.grpc_service)
            assert.equals("M", info.grpc_method)
            assert.is_true(info.is_grpc_web)
        end)

        it("ignores non-gRPC content types and malformed paths", function()
            assert.is_nil(detect("application/json", "/acme.S/M", ""))
            assert.is_nil(detect(nil, "/acme.S/M", ""))
            assert.is_nil(detect("application/grpc", "/only-one-segment", ""))
        end)
    end)

    describe("GraphQL detection", function()
        local detect = handler._detect_graphql_call
        local cjson = package.loaded["cjson.safe"]
        local real_decode = cjson.decode
        after_each(function() cjson.decode = real_decode end)

        it("reads the operation type and name", function()
            cjson.decode = function()
                return { query = "mutation CreateUser { createUser { id } }" }
            end
            local info = detect("{...}", "application/json", "/graphql", "graphql")
            assert.equals("MUTATION", info.gql_operation_type)
            assert.equals("CreateUser", info.gql_operation_name)
            assert.equals(2, info.gql_complexity)
        end)

        it("prefers operationName and defaults to QUERY", function()
            cjson.decode = function()
                return { query = "{ me { id } }", operationName = "Me" }
            end
            local info = detect("{...}", "application/json", "/api/gql", "graphql")
            assert.equals("QUERY", info.gql_operation_type)
            assert.equals("Me", info.gql_operation_name)
        end)

        it("ignores bodies without a query and non-GraphQL paths", function()
            cjson.decode = function() return { foo = 1 } end
            assert.is_nil(detect("{...}", "application/json", "/graphql", "graphql"))
            cjson.decode = function() return { query = "{ a }" } end
            assert.is_nil(detect("{...}", "application/json", "/v1/users", "graphql"))
            assert.is_nil(detect("", "application/json", "/graphql", "graphql"))
        end)
    end)

    describe("WebSocket upgrade detection", function()
        local detect = handler._detect_websocket_upgrade

        it("uses the handshake key as the connection id", function()
            mock_kong.request._headers = { ["Sec-WebSocket-Key"] = "dGhlIHNhbXBsZQ==" }
            local info = detect("websocket", 101, "req-1")
            assert.equals("dGhlIHNhbXBsZQ==", info.ws_connection_id)
        end)

        it("falls back to the request id, then a UUID", function()
            assert.equals("req-1", detect("WebSocket", 101, "req-1").ws_connection_id)
            assert.equals("test-uuid", detect("websocket", 101, nil).ws_connection_id)
        end)

        it("skips failed handshakes and non-upgrade requests", function()
            assert.is_nil(detect("websocket", 400, "req-1"))
            assert.is_nil(detect(nil, 101, "req-1"))
            assert.is_nil(detect("h2c", 101, "req-1"))
        end)
    end)
end)

describe("iso8601_utc (occurredAt wire format)", function()
    -- The ingestor binds occurredAt to java.time.Instant: a JSON number is read
    -- as epoch SECONDS, so epoch millis (1790784909554) became the year 58717
    -- and every Kong event failed the future-timestamp check.
    it("formats seconds with millisecond precision as UTC", function()
        assert.equals("2026-09-30T16:15:09.554Z", handler._iso8601_utc(1790784909.554))
    end)
    it("pads milliseconds and handles whole seconds", function()
        assert.equals("2026-09-30T16:15:09.000Z", handler._iso8601_utc(1790784909))
        assert.equals("2026-09-30T16:15:09.007Z", handler._iso8601_utc(1790784909.007))
    end)
    it("rounds .9995 up into the next second instead of printing 1000 ms", function()
        assert.equals("2026-09-30T16:15:10.000Z", handler._iso8601_utc(1790784909.9996))
    end)
    it("no event sends a numeric occurredAt", function()
        for _, file in ipairs({ "handler.lua", "compound-metering.lua" }) do
            local f = io.open("../" .. file, "rb") or io.open(file, "rb")
            assert.is_not_nil(f, file .. " must be readable")
            local src = f:read("*all")
            f:close()
            for line in src:gmatch("[^\n]+") do
                if line:find("occurredAt%s*=") then
                    assert.is_not_nil(line:find("iso8601_utc"),
                        file .. ": occurredAt must use iso8601_utc(). Line: " .. line)
                end
            end
        end
    end)
end)
