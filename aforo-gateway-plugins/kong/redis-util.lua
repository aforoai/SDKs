-- Redis connections for the rate-limit check and the token revocation check.
--
-- One connect function so both checks open, authenticate and pool their
-- connections the same way (2.8.0, G325 / G327):
--   * TLS when asked (ssl = true), with the certificate verified by default
--     against lua_ssl_trusted_certificate and server_name (SNI) set to the
--     configured name, else the host. ssl_verify = false is an explicit
--     opt-out and is logged once per worker.
--   * Connections are pooled per host, port, TLS settings and password, so a
--     pooled connection is never handed to a configuration that would not
--     have opened it (another password, or plain instead of TLS).
--   * AUTH only on a new connection. A pooled connection has already
--     authenticated (get_reused_times() > 0). An AUTH failure closes the
--     connection.
--
-- Errors are returned, never raised: callers decide whether a Redis problem
-- fails open (rate limiting) or closed (revocation, by default).

local M = {}

local insecure_warned = {}

local function non_empty(v)
    if type(v) == "string" and v ~= "" then return v end
    return nil
end

-- params: host, port, password, timeout_ms, ssl, ssl_verify (default true),
-- server_name. Returns red, or (nil, err) with err starting "connect:" or
-- "AUTH failed:".
function M.connect(params)
    local host = params.host or "127.0.0.1"
    local port = params.port or 6379
    local password = non_empty(params.password)
    local ssl = params.ssl == true
    local ssl_verify = params.ssl_verify ~= false
    local server_name = non_empty(params.server_name) or host

    local red = require("resty.redis"):new()
    red:set_timeout(params.timeout_ms or 50)

    local pool = "aforo-redis:" .. host .. ":" .. tostring(port)
        .. (ssl and (":tls:" .. (ssl_verify and "verify" or "noverify") .. ":" .. server_name) or ":plain")
        .. ":" .. (password and ngx.md5(password) or "-")
    local opts = { pool = pool }
    if ssl then
        opts.ssl = true
        opts.ssl_verify = ssl_verify
        opts.server_name = server_name
        if not ssl_verify and not insecure_warned[pool] then
            insecure_warned[pool] = true
            kong.log.warn("[aforo-metering] Redis ", host, ":", port, " uses TLS WITHOUT certificate ",
                "verification (ssl_verify=false): the connection is encrypted but the server is not ",
                "authenticated. Logged once per worker.")
        end
    end

    local ok, err = red:connect(host, port, opts)
    if not ok then
        return nil, "connect: " .. tostring(err)
    end

    if password then
        local reused = 0
        if red.get_reused_times then
            reused = red:get_reused_times() or 0
        end
        if reused == 0 then
            local auth_ok, auth_err = red:auth(password)
            if not auth_ok then
                if red.close then pcall(red.close, red) end
                return nil, "AUTH failed: " .. tostring(auth_err)
            end
        end
    end
    return red
end

-- A connection in a known-good state goes back to the pool.
function M.release(red)
    if red then
        local ok, err = red:set_keepalive(10000, 100)
        if not ok and kong and kong.log then
            kong.log.debug("[aforo-metering] Redis set_keepalive failed: ", tostring(err))
        end
    end
end

-- A connection whose state is unknown (error mid-command) is closed, not pooled.
function M.discard(red)
    if red and red.close then
        pcall(red.close, red)
    end
end

return M
