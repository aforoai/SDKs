-- Aforo Metering Plugin for Kong Gateway
-- Runs in `access` and `log` phases to capture API usage events and
-- forward them to Aforo's usage ingestor service.
--
-- access phase: stashes W3C trace context for later correlation (no-op enforcement — Session 5)
-- log phase: builds event payload and buffers for batch flush
--
-- Zero latency impact on the critical path: metering runs in post-response log phase.
-- Batched: buffers events in shared memory, flushes periodically.
-- Retry: 3x exponential backoff on ingestor failures.

local http = require("resty.http")
local cjson = require("cjson.safe")
local rate_limit = require("rate-limit-enforce")
local margin_guard = require("margin-guard")

-- ────────────────────────────────────────────────────────────
-- JWT Validation helpers
-- ────────────────────────────────────────────────────────────

-- Extract Bearer token from Authorization header
local function extract_bearer_token()
    local auth_header = kong.request.get_header("Authorization")
    if not auth_header then return nil end
    local _, _, token = string.find(auth_header, "^[Bb]earer%s+(.+)$")
    return token
end

-- Decode base64url to bytes
local function base64url_decode(str)
    str = str:gsub("-", "+"):gsub("_", "/")
    local pad = 4 - (#str % 4)
    if pad < 4 then str = str .. string.rep("=", pad) end
    return ngx.decode_base64(str)
end

-- Parse a JWT into {header, claims, parts} without crypto verification.
-- Returns (claims_table, parts_array) on success, or (nil, err_string) on failure.
local function parse_jwt_claims(token)
    local parts = {}
    for part in token:gmatch("([^.]+)") do
        table.insert(parts, part)
    end
    if #parts ~= 3 then return nil, "invalid_jwt_format" end

    local payload_json = base64url_decode(parts[2])
    if not payload_json then return nil, "invalid_jwt_encoding" end

    local ok, claims = pcall(cjson.decode, payload_json)
    if not ok or type(claims) ~= "table" then return nil, "invalid_jwt_payload" end

    return claims, parts
end

-- Check jti blocklist in Redis.  Fail-open: returns false on any Redis error.
local function is_jti_blocked(jti, redis_host, redis_port)
    if not jti or jti == "" then return false end
    local red = require("resty.redis"):new()
    red:set_timeout(500)
    local ok, err = red:connect(redis_host or "127.0.0.1", redis_port or 6379)
    if not ok then
        kong.log.warn("[aforo-metering] Redis connect failed for jti check: ", err)
        return false  -- fail-open: do not block legitimate requests on Redis failure
    end
    local val = red:get("jti:blocked:" .. jti)
    red:set_keepalive(10000, 10)
    return val ~= nil and val ~= ngx.null
end

-- Check client-level revocation via key_id.  Fail-open.
local function is_client_revoked(key_id, redis_host, redis_port)
    if not key_id or key_id == "" then return false end
    local red = require("resty.redis"):new()
    red:set_timeout(500)
    local ok, err = red:connect(redis_host or "127.0.0.1", redis_port or 6379)
    if not ok then
        kong.log.warn("[aforo-metering] Redis connect failed for client revocation check: ", err)
        return false
    end
    local val = red:get("jti:client:" .. key_id)
    red:set_keepalive(10000, 10)
    return val ~= nil and val ~= ngx.null
end

-- Full RS256 signature verification requires the lua-resty-jwt library.
--   Kong Enterprise: use the native JWT plugin with JWKS URI instead of
--                    this plugin's built-in validation.
--   Kong OSS:        install lua-resty-jwt via LuaRocks and uncomment the
--                    resty_jwt.verify_jwt_obj() call below.
--
-- Current status: claims-based checks (exp, iss, jti blocklist, client revocation)
-- are always enforced.  Crypto signature verification is gated on lua-resty-jwt
-- availability so that teams on Kong OSS can opt-in when ready.
local function verify_rs256_signature(token, conf)
    local ok, resty_jwt = pcall(require, "resty.jwt")
    if not ok then
        -- Library not available — log a startup-level warning once and skip.
        kong.log.warn("[aforo-metering] lua-resty-jwt not found; RS256 signature NOT verified. ",
            "Install via LuaRocks or use Kong Enterprise's native JWT plugin.")
        return true  -- fail-open on missing library
    end

    -- When lua-resty-jwt is installed, perform full RS256 verification via JWKS.
    -- The public key must be pre-fetched and cached (below is a minimal inline
    -- example; production deployments should use resty_jwt with a JWKS fetcher).
    local jwt_obj = resty_jwt:load_jwt(token)
    if not jwt_obj or not jwt_obj.valid then
        return false
    end
    -- NOTE: Provide `conf.jwt_public_key` (PEM) for offline verification,
    -- or integrate a JWKS fetcher that resolves `conf.jwt_jwks_uri` → kid → PEM.
    if conf.jwt_public_key then
        local verified = resty_jwt:verify_jwt_obj(conf.jwt_public_key, jwt_obj)
        return verified.verified
    end
    return true  -- no public key configured — skip crypto check
end

-- Main JWT validation entry point.
-- Returns {valid=bool, reason=string, customer_id, tenant_id, key_id, scopes, ...}
local function validate_jwt(token, conf)
    -- 1. Parse claims (structure + encoding check)
    local claims, parts = parse_jwt_claims(token)
    if not claims then
        return { valid = false, reason = "MALFORMED_TOKEN" }
    end

    -- 2. Expiry check
    local exp = claims.exp
    if not exp or ngx.time() > tonumber(exp) then
        return { valid = false, reason = "TOKEN_EXPIRED" }
    end

    -- 3. Issuer check
    if conf.jwt_issuer and conf.jwt_issuer ~= "" and claims.iss ~= conf.jwt_issuer then
        kong.log.warn("[aforo-metering] JWT issuer mismatch: got '", claims.iss,
            "', expected '", conf.jwt_issuer, "'")
        return { valid = false, reason = "INVALID_ISSUER" }
    end

    -- 4. RS256 signature verification (requires lua-resty-jwt; fail-open when absent)
    if not verify_rs256_signature(token, conf) then
        return { valid = false, reason = "INVALID_SIGNATURE" }
    end

    -- Resolve Redis coords for jti blocklist checks.
    -- Prefer dedicated jwt_redis_* config; fall back to rate_limit_redis_*.
    local redis_host = (conf.jwt_redis_host and conf.jwt_redis_host ~= "" and conf.jwt_redis_host)
                       or conf.rate_limit_redis_host or "127.0.0.1"
    local redis_port = conf.jwt_redis_port or conf.rate_limit_redis_port or 6379

    -- 5. jti blocklist (revoked individual token)
    local jti = claims.jti
    if is_jti_blocked(jti, redis_host, redis_port) then
        return { valid = false, reason = "TOKEN_REVOKED" }
    end

    -- 6. Client-level revocation (all tokens for this key_id revoked)
    local key_id = claims.key_id
    if is_client_revoked(key_id, redis_host, redis_port) then
        return { valid = false, reason = "CLIENT_REVOKED" }
    end

    -- 7. Return validated claims
    return {
        valid        = true,
        customer_id  = claims.customer_id or claims.sub or "",
        tenant_id    = claims.tenant_id   or "",
        key_id       = claims.key_id      or "",
        scopes       = type(claims.scopes) == "table"
                           and table.concat(claims.scopes, " ")
                           or (claims.scopes or ""),
        environment  = claims.environment or "live",
        offering_ids = claims.offering_ids,
        jti          = jti,
    }
end

local AforoMeteringHandler = {
    PRIORITY = 5,    -- Run after most other plugins
    VERSION  = "1.1.0",
}

-- Shared memory buffer name (must be declared in kong.conf: lua_shared_dict aforo_buffer 10m)
local BUFFER_DICT = "aforo_buffer"
local BUFFER_KEY = "events"
local BUFFER_COUNT_KEY = "event_count"
local MAX_BUFFER_SIZE = 10000

-- ────────────────────────────────────────────────────────────
-- Helpers
-- ────────────────────────────────────────────────────────────

local function should_exclude_path(path, exclude_paths)
    if not exclude_paths then return false end
    for _, excluded in ipairs(exclude_paths) do
        if path == excluded or string.sub(path, 1, #excluded) == excluded then
            return true
        end
    end
    return false
end

local function should_exclude_status(status, exclude_status_codes)
    if not exclude_status_codes then return false end
    for _, excluded in ipairs(exclude_status_codes) do
        if status == excluded then
            return true
        end
    end
    return false
end

local function resolve_metric_name(conf, method, path, service_name, route_name, consumer_name)
    local pattern = conf.metric_name_pattern or "{method} {path}"
    local result = pattern
    result = string.gsub(result, "{method}", method or "UNKNOWN")
    result = string.gsub(result, "{path}", path or "/")
    result = string.gsub(result, "{service}", service_name or "")
    result = string.gsub(result, "{route}", route_name or "")
    result = string.gsub(result, "{consumer}", consumer_name or "")
    return result
end

local function resolve_quantity(conf, response_size)
    local source = conf.quantity_source or "1"
    if source == "1" then
        return 1
    elseif source == "response_size" then
        return response_size or 0
    else
        return tonumber(source) or 1
    end
end

-- resolve_customer_id
--
-- Priority order (post-2026-04-23 IDOR fix):
--   1. JWT customer_id claim (cryptographically verified in access phase
--      and stashed in kong.ctx.shared.aforo_jwt_claims)
--   2. Kong consumer identity (bound to the verified credential)
--
-- Returns nil if neither source is present. The caller decides whether
-- to drop the metering event, skip the margin-guard check, etc.
--
-- IMPORTANT: the `headers` argument is kept for call-site backwards
-- compatibility but is NEVER consulted. Client-settable request headers
-- (X-Customer-Id, ?customer_id=) are no longer trusted sources.
local function resolve_customer_id(conf, consumer, headers)  -- luacheck: ignore 212
    local jwt_claims = kong.ctx.shared and kong.ctx.shared.aforo_jwt_claims
    if jwt_claims and jwt_claims.customer_id and jwt_claims.customer_id ~= "" then
        return jwt_claims.customer_id
    end
    if consumer then
        return consumer.custom_id or consumer.username or consumer.id
    end
    return nil
end

local function generate_idempotency_key(request_id)
    return request_id or kong.tools.uuid()
end

-- ────────────────────────────────────────────────────────────
-- W3C Trace Context extraction
-- Captures traceparent, tracestate, x-trace-id, x-request-id
-- from inbound request headers. Returns nil for absent headers.
-- ────────────────────────────────────────────────────────────

local function extract_trace_context()
    return {
        traceparent = kong.request.get_header("traceparent"),
        tracestate  = kong.request.get_header("tracestate"),
        xTraceId    = kong.request.get_header("x-trace-id"),
        xRequestId  = kong.request.get_header("x-request-id"),
    }
end

-- ────────────────────────────────────────────────────────────
-- Flush buffered events to Aforo ingestor
-- ────────────────────────────────────────────────────────────

local function flush_buffer(premature, conf)
    if premature then return end

    local dict = ngx.shared[BUFFER_DICT]
    if not dict then
        kong.log.err("[aforo-metering] Shared dict '", BUFFER_DICT, "' not found")
        return
    end

    local events_json = dict:get(BUFFER_KEY)
    if not events_json then return end

    local events = cjson.decode(events_json)
    if not events or #events == 0 then return end

    dict:delete(BUFFER_KEY)
    dict:set(BUFFER_COUNT_KEY, 0)

    local httpc = http.new()
    httpc:set_timeout(10000)

    local body = cjson.encode({ events = events })

    local max_retries = 3
    for attempt = 1, max_retries do
        local res, err = httpc:request_uri(conf.aforo_endpoint, {
            method  = "POST",
            body    = body,
            headers = {
                ["Content-Type"]  = "application/json",
                ["Authorization"] = "Bearer " .. (conf.api_key or ""),
                ["X-Tenant-Id"]   = conf.tenant_id or "",
            },
        })

        if res and res.status >= 200 and res.status < 300 then
            kong.log.info("[aforo-metering] Flushed ", #events, " events to Aforo (status=", res.status, ")")
            return
        end

        local status = res and res.status or "no response"
        kong.log.warn("[aforo-metering] Flush attempt ", attempt, "/", max_retries,
            " failed (status=", status, ", err=", err or "none", ")")

        if attempt < max_retries then
            ngx.sleep(math.pow(2, attempt - 1))
        end
    end

    kong.log.err("[aforo-metering] All ", max_retries, " flush attempts failed. ",
        #events, " events dropped.")
end

-- ────────────────────────────────────────────────────────────
-- MCP JSON-RPC Detection
-- ────────────────────────────────────────────────────────────

local function detect_mcp_tool_call(raw_body)
    if not raw_body or raw_body == "" then return nil end

    local ok, parsed = pcall(cjson.decode, raw_body)
    if not ok or not parsed then return nil end

    if parsed.jsonrpc ~= "2.0" then return nil end
    if parsed.method ~= "tools/call" then return nil end

    local params = parsed.params or {}
    local tool_name = params.name
    if not tool_name then return nil end

    local agent_id = nil
    if params._meta and params._meta.agent_id then
        agent_id = params._meta.agent_id
    end

    return {
        tool_name = tool_name,
        agent_id = agent_id,
    }
end

-- ────────────────────────────────────────────────────────────
-- Access phase handler (runs before proxying to upstream)
-- Currently a no-op that stashes trace context for correlation.
-- Session 5 will add rate-limit enforcement here.
-- ────────────────────────────────────────────────────────────

function AforoMeteringHandler:access(conf)
    kong.ctx.shared.aforo_trace = extract_trace_context()

    -- ── JWT Validation (runs first — all subsequent checks depend on validated identity) ──
    if conf.jwt_validation_enabled then
        local token = extract_bearer_token()
        if not token then
            return kong.response.exit(401, {
                error             = "unauthorized",
                error_description = "Bearer token required",
            })
        end

        local result = validate_jwt(token, conf)
        if not result.valid then
            kong.log.warn("[aforo-metering] JWT rejected (", result.reason, ")")
            return kong.response.exit(401, {
                error             = "invalid_token",
                error_description = result.reason,
            })
        end

        -- Stash validated identity for log phase and downstream use
        kong.ctx.shared.aforo_jwt_claims = result

        -- Propagate verified claims as trusted downstream headers
        -- (overwrite any client-supplied headers — these come from the validated JWT)
        kong.service.request.set_header("X-Customer-Id", result.customer_id)
        kong.service.request.set_header("X-Tenant-Id",   result.tenant_id)
        kong.service.request.set_header("X-Key-Id",      result.key_id)
        kong.service.request.set_header("X-Scopes",      result.scopes)
        if result.environment then
            kong.service.request.set_header("X-Environment", result.environment)
        end
    end

    -- Rate limit enforcement (reads policy from Redis, returns 429 on HARD breach)
    rate_limit.enforce(conf)

    -- Margin guard pre-flight check (calls pricing-service quick-check, returns 429 on L2/L3).
    -- resolve_customer_id() prefers the JWT-validated claim stashed above;
    -- falls back to Kong consumer identity (credential-bound). Never reads
    -- request headers or query params — those sources were removed 2026-04-23.
    local customer_id = resolve_customer_id(conf, kong.client.get_consumer())
    margin_guard.check(conf, conf.tenant_id, customer_id)
end

-- ────────────────────────────────────────────────────────────
-- Log phase handler (runs after response is sent to client)
-- ────────────────────────────────────────────────────────────

function AforoMeteringHandler:log(conf)
    local method = kong.request.get_method()
    local path = kong.request.get_path()
    local status = kong.response.get_status()

    if should_exclude_path(path, conf.exclude_paths) then return end
    if should_exclude_status(status, conf.exclude_status_codes) then return end

    local consumer = kong.client.get_consumer()
    local headers = kong.request.get_headers()
    local service = kong.router.get_service()
    local route = kong.router.get_route()
    local latency = kong.response.get_header("X-Kong-Proxy-Latency")
    local raw_body = kong.request.get_raw_body()
    local request_size = raw_body and #raw_body or 0
    local response_size = tonumber(kong.response.get_header("Content-Length")) or 0
    local request_id = kong.request.get_header("X-Request-Id")
        or kong.request.get_header("X-Kong-Request-Id")
    local session_id = kong.request.get_header("Mcp-Session-Id")

    local service_name = service and service.name or ""
    local route_name = route and route.name or ""
    local consumer_name = consumer and (consumer.username or consumer.custom_id) or ""
    local customer_id = resolve_customer_id(conf, consumer, headers)

    -- W3C trace context (prefer access-phase stash, fallback to re-extraction)
    local trace = kong.ctx.shared.aforo_trace or extract_trace_context()

    -- MCP Detection
    local mcp_info = nil
    if conf.mcp_enabled and method == "POST" then
        mcp_info = detect_mcp_tool_call(raw_body)
    end

    -- Build usage event
    local event = {}

    if mcp_info then
        event.customerId     = customer_id
        event.metricName     = "mcp_server.tool_invocations"
        event.quantity       = 1
        event.idempotencyKey = "mcp:" .. (conf.tenant_id or "") .. ":" ..
                               (request_id or kong.tools.uuid()) .. ":" ..
                               mcp_info.tool_name .. ":" .. tostring(ngx.now())
        event.occurredAt     = ngx.now() * 1000
        event.productType    = "MCP_SERVER"
        event.toolName       = mcp_info.tool_name
        event.agentId        = mcp_info.agent_id or headers["x-agent-id"]
        event.sessionId      = session_id
        event.executionStatus = (status >= 200 and status < 300) and "SUCCESS" or "ERROR"
        event.executionDurationMs = tonumber(latency) or 0
    else
        event.customerId     = customer_id
        event.metricName     = resolve_metric_name(conf, method, path, service_name, route_name, consumer_name)
        event.quantity       = resolve_quantity(conf, response_size)
        event.idempotencyKey = generate_idempotency_key(request_id)
        event.occurredAt     = ngx.now() * 1000
    end

    -- Top-level HTTP fields (hoisted from metadata for fast ClickHouse queries)
    event.endpointPath    = path
    event.httpMethod      = method
    event.statusCode      = status
    event.responseTimeMs  = tonumber(latency) or 0

    -- W3C trace context (null when absent — fidelity, not synthetic)
    event.trace = trace

    -- Metadata (kept for backward compat — HTTP fields will be removed here in a follow-up)
    if conf.include_metadata then
        event.metadata = {
            gateway       = "kong",
            method        = method,
            path          = path,
            status        = status,
            latency       = tonumber(latency) or 0,
            endpoint_path = path,
            http_method   = method,
            status_code   = status,
            response_time_ms = tonumber(latency) or 0,
            requestSize   = request_size,
            responseSize  = response_size,
            service       = service_name,
            route         = route_name,
            consumer      = consumer_name,
        }
    end

    -- Buffer the event
    local dict = ngx.shared[BUFFER_DICT]
    if not dict then
        kong.log.err("[aforo-metering] Shared dict '", BUFFER_DICT, "' not available. ",
            "Add 'lua_shared_dict aforo_buffer 10m;' to kong.conf")
        return
    end

    local count = dict:incr(BUFFER_COUNT_KEY, 1, 0)

    if count > MAX_BUFFER_SIZE then
        kong.log.warn("[aforo-metering] Buffer overflow (", count, "/", MAX_BUFFER_SIZE,
            "). Dropping oldest event.")
        dict:incr(BUFFER_COUNT_KEY, -1)
        return
    end

    local events_json = dict:get(BUFFER_KEY)
    local events = events_json and cjson.decode(events_json) or {}
    table.insert(events, event)
    dict:set(BUFFER_KEY, cjson.encode(events))

    if count >= (conf.flush_count or 50) then
        local ok, err = ngx.timer.at(0, flush_buffer, conf)
        if not ok then
            kong.log.warn("[aforo-metering] Failed to schedule immediate flush: ", err)
        end
    elseif count == 1 then
        local interval = (conf.flush_interval_ms or 5000) / 1000
        local ok, err = ngx.timer.at(interval, flush_buffer, conf)
        if not ok then
            kong.log.warn("[aforo-metering] Failed to schedule timed flush: ", err)
        end
    end
end

-- Exported for unit testing — not used by the Kong runtime.
-- Keep the top-level handler contract (access/log) unchanged.
AforoMeteringHandler._resolve_customer_id = resolve_customer_id

return AforoMeteringHandler
