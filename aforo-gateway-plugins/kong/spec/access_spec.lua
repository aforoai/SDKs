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
    function d:free_space() return 10485760 end
    d.safe_set = d.set
    d.safe_add = d.add
    function d:ttl(k) if self.store[k] == nil then return nil, "not found" end return 0 end
    function d:expire(k) return self.store[k] ~= nil end
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
    sha1_bin = function(s) return "sha1:" .. tostring(#s) .. ":" .. s:sub(1, 16) end,
    escape_uri = function(s) return (tostring(s):gsub("[^%w%-%._~]", function(c) return string.format("%%%02X", c:byte()) end)) end,
}

-- ── resty.redis mock: a key/value store plus scripted error replies ──
-- lua-resty-redis returns (false, msg) for a Redis error reply ("-ERR ...").
-- It also keeps a connection pool (get_reused_times / set_keepalive), records
-- every command it is sent (one entry per round trip), and runs EVAL scripts
-- for real against the store through a small redis.call shim, so the
-- rate-limit script itself is what the specs exercise.
local redis_store, redis_error_reply, redis_auth_calls, redis_auth_ok, redis_connects
local redis_pool, redis_commands, redis_scripts, redis_ttl, redis_eval_error
-- connect() options and set_timeout() values, newest last (2.8.0 TLS / timeout specs).
local redis_connect_opts, redis_timeouts = {}, {}
-- redis_cluster: MGET over keys in different slots answers CROSSSLOT.
-- redis_pipeline_err: commit_pipeline() fails (timeout, closed socket).
-- redis_reply_override: key -> raw reply for that key's pipelined GET.
local redis_cluster, redis_pipeline_err, redis_reply_override
-- resty.http set_timeout() values, newest last.
local http_timeouts = {}
local function redis_call(cmd, k, v)
    cmd = string.upper(cmd)
    if cmd == "GET" then
        local x = redis_store[k]
        if x == nil then return false end
        return tostring(x)
    elseif cmd == "INCR" then
        redis_store[k] = (tonumber(redis_store[k]) or 0) + 1
        return redis_store[k]
    elseif cmd == "EXPIRE" then
        redis_ttl[k] = tonumber(v)
        return 1
    end
    error("mock redis.call: unsupported " .. cmd)
end
local function run_script(src, nkeys, ...)
    local args = { ... }
    local keys, argv = {}, {}
    for i = 1, nkeys do keys[i] = args[i] end
    for i = nkeys + 1, #args do argv[#argv + 1] = tostring(args[i]) end
    local fn = assert((loadstring or load)(src))
    local env = setmetatable({ KEYS = keys, ARGV = argv, redis = { call = redis_call } },
                             { __index = _G })
    if setfenv then setfenv(fn, env) end
    local out = fn()
    -- Redis converts Lua numbers in a reply to integers (truncation).
    local function conv(v)
        if type(v) == "number" then return math.floor(v) end
        if type(v) == "table" then
            local t = {}
            for i, x in ipairs(v) do t[i] = conv(x) end
            return t
        end
        return v
    end
    return conv(out)
end
package.loaded["resty.redis"] = {
    new = function()
        local r = {}
        function r:set_timeout(ms) table.insert(redis_timeouts, ms) end
        function r:connect(host, port, opts)
            table.insert(redis_connects, host .. ":" .. tostring(port))
            table.insert(redis_connect_opts, opts or {})
            local pool = (opts and opts.pool) or (host .. ":" .. tostring(port))
            self._pool = pool
            if (redis_pool[pool] or 0) > 0 then
                redis_pool[pool] = redis_pool[pool] - 1
                self._reused = 1
            else
                self._reused = 0
            end
            return true
        end
        function r:get_reused_times() return self._reused or 0 end
        function r:auth(pw)
            table.insert(redis_commands, "auth")
            table.insert(redis_auth_calls, pw)
            if redis_auth_ok then return true end
            return false, "WRONGPASS invalid username-password pair"
        end
        function r:set_keepalive()
            local pool = self._pool or "default"
            redis_pool[pool] = (redis_pool[pool] or 0) + 1
            return true
        end
        function r:close() return true end
        function r:get(k)
            -- lua-resty-redis: inside a pipeline a command is queued and
            -- returns nothing; its reply comes from commit_pipeline().
            if self._p then table.insert(self._p, { "get", k }); return end
            table.insert(redis_commands, "get")
            if redis_error_reply then return false, redis_error_reply end
            local v = redis_store[k]
            if v == nil then return ngx.null end
            return v
        end
        function r:mget(...)
            table.insert(redis_commands, "mget")
            if redis_error_reply then return false, redis_error_reply end
            -- Redis Cluster / ElastiCache Serverless: keys in different
            -- slots (no common hash tag) are refused as one command.
            if redis_cluster and select("#", ...) > 1 then
                return false, "CROSSSLOT Keys in request don't hash to the same slot"
            end
            local out = {}
            for i, k in ipairs({ ... }) do
                local v = redis_store[k]
                out[i] = (v == nil) and ngx.null or v
            end
            return out
        end
        function r:eval(src, nkeys, ...)
            table.insert(redis_commands, "eval")
            if redis_eval_error then return nil, redis_eval_error end
            redis_scripts[ngx.sha1_bin and ngx.sha1_bin(src) or src] = src
            return run_script(src, nkeys, ...)
        end
        function r:evalsha(sha, nkeys, ...)
            table.insert(redis_commands, "evalsha")
            if redis_eval_error then return nil, redis_eval_error end
            for bin, src in pairs(redis_scripts) do
                if package.loaded["resty.string"].to_hex(bin) == sha then
                    return run_script(src, nkeys, ...)
                end
            end
            return nil, "NOSCRIPT No matching script. Please use EVAL."
        end
        function r:init_pipeline() self._p = {} end
        function r:cancel_pipeline() self._p = nil end
        -- One round trip: recorded as "pipeline:<cmd>,<cmd>". A per-command
        -- error reply comes back as { false, msg } in its slot (as in
        -- lua-resty-redis); redis_pipeline_err fails the whole commit.
        function r:commit_pipeline()
            local p = self._p or {}
            self._p = nil
            local names = {}
            for i, c in ipairs(p) do names[i] = c[1] end
            table.insert(redis_commands, "pipeline:" .. table.concat(names, ","))
            if redis_pipeline_err then return nil, redis_pipeline_err end
            local out = {}
            for i, c in ipairs(p) do
                local v = redis_store[c[2]]
                if redis_error_reply then
                    out[i] = { false, redis_error_reply }
                elseif redis_reply_override and redis_reply_override[c[2]] ~= nil then
                    out[i] = redis_reply_override[c[2]]
                else
                    out[i] = (v == nil) and ngx.null or v
                end
            end
            return out
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
            set_timeout = function(_, ms) table.insert(http_timeouts, ms) end,
            request_uri = function(_, url, params)
                table.insert(http_requests, { url = url, params = params })
                local r = table.remove(http_responses, 1) or { status = 202, body = "" }
                if r.err then return nil, r.err end
                return { status = r.status, body = r.body or "", headers = {} }
            end,
            -- The JWKS fetch streams the body (connect + request + body_reader)
            -- so it can stop past its size cap; same script of responses.
            parse_uri = function(_, uri)
                local host, rest = uri:match("^https?://([^/]+)(.*)$")
                return { "https", host, 443, (rest ~= "" and rest) or "/", nil }
            end,
            connect = function(self, opts) self._host = opts.host; return true end,
            request = function(self, params)
                table.insert(http_requests, { url = "https://" .. self._host .. params.path, params = params })
                local r = table.remove(http_responses, 1) or { status = 202, body = "" }
                if r.err then return nil, r.err end
                local body, done = r.body or "", false
                return { status = r.status, headers = r.headers or {},
                         body_reader = function()
                             if done then return nil end
                             done = true
                             return body
                         end }
            end,
            close = function() return true end,
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
    redis_pool, redis_commands, redis_scripts, redis_ttl, redis_eval_error = {}, {}, {}, {}, nil
    redis_connect_opts, redis_timeouts = {}, {}
    redis_cluster, redis_pipeline_err, redis_reply_override = nil, nil, nil
    http_timeouts = {}
    ngx.shared.aforo_cache = nil
    ngx.now = function() return 1800000000.5 end
    ngx.time = function() return 1800000000 end
    pkey_loads, pkey_verify_result = {}, true
    http_requests, http_responses = {}, {}
    timers, warnings = {}, {}
    ngx.shared.aforo_buffer = new_dict()
    handler._jwks_reset()
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

-- A config field's definition from schema.lua, or nil.
local function schema_field(schema, name)
    for _, f in ipairs(schema.fields) do
        if f.config then
            for _, cf in ipairs(f.config.fields) do
                if cf[name] then return cf[name] end
            end
        end
    end
    return nil
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

        -- When Redis cannot answer, the check is refused with 503 unless
        -- jti_redis_fail_mode = "open" (2.4.0; Jay, 2026-10-24). An error reply
        -- is never read as TOKEN_REVOKED (Gowtham, 2026-10-12).
        local function said(...)
            local want = { ... }
            for _, w in ipairs(warnings) do
                local all = true
                for _, frag in ipairs(want) do if not w:find(frag, 1, true) then all = false end end
                if all then return true end
            end
            return false
        end

        it("refuses with 503 on a Redis error reply by default, never as TOKEN_REVOKED", function()
            redis_error_reply = "NOAUTH Authentication required."
            local exit = access_with(jwt(aforo_claims()))
            assert.equals(503, exit.status)
            assert.equals("REVOCATION_CHECK_UNAVAILABLE", exit.body.error_description)
            assert.equals("1", exit.headers["Retry-After"])
            assert.is_nil(K.ctx.shared.aforo_jwt_claims)
            assert.is_true(said("NOAUTH", "Refusing requests with 503"))
            assert.equals(1, ngx.shared.aforo_buffer.store["aforo_revocation_unavailable:jti:closed"])
        end)

        it("with jti_redis_fail_mode=open, fails OPEN on a Redis error reply and says so", function()
            redis_error_reply = "NOAUTH Authentication required."
            local exit = access_with(jwt(aforo_claims()), { jwt_validation_enabled = true,
                jwt_public_key = "PEM", jti_redis_fail_mode = "open" })
            assert.is_nil(exit and exit.body.error_description)
            assert.is_not_nil(K.ctx.shared.aforo_jwt_claims)
            assert.is_true(said("NOAUTH", "Failing OPEN"))
            assert.equals(1, ngx.shared.aforo_buffer.store["aforo_revocation_unavailable:jti:open"])
        end)

        it("refuses with 503 when AUTH is refused, and lets through in open mode", function()
            redis_auth_ok = false
            redis_store["jti:blocked:jti-1"] = "1"
            local exit = access_with(jwt(aforo_claims()), { jwt_validation_enabled = true,
                jwt_public_key = "PEM", jwt_redis_password = "wrong" })
            assert.equals(503, exit.status)
            reset()
            redis_auth_ok = false
            redis_store["jti:blocked:jti-1"] = "1"
            assert.is_nil(access_with(jwt(aforo_claims()), { jwt_validation_enabled = true,
                jwt_public_key = "PEM", jwt_redis_password = "wrong", jti_redis_fail_mode = "open" }))
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
    -- Per-worker cache (jwt_jwks_cache_ttl, default 600 s), refreshed at most
    -- once per 30 s (5 s before the first success). ngx.now() is fixed in
    -- this spec, so "time passing" is done by ageing the cache entry.
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
        -- Move the cache entry `seconds` into the past.
        local function age(seconds)
            local e = handler._jwks_cache()[URI]
            e.last_attempt = e.last_attempt - seconds
            e.fetched_at = e.fetched_at - seconds
            e.expires_at = e.expires_at - seconds
        end
        -- verify() succeeds only with the issuer's current key.
        local function with_issuer_key(current, fn)
            local mod = package.loaded["resty.openssl.pkey"]
            local orig = mod.new
            mod.new = function(key)
                local n = key == "PEM" and "PEM" or cjson.decode(key).n
                return { verify = function() return n == current.n end }
            end
            local ok, err = pcall(fn)
            mod.new = orig
            assert(ok, err)
        end

        it("fetches the JWKS on first use and verifies with the key named by kid", function()
            with_issuer_key({ n = "n-aforo-v1" }, function()
                http_responses = { jwks("other", "aforo-v1") }
                assert.is_nil(access_with(token("aforo-v1"), JWKS_CONF))
                assert.equals(1, #http_requests)
                assert.equals(URI, http_requests[1].url)
                K.response._exit = nil
                -- The other key of the set does not verify this issuer's token.
                assert.equals("INVALID_SIGNATURE", access_with(token("other"), JWKS_CONF).body.error_description)
            end)
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
            age(31)
            -- The issuer rotated: the first token with the new kid triggers one refetch.
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

        it("only fetches over https", function()
            local exit = access_with(token("aforo-v1"), { jwt_validation_enabled = true,
                jwt_jwks_uri = "http://auth.test/.well-known/jwks.json" })
            assert.equals("INVALID_SIGNATURE", exit.body.error_description)
            assert.equals(0, #http_requests)
        end)

        it("verifies with the JWKS first, and with jwt_public_key a kid the JWKS lacks", function()
            local BOTH = { jwt_validation_enabled = true, jwt_jwks_uri = URI, jwt_public_key = "PEM" }
            with_issuer_key({ n = "n-aforo-v1" }, function()
                http_responses = { jwks("aforo-v1") }
                assert.is_nil(access_with(token("aforo-v1"), BOTH))
                assert.equals(1, #http_requests)
            end)
            with_issuer_key({ n = "PEM" }, function()
                K.response._exit = nil
                assert.is_nil(access_with(token("legacy"), BOTH))
                assert.equals(1, #http_requests)   -- within the refetch interval
            end)
        end)

        it("matches a kid-less token only when the JWKS has exactly one key", function()
            http_responses = { jwks("only") }
            assert.is_nil(access_with(jwt(aforo_claims()), JWKS_CONF))
            reset()
            http_responses = { jwks("a", "b") }
            assert.equals("INVALID_SIGNATURE", access_with(jwt(aforo_claims()), JWKS_CONF).body.error_description)
        end)

        -- org-service makes a new key pair on every start but keeps kid "aforo-v1".
        it("refetches once when the issuer replaced the key under the same kid", function()
            local current = { n = "S1-OLD" }
            with_issuer_key(current, function()
                http_responses = { { status = 200, body = cjson.encode({ keys = {
                    { kty = "RSA", use = "sig", kid = "aforo-v1", alg = "RS256", n = "S1-OLD", e = "AQAB" } } }) } }
                assert.is_nil(access_with(token("aforo-v1"), JWKS_CONF))
                -- The issuer restarts: new key, same kid.
                current.n = "S1-NEW"
                age(31)
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
                age(31)
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
            local now = ngx.now()
            handler._jwks_cache()[URI] = { keys = {}, fetched_at = 0, expires_at = 0,
                                           last_attempt = now, fetching = true, fetch_started = now }
            local orig_sleep = ngx.sleep
            ngx.sleep = function()             -- the other request's fetch lands meanwhile
                handler._jwks_cache()[URI] = { keys = { ["aforo-v1"] = { verify = function() return true end } },
                    fetched_at = now, expires_at = now + 600, last_attempt = now }
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

        it("after the cache TTL one request refreshes; a failed refresh keeps the cached keys", function()
            http_responses = { jwks("aforo-v1") }
            access_with(token("aforo-v1"), JWKS_CONF)
            age(601)                               -- past jwt_jwks_cache_ttl
            http_responses = { { err = "connection refused" } }
            K.response._exit = nil
            assert.is_nil(access_with(token("aforo-v1"), JWKS_CONF))
            assert.equals(2, #http_requests)
            -- The last good set is used for at most 24 h.
            age(86400)
            handler._jwks_cache()[URI].last_attempt = ngx.now()
            K.response._exit = nil
            assert.equals("INVALID_SIGNATURE", access_with(token("aforo-v1"), JWKS_CONF).body.error_description)
        end)

        it("refuses an oversized JWKS without reading it all", function()
            http_responses = { { status = 200, headers = { ["Content-Length"] = "300000" }, body = "{}" } }
            assert.equals("INVALID_SIGNATURE", access_with(token("aforo-v1"), JWKS_CONF).body.error_description)
        end)

        it("names a token whose alg is not RS256", function()
            http_responses = { jwks("aforo-v1") }
            local exit = access_with(jwt(aforo_claims(), { alg = "HS256", kid = "aforo-v1" }), JWKS_CONF)
            assert.equals("UNSUPPORTED_ALGORITHM", exit.body.error_description)
            assert.equals(0, #http_requests)
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

        it("skips a JWT with no verified key_id, saying so once", function()
            K.request._h["Authorization"] = "Bearer " .. jwt(aforo_claims())
            for _ = 1, 3 do assert.is_false(rate_limit.enforce(conf(RL))) end
            local n = 0
            for _, w in ipairs(warnings) do
                if w:find("without a verified key_id is not rate limited", 1, true) then n = n + 1 end
            end
            assert.equals(1, n)
        end)

        it("skips a tier without a numeric maxRequests instead of refusing everything", function()
            policy("sk_live_4", '{"enforcementMode":"HARD","tiers":[{"windowSeconds":60,"maxRequests":null}]}')
            K.request._h["Authorization"] = "Bearer sk_live_4"
            assert.is_false(rate_limit.enforce(conf(RL)))
            assert.is_nil(K.response._exit)
        end)

        it("applies a PER_CUSTOMER limit to the customer, not to each of its keys", function()
            local P = '{"policyName":"Cust","scope":"PER_CUSTOMER","enforcementMode":"HARD",'
                .. '"tiers":[{"windowSeconds":60,"maxRequests":1,"burstCapacity":0}]}'
            policy("sk_live_a", P); policy("sk_live_b", P)
            K.client._consumer = { id = "c-uuid", custom_id = "cust-1", username = "acme" }
            local allowed = 0
            for _, key in ipairs({ "sk_live_a", "sk_live_b" }) do
                K.client._credential = { key = key }
                K.response._exit = nil
                if not rate_limit.enforce(conf(RL)) then allowed = allowed + 1 end
            end
            assert.equals(1, allowed)
        end)

        -- ── G328: a JWT is limited by its verified key id, not its bytes ──
        describe("JWT identity (G328)", function()
            local KEY_ID = "7d1c1f6e-0000-4000-8000-000000000001"
            local function keyid_policy(json)
                redis_store["ratelimit:policy:tenant-B:keyid:" .. KEY_ID] = json
            end
            local function jwt_rl(extra)
                local c = { rate_limit_enabled = true, jwt_validation_enabled = true,
                            jwt_public_key = "PEM" }
                for k, v in pairs(extra or {}) do c[k] = v end
                return c
            end

            it("keeps one counter for a key across a token refresh", function()
                keyid_policy(ONE_PER_MINUTE)
                assert.is_nil(access_with(jwt(aforo_claims({ jti = "jti-1" })), jwt_rl()))
                -- The refreshed token: new jti, new exp, new bytes, same key.
                local exit = access_with(jwt(aforo_claims({ jti = "jti-2", exp = 1800000950 })), jwt_rl())
                assert.is_not_nil(exit, "the refreshed token got a fresh counter")
                assert.equals(429, exit.status)
            end)

            it("uses the key_id of a token Kong's jwt plugin verified", function()
                keyid_policy(ONE_PER_MINUTE)
                local c = { rate_limit_enabled = true, customer_id_jwt_claim = "customer_id" }
                for _, jti in ipairs({ "a", "b" }) do
                    local token = jwt(aforo_claims({ jti = jti }))
                    K.request._h["Authorization"] = "Bearer " .. token
                    K.ctx.shared = { authenticated_jwt_token = token }
                    K.response._exit = nil
                    handler:access(conf(c))
                end
                assert.is_not_nil(K.response._exit)
                assert.equals(429, K.response._exit.status)
            end)

            it("never takes the key id of a token whose signature was not verified", function()
                keyid_policy(ONE_PER_MINUTE)
                local c = { rate_limit_enabled = true, jwt_validation_enabled = true,
                            jwt_allow_unverified_signature = true }
                for _ = 1, 3 do
                    assert.is_nil(access_with(jwt(aforo_claims()), c))
                end
            end)

            it("limits PER_CUSTOMER by the verified customer, across that customer's keys", function()
                local P = '{"policyName":"Cust","scope":"PER_CUSTOMER","enforcementMode":"HARD",'
                    .. '"tiers":[{"windowSeconds":60,"maxRequests":1,"burstCapacity":0}]}'
                redis_store["ratelimit:policy:tenant-B:keyid:key-1"] = P
                redis_store["ratelimit:policy:tenant-B:keyid:key-2"] = P
                assert.is_nil(access_with(jwt(aforo_claims({ key_id = "key-1" })), jwt_rl()))
                local exit = access_with(jwt(aforo_claims({ key_id = "key-2", jti = "j2" })), jwt_rl())
                assert.is_not_nil(exit)
                assert.equals(429, exit.status)
            end)
        end)

        -- ── G329: sliding window, no 2x burst at the window edge ──
        describe("sliding window (G329)", function()
            local TEN_PER_MINUTE = '{"policyName":"P10","enforcementMode":"HARD",'
                .. '"tiers":[{"windowSeconds":60,"maxRequests":10,"burstCapacity":0}]}'
            local W0 = 1800000000  -- a window boundary (divisible by 60)
            local function at(t)
                ngx.now = function() return t end
                ngx.time = function() return math.floor(t) end
            end
            after_each(function() at(1800000000.5) end)

            it("does not allow 2x the limit across a window edge", function()
                policy("sk_live_sw", TEN_PER_MINUTE)
                K.request._h["Authorization"] = "Bearer sk_live_sw"
                local c = conf(RL)
                at(W0 + 59.5)
                for i = 1, 10 do
                    assert.is_false(rate_limit.enforce(c), "request " .. i .. " refused")
                end
                -- One second later, in the next fixed window.
                at(W0 + 60.5)
                assert.is_true(rate_limit.enforce(c),
                    "a fresh fixed window let 10 more through one second later")
                assert.equals(429, K.response._exit.status)
                local retry = tonumber(K.response._exit.headers["Retry-After"])
                assert.is_true(retry >= 1 and retry <= 60, "Retry-After " .. tostring(retry))
            end)

            it("lets requests through again as the previous window ages out", function()
                policy("sk_live_sw2", TEN_PER_MINUTE)
                K.request._h["Authorization"] = "Bearer sk_live_sw2"
                local c = conf(RL)
                at(W0 + 59.5)
                for _ = 1, 10 do rate_limit.enforce(c) end
                -- Halfway through the next window, the previous one weighs ~half.
                at(W0 + 90)
                local allowed = 0
                for _ = 1, 10 do
                    K.response._exit = nil
                    if not rate_limit.enforce(c) then allowed = allowed + 1 end
                end
                assert.is_true(allowed >= 4 and allowed <= 5, "allowed " .. allowed)
            end)

            it("does not count a request it refused", function()
                policy("sk_live_sw3", ONE_PER_MINUTE)
                K.request._h["Authorization"] = "Bearer sk_live_sw3"
                local c = conf(RL)
                rate_limit.enforce(c)
                for _ = 1, 5 do rate_limit.enforce(c) end
                local key = "ratelimit:count:tenant-B:hash(sk_live_sw3):60:" .. tostring(W0 / 60)
                assert.equals(1, tonumber(redis_store[key]))
                -- Kept long enough to weigh the whole next window.
                assert.is_true((redis_ttl[key] or 0) >= 120)
            end)

            it("still counts every request in SOFT mode", function()
                policy("sk_live_sw4", '{"policyName":"S","enforcementMode":"SOFT",'
                    .. '"tiers":[{"windowSeconds":60,"maxRequests":1,"burstCapacity":0}]}')
                K.request._h["Authorization"] = "Bearer sk_live_sw4"
                local c = conf(RL)
                for _ = 1, 3 do assert.is_false(rate_limit.enforce(c)) end
                local key = "ratelimit:count:tenant-B:hash(sk_live_sw4):60:" .. tostring(W0 / 60)
                assert.equals(3, tonumber(redis_store[key]))
            end)
        end)

        -- ── G330: AUTH once per connection, one round trip per check ──
        describe("Redis round trips (G330)", function()
            it("sends AUTH only on a new connection", function()
                policy("sk_live_rt", '{"enforcementMode":"HARD","tiers":[{"windowSeconds":60,"maxRequests":100}]}')
                K.request._h["Authorization"] = "Bearer sk_live_rt"
                local c = conf({ rate_limit_enabled = true, rate_limit_redis_password = "rl-pw" })
                for _ = 1, 3 do rate_limit.enforce(c) end
                assert.equals(1, #redis_auth_calls, "AUTH sent on a pooled connection")
            end)

            it("checks every tier in one round trip once the policy is cached", function()
                local key = "sk_live_rt2"
                K.client._credential = { key = key }
                policy(key, '{"enforcementMode":"HARD","tiers":['
                    .. '{"windowSeconds":60,"maxRequests":100},{"windowSeconds":3600,"maxRequests":1000}]}')
                local c = conf(RL)
                rate_limit.enforce(c)
                rate_limit.enforce(c)
                redis_commands = {}
                rate_limit.enforce(c)
                assert.same({ "evalsha" }, redis_commands)
            end)

            it("fails open when the check script errors", function()
                policy("sk_live_rt3", ONE_PER_MINUTE)
                K.request._h["Authorization"] = "Bearer sk_live_rt3"
                redis_eval_error = "ERR something broke"
                for _ = 1, 3 do assert.is_false(rate_limit.enforce(conf(RL))) end
                assert.is_nil(K.response._exit)
            end)
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
            -- 2.8.0: pricing's public, key-authenticated path; the tenant comes from
            -- the key, so neither a tenantId parameter nor X-Tenant-Id is sent.
            assert.equals("http://pricing/api/v1/margin-guard/quick-check"
                .. "?scopeType=GLOBAL&scopeId=global", http_requests[1].url)
            assert.equals("http://pricing/api/v1/margin-guard/quick-check"
                .. "?scopeType=CUSTOMER&scopeId=cust%2F1%26x", http_requests[2].url)
        end)

        it("authenticates with the API key only, never X-Tenant-Id", function()
            http_responses = { ALLOW, ALLOW }
            assert.is_false(margin_guard.check(conf(MG), "tenant-B", "cust-1"))
            local h = http_requests[1].params.headers
            assert.equals(conf(MG).api_key, h["X-API-Key"])
            assert.is_nil(h["X-Tenant-Id"])
        end)

        it("keeps cache entries per tenant although the tenant is not on the wire", function()
            http_responses = { BLOCK, ALLOW, ALLOW }
            assert.is_true(margin_guard.check(conf(MG), "tenant-B", nil))
            assert.is_false(margin_guard.check(conf(MG), "tenant-C", nil))
            assert.equals(2, #http_requests)
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

        it("never caches the ALLOW for a request a THROTTLE let through", function()
            -- Pricing (with fix/margin-guard-throttle-pass-level): a throttle
            -- pass is ALLOW with currentLevel L2_THROTTLE; half are refused.
            local PASS = { status = 200, body = '{"verdict":"ALLOW","currentLevel":"L2_THROTTLE"}' }
            local refused = 0
            for i = 1, 20 do
                K.response._exit = nil
                -- GLOBAL is a plain ALLOW: cached after the first request.
                http_responses = (i == 1) and { ALLOW } or {}
                table.insert(http_responses, (i % 2 == 1) and THROTTLE or PASS)
                if margin_guard.check(conf(MG), "tenant-B", "cust-1") then refused = refused + 1 end
            end
            assert.equals(10, refused)
            assert.equals(21, #http_requests)   -- 1 GLOBAL + every customer check
        end)

        it("still caches a plain ALLOW, with currentLevel NONE or none at all", function()
            http_responses = { ALLOW, { status = 200, body = '{"verdict":"ALLOW"}' } }
            margin_guard.check(conf(MG), "tenant-B", "cust-1")
            margin_guard.check(conf(MG), "tenant-B", "cust-1")
            assert.equals(2, #http_requests)
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

-- ── 2.8.0 (wave 6): dicts, margin guard auth, preflight, Redis TLS, JWT aud/iss ──
describe("2.8.0 hardening", function()
    local preflight = require("preflight-quota")
    local event_util = require("event-util")

    -- A dict that honours TTLs against ngx.now(), for the cache specs.
    local function ttl_dict()
        local d = { store = {}, exp = {} }
        local function live(self, k)
            local e = self.exp[k]
            if e and ngx.now() >= e then self.store[k], self.exp[k] = nil, nil end
            return self.store[k]
        end
        function d:get(k) return live(self, k) end
        function d:set(k, v, ttl)
            self.store[k] = v
            self.exp[k] = (ttl and ttl > 0) and (ngx.now() + ttl) or nil
            return true
        end
        function d:add(k, v, ttl)
            if live(self, k) ~= nil then return false, "exists" end
            return self:set(k, v, ttl)
        end
        d.safe_set, d.safe_add = d.set, d.add
        function d:delete(k) self.store[k], self.exp[k] = nil, nil end
        function d:incr(k, v, init, init_ttl)
            local cur = live(self, k)
            if cur == nil then
                if init == nil then return nil, "not found" end
                self:set(k, init, init_ttl)
                cur = init
            end
            self.store[k] = cur + v
            return self.store[k]
        end
        function d:rpush(k, v) self.store[k] = self.store[k] or {}; table.insert(self.store[k], v); return #self.store[k] end
        function d:lpush(k, v) self.store[k] = self.store[k] or {}; table.insert(self.store[k], 1, v); return #self.store[k] end
        function d:lpop(k) local l = self.store[k]; return l and table.remove(l, 1) end
        function d:rpop(k) local l = self.store[k]; return l and table.remove(l) end
        function d:llen(k) local l = self.store[k]; return l and #l or 0 end
        function d:capacity() return 10485760 end
        function d:free_space() return 10485760 end
        function d:ttl(k) if live(self, k) == nil then return nil, "not found" end return 0 end
        function d:expire(k) return live(self, k) ~= nil end
        return d
    end

    local function count_keys(dict, prefix)
        local n = 0
        for k in pairs(dict.store) do
            if type(k) == "string" and k:sub(1, #prefix) == prefix then n = n + 1 end
        end
        return n
    end

    local function said(...)
        local want, n = { ... }, 0
        for _, w in ipairs(warnings) do
            local all = true
            for _, frag in ipairs(want) do if not w:find(frag, 1, true) then all = false end end
            if all then n = n + 1 end
        end
        return n
    end

    local now
    before_each(function()
        reset()
        if event_util._reset_cache_dict_warning then event_util._reset_cache_dict_warning() end
        now = 1800000000.5
        ngx.now = function() return now end
        ngx.time = function() return math.floor(now) end
    end)

    -- ── G323: caches in their own dict ─────────────────────────────
    describe("aforo_cache dict (G323)", function()
        local PF = { preflight_quota_enabled = true, preflight_quota_url = "http://ingest/api/v1/quota/check" }

        it("keeps caches, throttles and counters out of the event dict when aforo_cache is declared", function()
            ngx.shared.aforo_cache = ttl_dict()
            -- preflight ALLOW cache, margin guard cache, a warn throttle, a drop counter
            http_responses = { { status = 200, body = '{"decision":"ALLOW"}' },
                               { status = 200, body = '{"verdict":"ALLOW","currentLevel":"NONE"}' },
                               { err = "timeout" } }
            preflight.check(conf(PF), "cust-1", "api_calls")
            margin_guard.check(conf({ margin_guard_enabled = true, margin_guard_url = "http://pricing" }),
                "tenant-B", nil)
            margin_guard.check(conf({ margin_guard_enabled = true, margin_guard_url = "http://pricing",
                margin_guard_cache_ttl = 0 }), "tenant-X", nil)
            event_util.record_drop("rejected", 2)

            local buf, cache = ngx.shared.aforo_buffer, ngx.shared.aforo_cache
            assert.equals(1, count_keys(cache, "aforo:preflight:"))
            -- The ALLOW cache entry and the breaker's failure count from the timeout.
            assert.equals(2, count_keys(cache, "aforo:mg:"))
            assert.equals(1, count_keys(cache, "aforo:mg:cb:"))
            assert.equals(1, count_keys(cache, "aforo:warn:"))
            assert.equals(2, cache.store["aforo_dropped:rejected"])
            for k in pairs(buf.store) do
                assert.is_nil(k:find("^aforo:preflight:") or k:find("^aforo:mg:")
                    or k:find("^aforo:warn:") or k:find("^aforo_dropped:"),
                    "cache key in the event dict: " .. k)
            end
        end)

        it("keeps the rate-limit policy cache and the metric mappings in aforo_cache", function()
            ngx.shared.aforo_cache = ttl_dict()
            K.client._consumer = { custom_id = "cust-1", username = "acme" }
            redis_store["ratelimit:policy:tenant-B:hash(sk_live_9)"] = '{"enforcementMode":"SOFT",'
                .. '"tiers":[{"windowSeconds":60,"maxRequests":100}]}'
            K.request._h["Authorization"] = "Bearer sk_live_9"
            handler:access(conf({ rate_limit_enabled = true, mappings_url = "http://catalog/m" }))
            local cache, buf = ngx.shared.aforo_cache, ngx.shared.aforo_buffer
            assert.is_true(count_keys(cache, "ratelimit:policy:") + count_keys(cache, "aforo:rl:") >= 1)
            assert.is_true(count_keys(cache, "aforo:gateway_mappings:") >= 1)
            assert.equals(0, count_keys(buf, "ratelimit:policy:") + count_keys(buf, "aforo:rl:"))
            assert.equals(0, count_keys(buf, "aforo:gateway_mappings:"))
        end)

        it("falls back to aforo_buffer with one loud error when aforo_cache is not declared", function()
            http_responses = { { status = 200, body = '{"decision":"ALLOW"}' },
                               { status = 200, body = '{"decision":"ALLOW"}' } }
            preflight.check(conf(PF), "cust-1", "api_calls")
            preflight.check(conf(PF), "cust-2", "api_calls")
            assert.equals(2, count_keys(ngx.shared.aforo_buffer, "aforo:preflight:"))
            assert.equals(1, said("aforo_cache", "lua_shared_dict"))
        end)
    end)

    -- ── G331 / G332: margin guard ──────────────────────────────────
    describe("margin guard (G331, G332)", function()
        local MG = { margin_guard_enabled = true, margin_guard_url = "http://pricing" }

        it("sends the plugin's Aforo API key as X-API-Key", function()
            http_responses = { { status = 200, body = '{"verdict":"ALLOW"}' } }
            margin_guard.check(conf(MG), "tenant-B", nil)
            assert.equals("k", http_requests[1].params.headers["X-API-Key"])
            assert.is_nil(http_requests[1].params.headers["Authorization"])
        end)

        it("escapes the scope type as well as tenant and scope id", function()
            http_responses = { { status = 200, body = '{"verdict":"ALLOW"}' } }
            margin_guard.check(conf(MG), "tenant-B", nil)
            assert.truthy(http_requests[1].url:find("scopeType=GLOBAL&", 1, true))
        end)

        it("logs a missing cache dict once, and still checks", function()
            ngx.shared.aforo_buffer = nil
            http_responses = { { status = 200, body = '{"verdict":"ALLOW"}' },
                               { status = 200, body = '{"verdict":"ALLOW"}' } }
            margin_guard.check(conf(MG), "tenant-B", nil)
            margin_guard.check(conf(MG), "tenant-B", nil)
            assert.equals(2, #http_requests)
            assert.equals(1, said("aforo_cache", "not declared"))
        end)
    end)

    -- ── G333 / G334: pre-flight quota ──────────────────────────────
    describe("pre-flight quota (G333, G334)", function()
        local PF = { preflight_quota_enabled = true, preflight_quota_url = "http://ingest/api/v1/quota/check" }
        local DENY = { status = 200, body = '{"decision":"DENY","reason":"Wallet empty","retryAfterMs":3000}' }

        it("caches a DENY until retryAfter and answers 429 from the cache", function()
            ngx.shared.aforo_cache = ttl_dict()
            http_responses = { DENY }
            assert.is_true(preflight.check(conf(PF), "cust-1", "api_calls"))
            assert.equals("3", K.response._exit.headers["Retry-After"])

            K.response._exit = nil
            now = now + 1.2
            assert.is_true(preflight.check(conf(PF), "cust-1", "api_calls"))
            assert.equals(1, #http_requests, "a cached DENY asked the ingestor again")
            assert.equals(429, K.response._exit.status)
            assert.equals("2", K.response._exit.headers["Retry-After"])
            assert.equals("Wallet empty", K.response._exit.body.message)

            -- Past retryAfter the ingestor is asked again.
            K.response._exit = nil
            now = now + 2
            http_responses = { { status = 200, body = '{"decision":"ALLOW"}' } }
            assert.is_false(preflight.check(conf(PF), "cust-1", "api_calls"))
            assert.equals(2, #http_requests)
        end)

        it("bounds a cached DENY to 60 seconds, and to 5 without retryAfterMs", function()
            ngx.shared.aforo_cache = ttl_dict()
            http_responses = { { status = 200, body = '{"decision":"DENY","retryAfterMs":3600000}' },
                               { status = 200, body = '{"decision":"DENY"}' } }
            preflight.check(conf(PF), "cust-1", "api_calls")
            preflight.check(conf(PF), "cust-2", "api_calls")
            assert.equals("5", K.response._exit.headers["Retry-After"])
            now = now + 6
            http_responses = { { status = 200, body = '{"decision":"ALLOW"}' },
                               { status = 200, body = '{"decision":"ALLOW"}' } }
            preflight.check(conf(PF), "cust-2", "api_calls")
            assert.equals(3, #http_requests)          -- cust-2's DENY expired
            preflight.check(conf(PF), "cust-1", "api_calls")
            assert.equals(3, #http_requests)          -- cust-1's still cached
            now = now + 55
            preflight.check(conf(PF), "cust-1", "api_calls")
            assert.equals(4, #http_requests)          -- capped at 60 s
        end)

        it("sends the quantity the request will be billed", function()
            http_responses = { { status = 200, body = '{"decision":"ALLOW"}' },
                               { status = 200, body = '{"decision":"ALLOW"}' } }
            preflight.check(conf(PF), "cust-1", "api_calls", 25)
            local body = cjson.decode(http_requests[1].params.body)
            assert.equals(25, body.estimatedQuantity)
            preflight.check(conf(PF), "cust-2", "api_calls")
            assert.equals(1, cjson.decode(http_requests[2].params.body).estimatedQuantity)
        end)

        it("the access phase sends a fixed quantity_source as estimatedQuantity", function()
            K.client._consumer = { custom_id = "cust-1", username = "acme" }
            http_responses = { { status = 200, body = '{"decision":"ALLOW"}' } }
            local c = conf(PF)
            c.quantity_source = "3"
            handler:access(c)
            assert.equals(3, cjson.decode(http_requests[1].params.body).estimatedQuantity)
        end)

        it("opens a breaker after consecutive failures, then probes once after the cool-down", function()
            ngx.shared.aforo_cache = ttl_dict()
            local c = conf(PF)
            c.preflight_quota_breaker_threshold = 3
            c.preflight_quota_breaker_cooldown_s = 10
            for i = 1, 3 do
                http_responses = { { err = "timeout" } }
                assert.is_false(preflight.check(c, "cust-" .. i, "api_calls"))
            end
            assert.equals(3, #http_requests)
            -- Open: no call, fails open at once.
            assert.is_false(preflight.check(c, "cust-9", "api_calls"))
            assert.equals(3, #http_requests, "an open breaker still called the ingestor")
            -- Fail-closed deployments get the 503 at once too.
            local closed = conf(PF)
            closed.preflight_quota_breaker_threshold = 3
            closed.preflight_quota_fail_open = false
            assert.is_true(preflight.check(closed, "cust-9", "api_calls"))
            assert.equals(503, K.response._exit.status)
            assert.equals(3, #http_requests)

            -- Cool-down over: one probe. Success closes the breaker.
            now = now + 11
            http_responses = { { status = 200, body = '{"decision":"ALLOW"}' } }
            assert.is_false(preflight.check(c, "cust-9", "api_calls"))
            assert.equals(4, #http_requests)
            http_responses = { { status = 200, body = '{"decision":"ALLOW"}' } }
            preflight.check(c, "cust-10", "api_calls")
            assert.equals(5, #http_requests)
        end)

        it("a failed probe re-opens the breaker", function()
            ngx.shared.aforo_cache = ttl_dict()
            local c = conf(PF)
            c.preflight_quota_breaker_threshold = 2
            c.preflight_quota_breaker_cooldown_s = 10
            http_responses = { { err = "timeout" }, { err = "timeout" } }
            preflight.check(c, "a", "m"); preflight.check(c, "b", "m")
            now = now + 11
            http_responses = { { status = 503 } }
            preflight.check(c, "c", "m")
            assert.equals(3, #http_requests)
            preflight.check(c, "d", "m")
            assert.equals(3, #http_requests, "a failed probe did not re-open the breaker")
        end)

        it("a success resets the failure count", function()
            ngx.shared.aforo_cache = ttl_dict()
            local c = conf(PF)
            c.preflight_quota_breaker_threshold = 2
            http_responses = { { err = "timeout" }, { status = 200, body = '{"decision":"ALLOW"}' },
                               { err = "timeout" }, { status = 200, body = '{"decision":"ALLOW"}' } }
            for _, id in ipairs({ "a", "b", "c", "d" }) do preflight.check(c, id, "m") end
            assert.equals(4, #http_requests)
        end)
    end)

    -- ── G325 / G327: revocation Redis ──────────────────────────────
    describe("revocation Redis (G325, G327)", function()
        local function jwt_access(extra)
            local c = { jwt_validation_enabled = true, jwt_public_key = "PEM" }
            for k, v in pairs(extra or {}) do c[k] = v end
            K.request._h["Authorization"] = "Bearer " .. jwt(aforo_claims())
            handler:access(conf(c))
            return K.response._exit
        end

        it("checks jti and both client keys with pipelined GETs, one round trip, no MGET", function()
            assert.is_nil(jwt_access())
            assert.same({ "pipeline:get,get,get" }, redis_commands)
        end)

        it("still finds a revoked client in the pipelined answer", function()
            redis_store["jti:client:afr_abc"] = "revoked"
            assert.equals("CLIENT_REVOKED", jwt_access().body.error_description)
            assert.same({ "pipeline:get,get,get" }, redis_commands)
        end)

        it("finds a revocation recorded under key_id", function()
            redis_store["jti:client:7d1c1f6e-0000-4000-8000-000000000001"] = "revoked"
            assert.equals("CLIENT_REVOKED", jwt_access().body.error_description)
        end)

        it("works on Redis Cluster / ElastiCache Serverless, where a cross-slot MGET is refused (G327 review)", function()
            redis_cluster = true
            assert.is_nil(jwt_access(), "a cross-slot lookup was answered as Redis unavailable")
            K.response._exit = nil
            K.ctx.shared = {}
            redis_store["jti:blocked:jti-1"] = "1"
            assert.equals("TOKEN_REVOKED", jwt_access().body.error_description)
        end)

        it("an error reply for one key (MOVED on a classic cluster node) fails closed", function()
            redis_reply_override = { ["jti:client:afr_abc"] = { false, "MOVED 1234 10.0.0.2:6379" } }
            local exit = jwt_access()
            assert.equals(503, exit.status)
            assert.equals("REVOCATION_CHECK_UNAVAILABLE", exit.body.error_description)
        end)

        it("a value in an earlier slot still wins over an error reply in a later one", function()
            redis_store["jti:blocked:jti-1"] = "1"
            redis_reply_override = { ["jti:client:afr_abc"] = { false, "MOVED 1234 10.0.0.2:6379" } }
            assert.equals("TOKEN_REVOKED", jwt_access().body.error_description)
        end)

        it("a failed pipeline commit fails closed, and fails open in open mode", function()
            redis_pipeline_err = "timeout"
            assert.equals(503, jwt_access().status)
            K.response._exit = nil
            K.ctx.shared = {}
            assert.is_nil(jwt_access({ jti_redis_fail_mode = "open" }))
        end)

        it("an unexpected reply type fails closed", function()
            redis_reply_override = { ["jti:blocked:jti-1"] = 7 }
            assert.equals(503, jwt_access().status)
        end)

        it("a reply that is neither a value, nil nor an error fails closed", function()
            redis_reply_override = { ["jti:client:7d1c1f6e-0000-4000-8000-000000000001"] = false }
            assert.equals(503, jwt_access().status)
        end)

        it("AUTHs only on a new connection", function()
            jwt_access({ jwt_redis_password = "pw" })
            K.response._exit = nil
            K.ctx.shared = {}
            jwt_access({ jwt_redis_password = "pw" })
            assert.equals(1, #redis_auth_calls)
            assert.same({ "auth", "pipeline:get,get,get", "pipeline:get,get,get" }, redis_commands)
        end)

        it("defaults the revocation timeout to 250 ms, configurable with jwt_redis_timeout_ms", function()
            jwt_access()
            assert.equals(250, redis_timeouts[#redis_timeouts])
            jwt_access({ jwt_redis_timeout_ms = 20 })
            assert.equals(20, redis_timeouts[#redis_timeouts])
        end)

        it("the schema default for jwt_redis_timeout_ms is 250", function()
            local saved = package.loaded["kong.db.schema.typedefs"]
            package.loaded["kong.db.schema.typedefs"] = { no_consumer = {}, protocols_http = {} }
            package.loaded["schema"] = nil
            local schema = require("schema")
            package.loaded["kong.db.schema.typedefs"] = saved
            package.loaded["schema"] = nil
            local f = schema_field(schema, "jwt_redis_timeout_ms")
            assert.equals(250, f.default)
        end)

        it("connects with TLS when jwt_redis_ssl is set, verifying by default", function()
            jwt_access({ jwt_redis_host = "redis.internal", jwt_redis_ssl = true,
                         jwt_redis_server_name = "redis.example" })
            local o = redis_connect_opts[#redis_connect_opts]
            assert.is_true(o.ssl)
            assert.is_true(o.ssl_verify)
            assert.equals("redis.example", o.server_name)
        end)

        it("uses the host as the TLS server name when none is set", function()
            jwt_access({ jwt_redis_host = "redis.internal", jwt_redis_ssl = true })
            assert.equals("redis.internal", redis_connect_opts[#redis_connect_opts].server_name)
        end)

        it("inherits rate_limit_redis_ssl when the blocklist is on the rate-limit Redis", function()
            jwt_access({ rate_limit_redis_host = "redis-a", rate_limit_redis_ssl = true })
            assert.is_true(redis_connect_opts[#redis_connect_opts].ssl)
            jwt_access({ jwt_redis_host = "redis-b", rate_limit_redis_host = "redis-a",
                         rate_limit_redis_ssl = true })
            assert.is_falsy(redis_connect_opts[#redis_connect_opts].ssl)
        end)

        it("does not share a pool between TLS and plain connections", function()
            jwt_access({ jwt_redis_ssl = true })
            jwt_access({})
            local a, b = redis_connect_opts[1].pool, redis_connect_opts[2].pool
            assert.is_not_nil(a)
            assert.are_not.equal(a, b)
        end)

        it("a Redis error reply is never read as not revoked", function()
            redis_error_reply = "LOADING Redis is loading the dataset in memory"
            assert.equals(503, jwt_access().status)
        end)

        it("the rate-limit Redis connects with TLS when rate_limit_redis_ssl is set", function()
            K.client._consumer = { custom_id = "cust-1", username = "acme" }
            K.request._h["Authorization"] = "Bearer sk_live_9"
            handler:access(conf({ rate_limit_enabled = true, rate_limit_redis_ssl = true,
                                  rate_limit_redis_server_name = "rl.example" }))
            local o = redis_connect_opts[#redis_connect_opts]
            assert.is_true(o.ssl)
            assert.is_true(o.ssl_verify)
            assert.equals("rl.example", o.server_name)
        end)
    end)

    -- ── G331 review: margin guard timeout and circuit breaker ─────────
    describe("margin guard timeout and breaker (G331 review)", function()
        local MG = { margin_guard_enabled = true, margin_guard_url = "http://pricing",
                     margin_guard_cache_ttl = 0 }
        local ALLOW = { status = 200, body = '{"verdict":"ALLOW","currentLevel":"NONE"}' }
        local function load_schema()
            local saved = package.loaded["kong.db.schema.typedefs"]
            package.loaded["kong.db.schema.typedefs"] = { no_consumer = {}, protocols_http = {} }
            package.loaded["schema"] = nil
            local schema = require("schema")
            package.loaded["kong.db.schema.typedefs"] = saved
            package.loaded["schema"] = nil
            return schema
        end

        it("defaults the pricing call timeout to 300 ms", function()
            http_responses = { ALLOW }
            margin_guard.check(conf(MG), "tenant-B", nil)
            assert.equals(300, http_timeouts[#http_timeouts])
        end)

        it("takes the timeout from margin_guard_timeout_ms", function()
            http_responses = { ALLOW }
            local c = conf(MG); c.margin_guard_timeout_ms = 1200
            margin_guard.check(c, "tenant-B", nil)
            assert.equals(1200, http_timeouts[#http_timeouts])
        end)

        it("the schema declares margin_guard_timeout_ms (default 300, 10..5000) and breaker settings", function()
            local schema = load_schema()
            local t = schema_field(schema, "margin_guard_timeout_ms")
            assert.equals(300, t.default)
            assert.same({ 10, 5000 }, t.between)
            assert.equals(5, schema_field(schema, "margin_guard_breaker_threshold").default)
            assert.equals(10, schema_field(schema, "margin_guard_breaker_cooldown_s").default)
        end)

        it("opens after consecutive failures, skips pricing and fails open, then probes once", function()
            ngx.shared.aforo_cache = ttl_dict()
            local c = conf(MG)
            c.margin_guard_breaker_threshold = 3
            c.margin_guard_breaker_cooldown_s = 10
            for _ = 1, 3 do
                http_responses = { { err = "timeout" } }
                assert.is_false(margin_guard.check(c, "tenant-B", nil))
            end
            assert.equals(3, #http_requests)
            -- Open: pricing is not called, both scopes skipped, request let through.
            assert.is_false(margin_guard.check(c, "tenant-B", "cust-1"))
            assert.equals(3, #http_requests, "the breaker did not stop the calls")
            -- After the cool-down one request probes; a success closes the breaker.
            local t0 = ngx.now()
            ngx.now = function() return t0 + 11 end
            http_responses = { ALLOW }
            assert.is_false(margin_guard.check(c, "tenant-B", nil))
            assert.equals(4, #http_requests)
            http_responses = { ALLOW, ALLOW }
            margin_guard.check(c, "tenant-B", "cust-1")
            assert.equals(6, #http_requests, "the breaker did not close after a successful probe")
        end)

        it("counts non-200 and unreadable answers as failures", function()
            ngx.shared.aforo_cache = ttl_dict()
            local c = conf(MG)
            c.margin_guard_breaker_threshold = 2
            http_responses = { { status = 503 }, { status = 200, body = "not json" } }
            margin_guard.check(c, "tenant-B", nil)
            margin_guard.check(c, "tenant-B", nil)
            margin_guard.check(c, "tenant-B", nil)
            assert.equals(2, #http_requests)
        end)

        it("a success resets the failure count", function()
            ngx.shared.aforo_cache = ttl_dict()
            local c = conf(MG)
            c.margin_guard_breaker_threshold = 2
            http_responses = { { err = "timeout" }, ALLOW, { err = "timeout" }, ALLOW }
            for _ = 1, 4 do margin_guard.check(c, "tenant-B", nil) end
            assert.equals(4, #http_requests)
        end)

        it("threshold 0 turns the breaker off", function()
            ngx.shared.aforo_cache = ttl_dict()
            local c = conf(MG)
            c.margin_guard_breaker_threshold = 0
            http_responses = { { err = "t" }, { err = "t" }, { err = "t" }, { err = "t" },
                               { err = "t" }, { err = "t" } }
            for _ = 1, 6 do margin_guard.check(c, "tenant-B", nil) end
            assert.equals(6, #http_requests)
        end)

        it("the breaker is per tenant", function()
            ngx.shared.aforo_cache = ttl_dict()
            local c = conf(MG)
            c.margin_guard_breaker_threshold = 1
            http_responses = { { err = "timeout" }, ALLOW }
            margin_guard.check(c, "tenant-B", nil)
            margin_guard.check(c, "tenant-C", nil)
            assert.equals(2, #http_requests)
        end)
    end)

    -- ── G326: audience and issuer ──────────────────────────────────
    describe("JWT audience and issuer (G326)", function()
        local function run(claims, extra)
            local c = conf({ jwt_validation_enabled = true, jwt_public_key = "PEM" })
            for k, v in pairs(extra or {}) do c[k] = v end
            K.request._h["Authorization"] = "Bearer " .. jwt(claims)
            handler:access(c)
            return K.response._exit
        end

        it("rejects a token without aud when jwt_audience is set", function()
            local exit = run(aforo_claims(), { jwt_audience = { "https://api.acme.test" } })
            assert.equals(401, exit.status)
            assert.equals("INVALID_AUDIENCE", exit.body.error_description)
        end)

        it("rejects a token for another audience", function()
            local exit = run(aforo_claims({ aud = "https://other.test" }),
                { jwt_audience = { "https://api.acme.test" } })
            assert.equals("INVALID_AUDIENCE", exit.body.error_description)
        end)

        it("accepts aud as a string or as an array containing a configured audience", function()
            assert.is_nil(run(aforo_claims({ aud = "https://api.acme.test" }),
                { jwt_audience = { "https://api.acme.test" } }))
            K.ctx.shared = {}
            assert.is_nil(run(aforo_claims({ aud = { "x", "https://api.acme.test" } }),
                { jwt_audience = { "a", "https://api.acme.test" } }))
        end)

        it("rejects a non-string aud entry", function()
            local exit = run(aforo_claims({ aud = { 1, {} } }), { jwt_audience = { "1" } })
            assert.equals("INVALID_AUDIENCE", exit.body.error_description)
        end)

        it("refuses tokens when no issuer is configured, unless the check is explicitly disabled", function()
            local exit = run(aforo_claims(), { jwt_issuer = cjson.null })
            assert.equals(500, exit.status)
            assert.equals("ISSUER_NOT_CONFIGURED", exit.body.error_description)
            assert.is_nil(K.ctx.shared.aforo_jwt_claims)

            K.response._exit = nil
            assert.is_nil(run(aforo_claims({ iss = "anyone" }),
                { jwt_issuer = cjson.null, jwt_issuer_check_disabled = true }))
        end)

        it("the schema refuses jwt_validation_enabled without an issuer", function()
            local saved = package.loaded["kong.db.schema.typedefs"]
            package.loaded["kong.db.schema.typedefs"] = { no_consumer = {}, protocols_http = {} }
            package.loaded["schema"] = nil
            local schema = require("schema")
            package.loaded["kong.db.schema.typedefs"] = saved
            local fn
            for _, chk in ipairs(schema.entity_checks) do
                if chk.custom_entity_check then fn = chk.custom_entity_check.fn end
            end
            assert.is_not_nil(fn, "no custom_entity_check for the issuer")
            local ok, err = fn({ config = { jwt_validation_enabled = true, jwt_issuer = ngx.null } })
            assert.is_falsy(ok)
            assert.truthy(tostring(err):find("jwt_issuer", 1, true))
            assert.is_true(fn({ config = { jwt_validation_enabled = true, jwt_issuer = "https://auth.aforo.ai" } }))
            assert.is_true(fn({ config = { jwt_validation_enabled = true, jwt_issuer_check_disabled = true } }))
            assert.is_true(fn({ config = { jwt_validation_enabled = false } }))
        end)
    end)

    -- ── G335: compound-metering is not packaged ────────────────────
    describe("package contents (G335)", function()
        it("ships only modules the plugin loads, and every listed file exists", function()
            local f = assert(io.open("kong-plugin-aforo-metering-2.8.0-1.rockspec", "rb"))
            local src = f:read("*all")
            f:close()
            assert.is_nil(src:find("compound%-metering%.lua"), "compound-metering is still packaged")
            for file in src:gmatch('=%s*"([%w%-]+%.lua)"') do
                local h = io.open(file, "rb")
                assert.is_not_nil(h, "rockspec lists a missing file: " .. file)
                h:close()
            end
            assert.is_nil(io.open("compound-metering.lua", "rb"))
        end)
    end)
end)
