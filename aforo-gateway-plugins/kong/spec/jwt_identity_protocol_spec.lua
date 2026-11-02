-- Behaviour carried from the internal line into 2.6.0 that spec/handler_spec.lua
-- and spec/access_spec.lua do not cover: in-plugin RS256 verification with
-- jwt_jwks_uri (fetch limits, rotation, stale keys), revocation when Redis cannot
-- answer (jti_redis_fail_mode), identity from customer_id_jwt_claim, the drop
-- counter, and the gRPC / GraphQL / WebSocket detectors.
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
    -- The 2.6.0 buffer (event-buffer.lua) and throttle use the safe_* forms
    -- and ask the dict for its size.
    function d:safe_set(k, v) return self:set(k, v) end
    function d:safe_add(k, v) return self:add(k, v) end
    function d:capacity() return 10485760 end
    function d:free_space() return 10485760 end
    function d:ttl(k) if self.store[k] == nil then return nil, "not found" end return 0 end
    function d:expire(k) return self.store[k] ~= nil end
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
-- 2.6.0: per-destination buffer keys use ngx.md5; worker id for re-arming.
ngx.md5 = ngx.md5 or function(s) return (s:gsub("[^%w]", "_")) end
ngx.worker.id = ngx.worker.id or function() return 0 end
ngx.timer.every = ngx.timer.every or function() return true end
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
            -- Streaming API (JWKS fetch): parse_uri + connect + request + body_reader.
            parse_uri = function(_, uri)
                local host, port, path, query = uri:match("^https://([^/:?#]+):?(%d*)([^?#]*)%??([^#]*)")
                if not host then return nil, "bad uri" end
                return { "https", host, tonumber(port) or 443, path ~= "" and path or "/", query }
            end,
            connect = function(self, opts)
                self._conn = opts
                return true
            end,
            request = function(self, params)
                local c = self._conn
                local port = c.port == 443 and "" or (":" .. c.port)
                table.insert(http_mock.requests, {
                    url = "https://" .. c.host .. port .. params.path,
                    params = { ssl_verify = c.ssl_verify, ssl_server_name = c.ssl_server_name,
                               headers = params.headers },
                })
                local r = table.remove(http_mock.responses, 1) or { status = 202 }
                if r.err then return nil, r.err end
                local body, pos = r.body or "", 1
                http_mock.bytes_read = 0
                return {
                    status = r.status, headers = r.headers or {},
                    body_reader = function(n)
                        if http_mock.on_read then http_mock.on_read() end
                        if r.read_err then return nil, r.read_err end
                        if pos > #body then return nil end
                        local chunk = body:sub(pos, pos + n - 1)
                        pos = pos + #chunk
                        http_mock.bytes_read = http_mock.bytes_read + #chunk
                        return chunk
                    end,
                }
            end,
            close = function() http_mock.closed = (http_mock.closed or 0) + 1 return true end,
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
        local redis_state
        -- W3.7: JWK modulus (base64url) -> PEM path, so the shim can verify JWKS keys with openssl.
        local jwk_pems = {}
        local jwk_n = {}

        setup(function()
            assert(sh("mkdir -p " .. tmp))
            assert(sh("openssl genrsa -out " .. tmp .. "/k1.pem 2048"))
            assert(sh("openssl rsa -in " .. tmp .. "/k1.pem -pubout -out " .. tmp .. "/k1.pub"))
            assert(sh("openssl genrsa -out " .. tmp .. "/k2.pem 2048"))
            assert(sh("openssl rsa -in " .. tmp .. "/k2.pem -pubout -out " .. tmp .. "/k2.pub"))
            pub_pem = slurp(tmp .. "/k1.pub")
            other_pub_pem = slurp(tmp .. "/k2.pub")
            priv_pem = slurp(tmp .. "/k1.pem")
            for _, name in ipairs({ "k1", "k2" }) do
                local out = io.popen("openssl rsa -pubin -in " .. tmp .. "/" .. name .. ".pub -modulus -noout")
                local hex = out:read("*a"):match("Modulus=(%x+)"); out:close()
                local bytes = hex:gsub("%x%x", function(h) return string.char(tonumber(h, 16)) end)
                jwk_n[name] = b64url(bytes)
                jwk_pems[jwk_n[name]] = slurp(tmp .. "/" .. name .. ".pub")
            end

            package.loaded["resty.openssl.pkey"] = {
                new = function(pem, opts)
                    if opts and opts.format == "JWK" then
                        local jwk = cjson.decode(pem)
                        pem = jwk and jwk.e == "AQAB" and jwk_pems[jwk.n]
                        if not pem then return nil, "unknown JWK" end
                    end
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
            -- Redis mock, driven per test through redis_state. Default: reachable,
            -- nothing revoked. connect_err / get_err simulate an outage;
            -- revoked lists the keys that hold a value.
            package.loaded["resty.redis"] = {
                new = function()
                    return {
                        set_timeout = function() end,
                        connect = function()
                            if redis_state.connect_err then return nil, redis_state.connect_err end
                            return true
                        end,
                        init_pipeline = function(self) self._p = {} end,
                        cancel_pipeline = function(self) self._p = nil end,
                        commit_pipeline = function(self)
                            local p = self._p or {}
                            self._p = nil
                            if redis_state.get_err then return nil, redis_state.get_err end
                            local out = {}
                            for i, key in ipairs(p) do
                                out[i] = redis_state.revoked[key] and "1" or ngx.null
                            end
                            return out
                        end,
                        get = function(self, key)
                            if self._p then table.insert(self._p, key); return end
                            if redis_state.get_err then return nil, redis_state.get_err end
                            if redis_state.revoked[key] then return "1" end
                            return ngx.null
                        end,
                        mget = function(_, ...)
                            if redis_state.get_err then return nil, redis_state.get_err end
                            if select("#", ...) > 1 then
                                return nil, "CROSSSLOT Keys in request don't hash to the same slot"
                            end
                            local out = {}
                            for i, key in ipairs({ ... }) do
                                out[i] = redis_state.revoked[key] and "1" or ngx.null
                            end
                            return out
                        end,
                        close = function() return true end,
                        set_keepalive = function() return true end,
                    }
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
            redis_state = { revoked = {} }
            handler._jwks_reset()
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

        it("fails closed with no jwt_public_key when the JWKS cannot be fetched", function()
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

        -- ── W3.7: keys from jwt_jwks_uri, chosen by kid ──────────────
        describe("jwt_jwks_uri", function()
            local URI = "https://auth.aforo.ai/.well-known/jwks.json"
            local saved_now
            local clock = 1788268682.221

            local function jwks(...)
                local keys = {}
                for _, name in ipairs({ ... }) do
                    keys[#keys + 1] = { kty = "RSA", kid = name, use = "sig", alg = "RS256", n = jwk_n[name], e = "AQAB" }
                end
                return cjson.encode({ keys = keys })
            end
            local function serve(...)
                http_mock.responses[#http_mock.responses + 1] = { status = 200, body = jwks(...) }
            end
            local function jconf(extra)
                local c = conf({ jwt_public_key = "", jwt_jwks_uri = URI })
                for k, v in pairs(extra or {}) do c[k] = v end
                return c
            end
            local function kid_token(kid, key)
                return sign({ alg = "RS256", typ = "JWT", kid = kid }, claims(), key)
            end

            before_each(function()
                http_mock.requests = {}
                http_mock.responses = {}
                saved_now = ngx.now
                clock = 1788268682.221
                ngx.now = function() return clock end
            end)
            after_each(function()
                ngx.now = saved_now
                http_mock.responses = {}
            end)

            it("verifies with the key named by kid and caches the set", function()
                serve("k1")
                assert.is_true(handler._validate_jwt(kid_token("k1"), jconf()).valid)
                assert.is_true(handler._validate_jwt(kid_token("k1"), jconf()).valid)
                assert.equals(1, #http_mock.requests)
                assert.equals(URI, http_mock.requests[1].url)
                assert.is_true(http_mock.requests[1].params.ssl_verify)
            end)

            it("a rotated key is picked up without a config change, at most one refresh per 30 s", function()
                serve("k1")
                assert.is_true(handler._validate_jwt(kid_token("k1"), jconf()).valid)
                -- The issuer rotates to k2. An unknown kid inside 30 s does not fetch again.
                clock = clock + 5
                assert.is_false(handler._validate_jwt(kid_token("k2", "k2"), jconf()).valid)
                assert.equals(1, #http_mock.requests)
                clock = clock + 30
                serve("k1", "k2")
                assert.is_true(handler._validate_jwt(kid_token("k2", "k2"), jconf()).valid)
                assert.equals(2, #http_mock.requests)
                -- A forged kid cannot make it fetch on every request.
                for _ = 1, 5 do
                    assert.is_false(handler._validate_jwt(kid_token("forged", "k2"), jconf()).valid)
                end
                assert.equals(2, #http_mock.requests)
            end)

            it("the token is still checked against the kid's own key", function()
                serve("k1", "k2")
                local r = handler._validate_jwt(kid_token("k1", "k2"), jconf())
                assert.is_false(r.valid)
                assert.equals("INVALID_SIGNATURE", r.reason)
            end)

            it("keeps the last good keys while the JWKS is down, then fails closed", function()
                serve("k1")
                assert.is_true(handler._validate_jwt(kid_token("k1"), jconf()).valid)
                clock = clock + 601
                http_mock.responses[1] = { status = 503 }
                assert.is_true(handler._validate_jwt(kid_token("k1"), jconf()).valid)
                assert.equals(2, #http_mock.requests)
                clock = clock + 86400
                http_mock.responses[1] = { err = "timeout" }
                local r = handler._validate_jwt(kid_token("k1"),
                    jconf({ jwt_allow_unverified_signature = true }))
                assert.is_false(r.valid)
                assert.equals("INVALID_SIGNATURE", r.reason)
            end)

            it("a worker whose first fetch failed retries after 5 s, not 30", function()
                http_mock.responses[1] = { status = 503 }
                assert.is_false(handler._validate_jwt(kid_token("k1"), jconf()).valid)
                clock = clock + 2
                assert.is_false(handler._validate_jwt(kid_token("k1"), jconf()).valid)
                assert.equals(1, #http_mock.requests)
                clock = clock + 4
                serve("k1")
                assert.is_true(handler._validate_jwt(kid_token("k1"), jconf()).valid)
                assert.equals(2, #http_mock.requests)
            end)

            it("refuses a JWKS URL that is not https, without fetching", function()
                local r = handler._validate_jwt(kid_token("k1"),
                    jconf({ jwt_jwks_uri = "http://auth.aforo.ai/.well-known/jwks.json" }))
                assert.is_false(r.valid)
                assert.equals(0, #http_mock.requests)
            end)

            it("refuses a JWKS whose Content-Length is over 256 KiB without reading the body", function()
                http_mock.responses[1] = { status = 200, body = jwks("k1"),
                    headers = { ["Content-Length"] = tostring(262145) } }
                assert.is_false(handler._validate_jwt(kid_token("k1"), jconf()).valid)
                assert.equals(0, http_mock.bytes_read)
            end)

            it("stops reading an undeclared-length JWKS once it passes 256 KiB", function()
                local huge = '{"keys":[],"pad":"' .. string.rep("x", 300000) .. '"}'
                http_mock.responses[1] = { status = 200, body = huge }
                assert.is_false(handler._validate_jwt(kid_token("k1"), jconf()).valid)
                assert.is_true(http_mock.bytes_read <= 262144 + 8192)
                assert.is_true(http_mock.bytes_read > 262144)
            end)

            it("a JWKS body that fails mid-read is not used", function()
                http_mock.responses[1] = { status = 200, body = jwks("k1"), read_err = "closed" }
                assert.is_false(handler._validate_jwt(kid_token("k1"), jconf()).valid)
            end)

            it("gives up on a JWKS body that trickles in past the 8 s fetch budget", function()
                local body = jwks("k1") .. string.rep(" ", 40000)
                http_mock.responses[1] = { status = 200, body = body }
                http_mock.on_read = function() clock = clock + 2 end
                assert.is_false(handler._validate_jwt(kid_token("k1"), jconf()).valid)
                http_mock.on_read = nil
            end)

            it("a fetch left flagged in flight (aborted coroutine) stops blocking refreshes after the budget", function()
                serve("k1")
                assert.is_true(handler._validate_jwt(kid_token("k1"), jconf()).valid)
                local entry = handler._jwks_cache()[URI]
                entry.fetching = true
                entry.fetch_started = clock
                entry.last_attempt = clock - 100  -- the 30 s refresh limit is not what holds it back
                -- An unknown kid while the flag is fresh: no second fetch.
                clock = clock + 2
                assert.is_false(handler._validate_jwt(kid_token("k2", "k2"), jconf()).valid)
                assert.equals(1, #http_mock.requests)
                -- Past the budget the stale flag is ignored and the set is refreshed.
                clock = clock + 8
                serve("k1", "k2")
                assert.is_true(handler._validate_jwt(kid_token("k2", "k2"), jconf()).valid)
                assert.equals(2, #http_mock.requests)
            end)

            it("connects with TLS verification and SNI for the JWKS host", function()
                serve("k1")
                assert.is_true(handler._validate_jwt(kid_token("k1"), jconf()).valid)
                assert.equals("auth.aforo.ai", http_mock.requests[1].params.ssl_server_name)
                assert.equals("auth.aforo.ai", http_mock.requests[1].params.headers["Host"])
            end)

            it("a token without kid uses the only key; with several keys it needs a kid", function()
                serve("k1")
                assert.is_true(handler._validate_jwt(sign(RS, claims()), jconf()).valid)
                handler._jwks_reset()
                serve("k1", "k2")
                assert.is_false(handler._validate_jwt(sign(RS, claims()), jconf()).valid)
            end)

            it("jwt_public_key verifies tokens the JWKS has no key for", function()
                serve("k2")
                assert.is_true(handler._validate_jwt(kid_token("old-kid"), jconf({ jwt_public_key = pub_pem })).valid)
            end)

            it("ignores keys that are private, not RSA, or not RS256", function()
                http_mock.responses[1] = { status = 200, body = cjson.encode({ keys = {
                    { kty = "RSA", kid = "k1", n = jwk_n.k1, e = "AQAB", d = "secret" },
                    { kty = "EC", kid = "k1", crv = "P-256", x = "a", y = "b" },
                    { kty = "RSA", kid = "k1", alg = "RS512", n = jwk_n.k1, e = "AQAB" },
                } }) }
                assert.is_false(handler._validate_jwt(kid_token("k1"), jconf()).valid)
            end)
        end)

        it("a different configured key is a different verifier (no stale key cache hit)", function()
            local t = sign(RS, claims())
            assert.is_true(handler._validate_jwt(t, conf()).valid)
            assert.is_false(handler._validate_jwt(t, conf({ jwt_public_key = other_pub_pem })).valid)
        end)

        -- w2-2-kong-jti-fail-open (2026-10-24): the revocation checks refuse
        -- when Redis cannot answer, unless jti_redis_fail_mode = "open".
        describe("revocation checks when Redis cannot answer", function()
            local function warns()
                local seen = {}
                local saved = mock_kong.log.warn
                mock_kong.log.warn = function(...)
                    seen[#seen + 1] = table.concat({ ... }, "")
                end
                return seen, function() mock_kong.log.warn = saved end
            end

            it("rejects a revoked jti and a revoked key_id when Redis answers", function()
                redis_state.revoked["jti:blocked:j1"] = true
                local r = handler._validate_jwt(sign(RS, claims({ jti = "j1" })), conf())
                assert.is_false(r.valid)
                assert.equals("TOKEN_REVOKED", r.reason)

                redis_state.revoked = { ["jti:client:key_1"] = true }
                r = handler._validate_jwt(sign(RS, claims({ jti = "j2" })), conf())
                assert.is_false(r.valid)
                assert.equals("CLIENT_REVOKED", r.reason)
            end)

            it("refuses by default when Redis is unreachable (jti check)", function()
                redis_state.connect_err = "connection refused"
                local r = handler._validate_jwt(sign(RS, claims({ jti = "j1" })), conf())
                assert.is_false(r.valid)
                assert.equals("REVOCATION_CHECK_UNAVAILABLE", r.reason)
                assert.equals(503, r.status)
            end)

            it("refuses by default when Redis is unreachable (key_id check, no jti)", function()
                redis_state.connect_err = "connection refused"
                local r = handler._validate_jwt(sign(RS, claims()), conf())
                assert.is_false(r.valid)
                assert.equals("REVOCATION_CHECK_UNAVAILABLE", r.reason)
                assert.equals(503, r.status)
            end)

            it("refuses when the GET itself errors after connecting", function()
                redis_state.get_err = "timeout"
                local r = handler._validate_jwt(sign(RS, claims({ jti = "j1" })), conf())
                assert.is_false(r.valid)
                assert.equals("REVOCATION_CHECK_UNAVAILABLE", r.reason)
            end)

            it("an explicit jti_redis_fail_mode = closed behaves like the default", function()
                redis_state.connect_err = "connection refused"
                local r = handler._validate_jwt(sign(RS, claims({ jti = "j1" })),
                    conf({ jti_redis_fail_mode = "closed" }))
                assert.equals("REVOCATION_CHECK_UNAVAILABLE", r.reason)
                local dict = ngx.shared.aforo_buffer
                assert.equals(1, dict:get("aforo_revocation_unavailable:jti:closed"))
            end)

            it("fail-open lets the token through, warns, and counts it", function()
                redis_state.connect_err = "connection refused"
                local seen, restore = warns()
                local r = handler._validate_jwt(sign(RS, claims({ jti = "j1" })),
                    conf({ jti_redis_fail_mode = "open" }))
                restore()
                assert.is_true(r.valid)
                local dict = ngx.shared.aforo_buffer
                assert.equals(1, dict:get("aforo_revocation_unavailable:jti:open"))
                assert.equals(1, dict:get("aforo_revocation_unavailable:client:open"))
                local joined = table.concat(seen, "\n")
                assert.truthy(joined:find("Failing OPEN", 1, true))
            end)

            it("access phase answers 503 with a JSON error body and stashes nothing", function()
                redis_state.connect_err = "connection refused"
                mock_kong.request._headers = { ["Authorization"] = "Bearer " .. sign(RS, claims({ jti = "j1" })) }
                mock_kong.response._exit = nil
                handler:access(conf())
                local exit = mock_kong.response._exit
                assert.equals(503, exit.status)
                assert.equals("temporarily_unavailable", exit.body.error)
                assert.equals("REVOCATION_CHECK_UNAVAILABLE", exit.body.error_description)
                assert.equals("1", exit.headers["Retry-After"])
                assert.is_nil(mock_kong.ctx.shared.aforo_jwt_claims)
                mock_kong.response._exit = nil
            end)

            it("access phase still answers 401 for a revoked token", function()
                redis_state.revoked["jti:blocked:j1"] = true
                mock_kong.request._headers = { ["Authorization"] = "Bearer " .. sign(RS, claims({ jti = "j1" })) }
                mock_kong.response._exit = nil
                handler:access(conf())
                assert.equals(401, mock_kong.response._exit.status)
                assert.equals("TOKEN_REVOKED", mock_kong.response._exit.body.error_description)
                mock_kong.response._exit = nil
            end)
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

        -- 2.6.0: the length is checked when the event is built (identity_problem,
        -- in characters as the ingestor counts them), which skips and counts the
        -- event; here a blank id is still no identity.
        it("a blank id is no identity, from any source", function()
            assert.is_nil(handler._resolve_customer_id({}, { custom_id = "   " }, {}))
            mock_kong.ctx.shared = { aforo_jwt_claims = { signature_verified = true, customer_id = "  " } }
            assert.is_nil(handler._resolve_customer_id({}, nil, {}))
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
    -- ── productType ─────────────────────────────────────────────
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

        it("caches ALLOW per tenant/customer/metric, and DENY until its Retry-After (2.8.0)", function()
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
            -- The second DENY comes from the cache (G333; before 2.8.0 it asked again).
            assert.equals(2, #http_mock.requests)
            assert.equals(429, mock_kong.response._exit.status)
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
            -- (An over-long value is skipped later, by identity_problem.)
            for _, key in ipairs({ "BLANKTEN", "NUMTENAN" }) do
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

    -- ── Idempotency-key fallback must NOT touch kong.tools (Kong 3.x crash) ──
    -- kong.tools is nil on the kong PDK global (Kong 3.x). The previous
    -- generate_idempotency_key fell back to kong.tools.uuid(), which raised
    -- "attempt to index field 'tools'" and crashed the log phase — every request
    -- without an X-Request-Id emitted ZERO events. The old mock hid it by providing
    -- a fake kong.tools.uuid; real Kong has none.

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

        it("uses the handshake key as the connection id (data only, not the key)", function()
            mock_kong.request._headers = { ["Sec-WebSocket-Key"] = "dGhlIHNhbXBsZQ==" }
            local info = detect("websocket", 101, "req-1")
            assert.equals("dGhlIHNhbXBsZQ==", info.ws_connection_id)
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
        for _, file in ipairs({ "handler.lua" }) do
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
