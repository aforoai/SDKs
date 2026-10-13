-- Access-phase enforcement: JWT validation, rate limiting, margin guard, and
-- what the log phase does with a request the plugin refused.
-- Run with: busted spec/
--
-- Its own PDK / ngx mocks, separate from handler_spec.lua: busted insulates
-- each spec file, so the handler is loaded fresh against these.

local cjson = require("cjson.safe")

-- ── base64 (plain LuaJIT has no ngx.decode_base64) ───────────────
local b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
local function b64enc(data)
    return ((data:gsub('.', function(x)
        local r, b = '', x:byte()
        for i = 8, 1, -1 do r = r .. (b % 2 ^ i - b % 2 ^ (i - 1) > 0 and '1' or '0') end
        return r
    end) .. '0000'):gsub('%d%d%d?%d?%d?%d?', function(x)
        if #x < 6 then return '' end
        local c = 0
        for i = 1, 6 do c = c + (x:sub(i, i) == '1' and 2 ^ (6 - i) or 0) end
        return b64chars:sub(c + 1, c + 1)
    end) .. ({ '', '==', '=' })[#data % 3 + 1])
end
local function b64dec(data)
    data = data:gsub('[^' .. b64chars .. '=]', '')
    return (data:gsub('.', function(x)
        if x == '=' then return '' end
        local r, f = '', (b64chars:find(x) - 1)
        for i = 6, 1, -1 do r = r .. (f % 2 ^ i - f % 2 ^ (i - 1) > 0 and '1' or '0') end
        return r
    end):gsub('%d%d%d?%d?%d?%d?%d?%d?', function(x)
        if #x ~= 8 then return '' end
        local c = 0
        for i = 1, 8 do c = c + (x:sub(i, i) == '1' and 2 ^ (8 - i) or 0) end
        return string.char(c)
    end))
end
local function b64url(s) return (b64enc(s):gsub('+', '-'):gsub('/', '_'):gsub('=', '')) end
-- The signature bytes are irrelevant: resty.openssl.pkey is mocked below and
-- answers verify() with pkey_verify_result.
local function jwt(claims, header)
    return b64url(cjson.encode(header or { alg = "RS256" })) .. "." .. b64url(cjson.encode(claims)) .. ".c2ln"
end

-- ── shared dict ─────────────────────────────────────────────────
local function new_dict()
    local d = { store = {} }
    function d:get(k) return self.store[k] end
    function d:set(k, v) self.store[k] = v; return true end
    function d:add(k, v) if self.store[k] ~= nil then return false end; self.store[k] = v; return true end
    function d:delete(k) self.store[k] = nil end
    function d:rpush(k, v) self.store[k] = self.store[k] or {}; table.insert(self.store[k], v); return #self.store[k] end
    function d:lpush(k, v) self.store[k] = self.store[k] or {}; table.insert(self.store[k], 1, v); return #self.store[k] end
    function d:lpop(k) local l = self.store[k]; return l and table.remove(l, 1) end
    function d:rpop(k) local l = self.store[k]; return l and table.remove(l) end
    function d:llen(k) local l = self.store[k]; return l and #l or 0 end
    function d:incr(k, v, init)
        local cur = self.store[k]
        if cur == nil then if init == nil then return nil, "not found" end; cur = init end
        self.store[k] = cur + v; return self.store[k]
    end
    function d:capacity() return 10485760 end
    return d
end

local timers = {}
_G.ngx = {
    shared = { aforo_buffer = new_dict() },
    null = cjson.null,
    time = function() return 1800000000 end,
    now = function() return 1800000000.5 end,
    worker = { pid = function() return 1 end },
    timer = { at = function(delay, fn, ...) table.insert(timers, { delay = delay, fn = fn, args = { ... } }); return true end },
    sleep = function() end,
    decode_base64 = b64dec,
    md5 = function(s) return (s:gsub("[^%w]", "_")) end,
    escape_uri = function(s) return (tostring(s):gsub("[^%w%-%._~]", function(c) return string.format("%%%02X", c:byte()) end)) end,
}

-- ── resty.redis mock: a key/value store plus scripted error replies ──
-- lua-resty-redis returns (false, msg) for a Redis error reply ("-ERR ...").
local redis_store, redis_error_reply, redis_auth_calls, redis_auth_ok, redis_connects
package.loaded["resty.redis"] = {
    new = function()
        local r = {}
        function r:set_timeout() end
        function r:connect(host, port)
            table.insert(redis_connects, host .. ":" .. tostring(port))
            return true
        end
        function r:auth(pw)
            table.insert(redis_auth_calls, pw)
            if redis_auth_ok then return true end
            return false, "WRONGPASS invalid username-password pair"
        end
        function r:set_keepalive() return true end
        function r:close() return true end
        function r:get(k)
            if redis_error_reply then return false, redis_error_reply end
            local v = redis_store[k]
            if v == nil then return ngx.null end
            return v
        end
        function r:init_pipeline() self._p = {} end
        function r:incr(k) table.insert(self._p, k) end
        function r:expire() end
        function r:commit_pipeline()
            local k = self._p[1]
            redis_store[k] = (redis_store[k] or 0) + 1
            return { redis_store[k], 1 }
        end
        return r
    end,
}
package.loaded["resty.sha256"] = { new = function() return { update = function(self, s) self.s = s end, final = function(self) return self.s end } end }
package.loaded["resty.string"] = { to_hex = function(s) return "hash(" .. s .. ")" end }

-- ── resty.openssl.pkey mock: records each key built, verify() scripted ──
local pkey_loads, pkey_verify_result = {}, true
package.loaded["resty.openssl.pkey"] = {
    new = function(key, opts)
        table.insert(pkey_loads, { key = key, format = opts and opts.format })
        return { verify = function() return pkey_verify_result end }
    end,
}

-- ── resty.http mock: records requests, answers from a script ────
local http_requests, http_responses = {}, {}
package.loaded["resty.http"] = {
    new = function()
        return {
            set_timeout = function() end,
            request_uri = function(_, url, params)
                table.insert(http_requests, { url = url, params = params })
                local r = table.remove(http_responses, 1) or { status = 202, body = "" }
                if r.err then return nil, r.err end
                return { status = r.status, body = r.body or "", headers = {} }
            end,
        }
    end,
}

-- ── PDK mock ────────────────────────────────────────────────────
local warnings = {}
local K
K = {
    request = {
        _h = {},
        get_header = function(n) return K.request._h[n] end,
        get_headers = function() return K.request._h end,
        get_method = function() return "GET" end,
        get_path = function() return "/v1/things" end,
    },
    response = {
        _exit = nil, _status = 200,
        exit = function(status, body, headers)
            K.response._exit = { status = status, body = body, headers = headers }
            K.response._status = status
        end,
        set_header = function(name, value)
            if type(value) ~= "string" and type(value) ~= "number" and type(value) ~= "boolean" then
                error("invalid header value for \"" .. name .. "\": got " .. type(value))
            end
        end,
        get_status = function() return K.response._status end,
        get_header = function() return nil end,
    },
    service = { request = { _h = {}, set_header = function(n, v)
        if type(v) ~= "string" then
            error("invalid header value for \"" .. n .. "\": got " .. type(v))
        end
        K.service.request._h[n] = v
    end } },
    client = {
        _consumer = nil, _credential = nil,
        get_consumer = function() return K.client._consumer end,
        get_credential = function() return K.client._credential end,
    },
    router = { get_service = function() return { name = "svc" } end, get_route = function() return { name = "rt" } end },
    ctx = { shared = {} },
    log = {
        info = function() end,
        warn = function(...)
            local parts = {}
            for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
            table.insert(warnings, table.concat(parts))
        end,
        err = function(...)
            local parts = {}
            for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
            table.insert(warnings, table.concat(parts))
        end,
        debug = function() end,
    },
}
_G.kong = K

package.path = "./?.lua;" .. package.path
local handler = require("handler")
local rate_limit = require("rate-limit-enforce")
local margin_guard = require("margin-guard")

local function reset()
    K.request._h = {}
    K.response._exit = nil
    K.response._status = 200
    K.service.request._h = {}
    K.client._consumer = nil
    K.client._credential = nil
    K.ctx.shared = {}
    redis_store, redis_error_reply = {}, nil
    redis_auth_calls, redis_auth_ok, redis_connects = {}, true, {}
    pkey_loads, pkey_verify_result = {}, true
    http_requests, http_responses = {}, {}
    timers, warnings = {}, {}
    ngx.shared.aforo_buffer = new_dict()
end

local BASE = { aforo_endpoint = "http://ingest/v1/ingest/batch", api_key = "k", tenant_id = "tenant-B",
               jwt_issuer = "https://auth.aforo.ai", exclude_status_codes = { 401, 403, 429 },
               default_metric = "api_calls", quantity_source = "1", flush_count = 50 }
local function conf(extra)
    local c = {}
    for k, v in pairs(BASE) do c[k] = v end
    for k, v in pairs(extra or {}) do c[k] = v end
    return c
end

-- Claims exactly as org-service's JwtTokenService mints them.
local function aforo_claims(over)
    local c = { sub = "cust-A1", iss = "https://auth.aforo.ai", exp = 1800000900, jti = "jti-1",
                tenant_id = "tenant-B", customer_id = "cust-A1",
                key_id = "7d1c1f6e-0000-4000-8000-000000000001", client_id = "afr_abc",
                scopes = "read", environment = "live" }
    for k, v in pairs(over or {}) do c[k] = v end
    return c
end

local JWT_CONF = { jwt_validation_enabled = true, jwt_public_key = "PEM" }

local function access_with(token, extra)
    K.request._h["Authorization"] = "Bearer " .. token
    handler:access(conf(extra or JWT_CONF))
    return K.response._exit
end

describe("access phase", function()
    before_each(reset)

    -- ── JWT validation ──────────────────────────────────────────
    describe("JWT", function()
        it("rejects a token minted for another tenant", function()
            local exit = access_with(jwt(aforo_claims({ tenant_id = "tenant-A" })))
            assert.is_not_nil(exit, "tenant-A token was accepted by tenant-B gateway")
            assert.equals(401, exit.status)
            assert.equals("TENANT_MISMATCH", exit.body.error_description)
        end)

        it("rejects a token with no tenant_id, or a null one", function()
            local claims = aforo_claims()
            claims.tenant_id = nil
            assert.equals("TENANT_MISMATCH", access_with(jwt(claims)).body.error_description)
            reset()
            assert.equals("TENANT_MISMATCH",
                access_with(jwt(aforo_claims({ tenant_id = cjson.null }))).body.error_description)
        end)

        it("accepts this tenant's token and forwards the plugin's tenant upstream", function()
            local exit = access_with(jwt(aforo_claims()))
            assert.is_nil(exit)
            assert.equals("tenant-B", K.service.request._h["X-Tenant-Id"])
            assert.equals("cust-A1", K.service.request._h["X-Customer-Id"])
            assert.equals("cust-A1", K.ctx.shared.aforo_jwt_claims.customer_id)
        end)

        it("accepts a lower-case bearer scheme", function()
            K.request._h["Authorization"] = "bearer " .. jwt(aforo_claims())
            handler:access(conf(JWT_CONF))
            assert.is_nil(K.response._exit)
            assert.is_not_nil(K.ctx.shared.aforo_jwt_claims)
        end)

        it("honours a client revocation written by org-service (jti:client:{client_id})", function()
            redis_store["jti:client:afr_abc"] = "revoked" -- JtiBlocklistService.blockByClientId
            local exit = access_with(jwt(aforo_claims()))
            assert.is_not_nil(exit, "revoked client's token was accepted")
            assert.equals("CLIENT_REVOKED", exit.body.error_description)
        end)

        it("still checks jti:client:{key_id} as a secondary key", function()
            redis_store["jti:client:7d1c1f6e-0000-4000-8000-000000000001"] = "revoked"
            assert.equals("CLIENT_REVOKED", access_with(jwt(aforo_claims())).body.error_description)
        end)

        it("honours a revoked token (jti:blocked:{jti})", function()
            redis_store["jti:blocked:jti-1"] = "1"
            assert.equals("TOKEN_REVOKED", access_with(jwt(aforo_claims())).body.error_description)
        end)

        it("fails OPEN on a Redis error reply (NOAUTH/LOADING/MOVED), never as TOKEN_REVOKED", function()
            redis_error_reply = "NOAUTH Authentication required."
            local exit = access_with(jwt(aforo_claims()))
            assert.is_nil(exit and exit.body.error_description)
            assert.is_not_nil(K.ctx.shared.aforo_jwt_claims)
            -- ...and says so, rather than failing silently.
            local said
            for _, w in ipairs(warnings) do
                if w:find("NOAUTH", 1, true) and w:find("Failing OPEN", 1, true) then said = true end
            end
            assert.is_true(said)
        end)

        it("fails OPEN when AUTH is refused", function()
            redis_auth_ok = false
            redis_store["jti:blocked:jti-1"] = "1"
            local exit = access_with(jwt(aforo_claims()), { jwt_validation_enabled = true,
                jwt_public_key = "PEM", jwt_redis_password = "wrong" })
            assert.is_nil(exit)
        end)

        it("AUTHs with jwt_redis_password, or the rate-limit password on the same Redis", function()
            access_with(jwt(aforo_claims()), { jwt_validation_enabled = true, jwt_public_key = "PEM",
                jwt_redis_password = "jwt-pw", rate_limit_redis_password = "rl-pw" })
            assert.same({ "jwt-pw" }, redis_auth_calls)

            reset()
            access_with(jwt(aforo_claims()), { jwt_validation_enabled = true, jwt_public_key = "PEM",
                rate_limit_redis_host = "redis-a", rate_limit_redis_password = "rl-pw" })
            assert.same({ "rl-pw" }, redis_auth_calls)
            assert.same({ "redis-a:6379" }, redis_connects)

            -- A different blocklist Redis does not get the rate-limit password.
            reset()
            access_with(jwt(aforo_claims()), { jwt_validation_enabled = true, jwt_public_key = "PEM",
                jwt_redis_host = "redis-b", rate_limit_redis_host = "redis-a",
                rate_limit_redis_password = "rl-pw" })
            assert.same({}, redis_auth_calls)
            assert.same({ "redis-b:6379" }, redis_connects)
        end)

        it("answers 401, not a Lua error, for a non-numeric or null exp", function()
            for _, exp in ipairs({ "soon", cjson.null, {} }) do
                reset()
                local exit
                assert.has_no.errors(function()
                    exit = access_with(jwt({ exp = exp }))
                end)
                assert.equals(401, exit.status)
                assert.equals("TOKEN_EXPIRED", exit.body.error_description)
            end
        end)

        it("does not crash on null or non-string claims in a signed token", function()
            local exit
            assert.has_no.errors(function()
                exit = access_with(jwt(aforo_claims({ customer_id = cjson.null, key_id = cjson.null,
                    jti = cjson.null, client_id = { 1 }, scopes = { "read", cjson.null, 7 },
                    environment = cjson.null })))
            end)
            assert.is_nil(exit)
            assert.equals("cust-A1", K.service.request._h["X-Customer-Id"])  -- falls back to sub
            assert.equals("read", K.service.request._h["X-Scopes"])
        end)

        it("rejects a signature that does not verify", function()
            pkey_verify_result = false
            assert.equals("INVALID_SIGNATURE", access_with(jwt(aforo_claims())).body.error_description)
        end)
    end)

    -- ── JWKS ────────────────────────────────────────────────────
    describe("JWKS", function()
        local URI = "https://auth.test/.well-known/jwks.json"
        local function jwks(...)
            local keys = {}
            for i, kid in ipairs({ ... }) do
                keys[i] = { kty = "RSA", use = "sig", kid = kid, alg = "RS256", n = "n-" .. kid, e = "AQAB" }
            end
            return { status = 200, body = cjson.encode({ keys = keys }) }
        end
        local JWKS_CONF = { jwt_validation_enabled = true, jwt_jwks_uri = URI }
        local function token(kid)
            return jwt(aforo_claims(), { alg = "RS256", typ = "JWT", kid = kid })
        end

        it("fetches the JWKS on first use and verifies with the key named by kid", function()
            http_responses = { jwks("other", "aforo-v1") }
            assert.is_nil(access_with(token("aforo-v1"), JWKS_CONF))
            assert.equals(1, #http_requests)
            assert.equals(URI, http_requests[1].url)
            assert.equals(1, #pkey_loads)
            assert.equals("JWK", pkey_loads[1].format)
            assert.equals("n-aforo-v1", cjson.decode(pkey_loads[1].key).n)
        end)

        it("serves later requests from the cache, without fetching", function()
            http_responses = { jwks("aforo-v1") }
            access_with(token("aforo-v1"), JWKS_CONF)
            K.response._exit = nil
            access_with(token("aforo-v1"), JWKS_CONF)
            access_with(token("aforo-v1"), JWKS_CONF)
            assert.equals(1, #http_requests)
            assert.is_nil(K.response._exit)
        end)

        it("refetches for an unknown kid at most once per interval", function()
            http_responses = { jwks("aforo-v1"), jwks("aforo-v1", "aforo-v2") }
            access_with(token("aforo-v1"), JWKS_CONF)
            -- The issuer rotated: the first token with the new kid triggers one refetch.
            -- (Clear the first fetch's lock, as its 30 s would have elapsed.)
            ngx.shared.aforo_buffer.store["aforo:jwks_fetch:" .. URI] = nil
            assert.is_nil(access_with(token("aforo-v2"), JWKS_CONF))
            assert.equals(2, #http_requests)
            -- A burst of made-up kids inside the interval costs no fetches.
            for i = 1, 5 do
                K.response._exit = nil
                assert.equals("INVALID_SIGNATURE",
                    access_with(token("made-up-" .. i), JWKS_CONF).body.error_description)
            end
            assert.equals(2, #http_requests)
        end)

        it("rejects when the JWKS cannot be fetched (fail closed)", function()
            http_responses = { { err = "connection refused" } }
            local exit = access_with(token("aforo-v1"), JWKS_CONF)
            assert.equals(401, exit.status)
            assert.equals("INVALID_SIGNATURE", exit.body.error_description)
        end)

        it("prefers a static jwt_public_key and never fetches", function()
            assert.is_nil(access_with(token("aforo-v1"), { jwt_validation_enabled = true,
                jwt_jwks_uri = URI, jwt_public_key = "PEM" }))
            assert.equals(0, #http_requests)
            assert.equals("PEM", pkey_loads[1].key)
        end)

        it("matches a kid-less token only when the JWKS has exactly one key", function()
            http_responses = { jwks("only") }
            assert.is_nil(access_with(jwt(aforo_claims()), JWKS_CONF))
            reset()
            http_responses = { jwks("a", "b") }
            assert.equals("INVALID_SIGNATURE", access_with(jwt(aforo_claims()), JWKS_CONF).body.error_description)
        end)

        -- org-service makes a new key pair on every start but keeps kid
        -- "aforo-v1"; verify() here succeeds only with the issuer's current key.
        local function with_issuer_key(current, fn)
            local mod = package.loaded["resty.openssl.pkey"]
            local orig = mod.new
            mod.new = function(key)
                local n = cjson.decode(key).n
                return { verify = function() return n == current.n end }
            end
            local ok, err = pcall(fn)
            mod.new = orig
            assert(ok, err)
        end

        it("refetches once when the issuer replaced the key under the same kid", function()
            local current = { n = "S1-OLD" }
            with_issuer_key(current, function()
                http_responses = { { status = 200, body = cjson.encode({ keys = {
                    { kty = "RSA", use = "sig", kid = "aforo-v1", alg = "RS256", n = "S1-OLD", e = "AQAB" } } }) } }
                assert.is_nil(access_with(token("aforo-v1"), JWKS_CONF))
                -- The issuer restarts: new key, same kid. The fetch lock has long expired.
                current.n = "S1-NEW"
                ngx.shared.aforo_buffer.store["aforo:jwks_fetch:" .. URI] = nil
                http_responses = { { status = 200, body = cjson.encode({ keys = {
                    { kty = "RSA", use = "sig", kid = "aforo-v1", alg = "RS256", n = "S1-NEW", e = "AQAB" } } }) } }
                for _ = 1, 5 do
                    K.response._exit = nil
                    assert.is_nil(access_with(token("aforo-v1"), JWKS_CONF))
                end
                assert.equals(2, #http_requests)   -- the first fetch and one refetch
            end)
        end)

        it("rejects a bad signature after that one refetch, and never on a failed refetch", function()
            local current = { n = "S1B-REAL" }
            with_issuer_key(current, function()
                http_responses = { { status = 200, body = cjson.encode({ keys = {
                    { kty = "RSA", use = "sig", kid = "aforo-v1", alg = "RS256", n = "S1B-REAL", e = "AQAB" } } }) } }
                access_with(token("aforo-v1"), JWKS_CONF)
                current.n = "nobody"                  -- forged: verifies against no key
                ngx.shared.aforo_buffer.store["aforo:jwks_fetch:" .. URI] = nil
                http_responses = { { err = "connection refused" } }
                K.response._exit = nil
                assert.equals("INVALID_SIGNATURE", access_with(token("aforo-v1"), JWKS_CONF).body.error_description)
                -- More forgeries within the interval cost no fetches.
                for _ = 1, 5 do
                    K.response._exit = nil
                    assert.equals(401, access_with(token("aforo-v1"), JWKS_CONF).status)
                end
                assert.equals(2, #http_requests)
            end)
        end)

        it("does not make requests wait after a failed cold fetch", function()
            local slept = 0
            local orig_sleep = ngx.sleep
            ngx.sleep = function(sec) slept = slept + sec end
            http_responses = { { err = "connection refused" } }
            access_with(token("aforo-v1"), JWKS_CONF)   -- the fetch fails
            for _ = 1, 3 do
                K.response._exit = nil
                assert.equals(401, access_with(token("aforo-v1"), JWKS_CONF).status)
            end
            ngx.sleep = orig_sleep
            assert.equals(1, #http_requests)
            assert.equals(0, slept)
        end)

        it("still waits for a cold fetch another request has in flight", function()
            local key = "aforo:jwks:" .. URI
            ngx.shared.aforo_buffer.store["aforo:jwks_fetch:" .. URI] = 1
            ngx.shared.aforo_buffer.store["aforo:jwks_inflight:" .. URI] = true
            local orig_sleep = ngx.sleep
            ngx.sleep = function()             -- the other request's fetch lands meanwhile
                ngx.shared.aforo_buffer.store["aforo:jwks_inflight:" .. URI] = nil
                ngx.shared.aforo_buffer.store[key] = cjson.encode({ fetched_at = ngx.now(), count = 1,
                    keys = { ["aforo-v1"] = cjson.encode({ kty = "RSA", kid = "aforo-v1", n = "n-aforo-v1", e = "AQAB" }) } })
            end
            local exit = access_with(token("aforo-v1"), JWKS_CONF)
            ngx.sleep = orig_sleep
            assert.is_nil(exit)
            assert.equals(0, #http_requests)
        end)

        it("rejects a kid the JWKS does not have, even with jwt_allow_unverified_signature", function()
            local OPEN = { jwt_validation_enabled = true, jwt_jwks_uri = URI, jwt_allow_unverified_signature = true }
            http_responses = { jwks("aforo-v1", "aforo-v2") }
            pkey_verify_result = false
            assert.equals(401, access_with(token("aforo-v1"), OPEN).status)   -- forged, real kid
            K.response._exit = nil
            assert.equals(401, access_with(token("not-a-real-kid"), OPEN).status)
            K.response._exit = nil
            assert.equals(401, access_with(jwt(aforo_claims()), OPEN).status) -- no kid, two keys
            -- JWKS unreachable: also a rejection, not "cannot verify".
            reset()
            http_responses = { { err = "connection refused" } }
            assert.equals(401, access_with(token("aforo-v1"), OPEN).status)
        end)

        it("keeps jwt_allow_unverified_signature for a configuration with no key source", function()
            assert.is_nil(access_with(token("any"), { jwt_validation_enabled = true,
                jwt_allow_unverified_signature = true }))
            assert.equals(0, #http_requests)
        end)

        it("refreshes a stale set in the background, still verifying from the cache", function()
            http_responses = { jwks("aforo-v1") }
            access_with(token("aforo-v1"), JWKS_CONF)
            local key = "aforo:jwks:" .. URI
            local entry = cjson.decode(ngx.shared.aforo_buffer.store[key])
            entry.fetched_at = ngx.now() - 7200
            ngx.shared.aforo_buffer.store[key] = cjson.encode(entry)
            K.response._exit = nil
            assert.is_nil(access_with(token("aforo-v1"), JWKS_CONF))
            assert.equals(1, #http_requests)   -- not fetched in the request
            assert.equals(1, #timers)          -- a refresh is scheduled instead
        end)
    end)
    -- ── Rate limiting ───────────────────────────────────────────
    describe("rate limiting", function()
        local RL = { rate_limit_enabled = true }
        local function policy(key, json)
            redis_store["ratelimit:policy:tenant-B:hash(" .. key .. ")"] = json
        end
        local ONE_PER_MINUTE = '{"policyName":"P","enforcementMode":"HARD",'
            .. '"tiers":[{"windowSeconds":60,"maxRequests":1,"burstCapacity":0}]}'

        it("does not crash on a policy as pricing writes it (RATE_PLAN_OVERRIDE, nulls)", function()
            policy("sk_live_1", '{"source":"RATE_PLAN_OVERRIDE","ratePlanId":"rp-1","policyId":null,'
                .. '"policyName":null,"scope":null,"enforcementMode":"HARD","maxRpm":100,"maxRph":null,'
                .. '"burstCapacity":null,"tiers":null}')
            K.request._h["Authorization"] = "Bearer sk_live_1"
            assert.has_no.errors(function() rate_limit.enforce(conf(RL)) end)
            assert.is_nil(K.response._exit)
            -- The flat maxRpm still applies once tiers is null.
            for _ = 1, 100 do rate_limit.enforce(conf(RL)) end
            assert.equals(429, K.response._exit.status)
        end)

        it("does not crash on a POLICY tier with burstCapacity null", function()
            policy("sk_live_2", '{"source":"POLICY","policyId":5,"policyName":"Gold","scope":"PER_KEY",'
                .. '"enforcementMode":"HARD","maxRpm":100,"maxRph":null,"burstCapacity":null,'
                .. '"tiers":[{"windowSeconds":60,"maxRequests":100,"burstCapacity":null,"priority":1}]}')
            K.request._h["Authorization"] = "Bearer sk_live_2"
            assert.has_no.errors(function() rate_limit.enforce(conf(RL)) end)
            assert.is_nil(K.response._exit)
        end)

        it("does not let a lower-case 'bearer' scheme bypass a HARD limit", function()
            policy("sk_live_3", ONE_PER_MINUTE)
            local c = conf(RL)
            K.request._h["Authorization"] = "bearer sk_live_3"
            assert.is_false(rate_limit.enforce(c))
            assert.is_true(rate_limit.enforce(c))
            assert.is_not_nil(K.response._exit, "2nd request over a limit of 1 was let through")
            assert.equals(429, K.response._exit.status)
        end)

        it("looks up the policy of a key-auth credential by its raw key", function()
            policy("sk_live_ka", ONE_PER_MINUTE)
            K.client._credential = { id = "cred-1", key = "sk_live_ka" }
            local c = conf(RL)
            rate_limit.enforce(c)
            assert.is_true(rate_limit.enforce(c))
            assert.equals(429, K.response._exit.status)
        end)

        it("skips JWT traffic, saying so once", function()
            K.request._h["Authorization"] = "Bearer " .. jwt(aforo_claims())
            for _ = 1, 3 do assert.is_false(rate_limit.enforce(conf(RL))) end
            local n = 0
            for _, w in ipairs(warnings) do
                if w:find("not applied to JWT-authenticated requests", 1, true) then n = n + 1 end
            end
            assert.equals(1, n)
        end)

        it("skips a tier without a numeric maxRequests instead of refusing everything", function()
            policy("sk_live_4", '{"enforcementMode":"HARD","tiers":[{"windowSeconds":60,"maxRequests":null}]}')
            K.request._h["Authorization"] = "Bearer sk_live_4"
            assert.is_false(rate_limit.enforce(conf(RL)))
            assert.is_nil(K.response._exit)
        end)

        it("fails open on a Redis error reply", function()
            redis_error_reply = "NOAUTH Authentication required."
            K.request._h["Authorization"] = "Bearer sk_live_5"
            assert.is_false(rate_limit.enforce(conf(RL)))
            assert.is_nil(K.response._exit)
        end)

        it("fails open, never 500, when anything in the check raises", function()
            K.request._h["Authorization"] = "Bearer sk_live_6"
            local orig = package.loaded["resty.sha256"]
            package.loaded["resty.sha256"] = { new = function() error("boom") end }
            local refused
            assert.has_no.errors(function() refused = rate_limit.enforce(conf(RL)) end)
            package.loaded["resty.sha256"] = orig
            assert.is_false(refused)
            assert.is_nil(K.response._exit)
        end)
    end)
    -- ── Margin guard ────────────────────────────────────────────
    -- Bodies exactly as pricing's MarginGuardService.quickCheck builds them.
    describe("margin guard", function()
        local MG = { margin_guard_enabled = true, margin_guard_url = "http://pricing/" }
        local BLOCK = { status = 200, body = '{"verdict":"BLOCK","currentLevel":"L3_BLOCK","marginPct":null,'
            .. '"message":"Requests blocked due to critically low margin","configId":null,"throttleRatePct":null}' }
        local THROTTLE = { status = 200, body = '{"verdict":"THROTTLE","currentLevel":"L2_THROTTLE",'
            .. '"message":"Request throttled due to low margin"}' }
        local ALLOW = { status = 200, body = '{"verdict":"ALLOW","currentLevel":"NONE"}' }

        it("blocks on pricing's real BLOCK body, with Retry-After", function()
            http_responses = { BLOCK }
            assert.is_true(margin_guard.check(conf(MG), "tenant-B", "cust-1"))
            assert.is_not_nil(K.response._exit, "BLOCK verdict let the request through")
            assert.equals(429, K.response._exit.status)
            assert.equals("30", K.response._exit.headers["Retry-After"])
            assert.equals("Requests blocked due to critically low margin", K.response._exit.body.error.message)
        end)

        it("asks the GLOBAL scope, then the customer's, with escaped parameters", function()
            http_responses = { ALLOW, ALLOW }
            assert.is_false(margin_guard.check(conf(MG), "tenant B", "cust/1&x"))
            assert.equals(2, #http_requests)
            assert.equals("http://pricing/internal/v1/margin-guard/quick-check"
                .. "?tenantId=tenant%20B&scopeType=GLOBAL&scopeId=global", http_requests[1].url)
            assert.equals("http://pricing/internal/v1/margin-guard/quick-check"
                .. "?tenantId=tenant%20B&scopeType=CUSTOMER&scopeId=cust%2F1%26x", http_requests[2].url)
        end)

        it("answers 429 on a THROTTLE of the customer's scope, and never caches it", function()
            http_responses = { ALLOW, THROTTLE }
            assert.is_true(margin_guard.check(conf(MG), "tenant-B", "cust-1"))
            assert.equals(429, K.response._exit.status)
            assert.equals("throttled", K.response._exit.headers["X-Margin-Guard"])
            assert.equals("1", K.response._exit.headers["Retry-After"])
            -- Next request: GLOBAL ALLOW is cached, the customer's THROTTLE was not.
            K.response._exit = nil
            http_responses = { ALLOW }
            assert.is_false(margin_guard.check(conf(MG), "tenant-B", "cust-1"))
            assert.equals(3, #http_requests)
            assert.is_nil(K.response._exit)
        end)

        it("caches ALLOW and BLOCK for margin_guard_cache_ttl", function()
            http_responses = { ALLOW, BLOCK }
            margin_guard.check(conf(MG), "tenant-B", "cust-1")
            K.response._exit = nil
            assert.is_true(margin_guard.check(conf(MG), "tenant-B", "cust-1"))
            assert.equals(2, #http_requests)  -- the second check came from the cache
            assert.equals(429, K.response._exit.status)
        end)

        it("checks the GLOBAL scope even with no customer identity", function()
            http_responses = { BLOCK }
            assert.is_true(margin_guard.check(conf(MG), "tenant-B", nil))
            assert.equals(1, #http_requests)
        end)

        it("fails open when pricing is down or answers non-200", function()
            http_responses = { { err = "timeout" }, { status = 500 } }
            assert.is_false(margin_guard.check(conf(MG), "tenant-B", "cust-1"))
            assert.is_nil(K.response._exit)
        end)

        it("fails open, without a 500, when margin_guard_url is missing", function()
            local refused
            assert.has_no.errors(function()
                refused = margin_guard.check(conf({ margin_guard_enabled = true }), "tenant-B", "cust-1")
            end)
            assert.is_false(refused)
            assert.equals(0, #http_requests)
        end)

        it("passes WARN through with a header to the upstream", function()
            http_responses = { { status = 200, body = '{"verdict":"WARN"}' }, ALLOW }
            assert.is_false(margin_guard.check(conf(MG), "tenant-B", "cust-1"))
            assert.equals("margin-low", K.service.request._h["X-Margin-Guard-Warning"])
        end)
    end)
    -- ── Refused requests are not billed ─────────────────────────
    describe("refused requests", function()
        -- exclude_status_codes emptied: the point is that the plugin knows it
        -- refused the request, whatever status it answered with.
        local function buffered()
            return ngx.shared.aforo_buffer:llen(handler._buffer_key(conf()))
        end
        local function run(extra)
            local c = conf(extra)
            c.exclude_status_codes = {}
            handler:access(c)
            handler:log(c)
            return c
        end

        it("does not meter a request refused 503 by preflight fail-closed", function()
            K.client._consumer = { custom_id = "cust-1", username = "acme" }
            http_responses = { { err = "connection refused" } }
            run({ preflight_quota_enabled = true, preflight_quota_fail_open = false,
                  preflight_quota_url = "http://ingest/api/v1/quota/check" })
            assert.equals(503, K.response._exit.status)
            assert.equals(0, buffered(), "the refused request was buffered as billable usage")
        end)

        it("does not meter a request refused 429 by the rate limiter, or run later checks", function()
            K.client._consumer = { custom_id = "cust-1", username = "acme" }
            redis_store["ratelimit:policy:tenant-B:hash(sk_live_9)"] = '{"enforcementMode":"HARD",'
                .. '"tiers":[{"windowSeconds":60,"maxRequests":0}]}'
            K.request._h["Authorization"] = "Bearer sk_live_9"
            run({ rate_limit_enabled = true, margin_guard_enabled = true,
                  margin_guard_url = "http://pricing" })
            assert.equals(429, K.response._exit.status)
            assert.equals(0, #http_requests)  -- margin guard was not asked
            assert.equals(0, buffered())
        end)

        it("does not meter a request refused 429 by the margin guard", function()
            K.client._consumer = { custom_id = "cust-1", username = "acme" }
            http_responses = { { status = 200, body = '{"verdict":"BLOCK"}' } }
            run({ margin_guard_enabled = true, margin_guard_url = "http://pricing" })
            assert.equals(429, K.response._exit.status)
            assert.equals(0, buffered())
        end)

        it("does not meter a request refused 401 by JWT validation", function()
            K.request._h["Authorization"] = "Bearer " .. jwt(aforo_claims({ tenant_id = "tenant-A" }))
            run(JWT_CONF)
            assert.equals(401, K.response._exit.status)
            assert.equals(0, buffered())
        end)

        it("does not meter a request whose access phase failed", function()
            K.client.get_consumer = function() error("boom") end
            local c = conf()
            c.exclude_status_codes = {}
            assert.has.errors(function() handler:access(c) end)
            K.client.get_consumer = function() return K.client._consumer end
            K.client._consumer = { custom_id = "cust-1", username = "acme" }
            K.response._status = 500
            handler:log(c)
            assert.equals(0, buffered())
        end)

        it("still meters a request the access phase let through", function()
            K.client._consumer = { custom_id = "cust-1", username = "acme" }
            run()
            assert.is_nil(K.response._exit)
            assert.equals(1, buffered())
        end)
    end)
end)
