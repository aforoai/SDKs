-- Configuration schema for the Aforo Metering plugin.
-- Defines all configurable settings that the admin can adjust via
-- Kong Admin API or declarative configuration.

local typedefs = require "kong.db.schema.typedefs"

return {
    name = "aforo-metering",
    fields = {
        { consumer = typedefs.no_consumer },
        { protocols = typedefs.protocols_http },
        {
            config = {
                type = "record",
                fields = {
                    -- Aforo ingestor endpoint
                    {
                        aforo_endpoint = {
                            type = "string",
                            required = true,
                            description = "Aforo usage ingestor batch endpoint URL",
                        },
                    },
                    -- Authentication
                    {
                        api_key = {
                            type = "string",
                            required = true,
                            encrypted = true,
                            description = "Aforo API key for authenticating to the ingestor",
                        },
                    },
                    {
                        tenant_id = {
                            type = "string",
                            required = true,
                            description = "Aforo tenant identifier",
                        },
                    },
                    -- Product type
                    --
                    -- Kong refuses a field description longer than 500
                    -- characters, and the whole plugin then fails to load
                    -- ("length must be at most 500"). Keep these short; the
                    -- detail belongs in README.md.
                    {
                        product_type = {
                            type = "string",
                            default = "API",
                            description = "Aforo productType sent on every event (trimmed, upper-cased): API, AGENTIC_API, AI_AGENT, MCP_SERVER, GRPC_API, GRAPHQL_API, WEBSOCKET_API or MQTT_BROKER. MCP tools/call is sent as MCP_SERVER; on an MCP_SERVER product only tool calls are metered. Events missing their type's required fields are skipped, as one invalid event fails the whole batch. AI_AGENT takes agentId from agent_id_header or agent_id. gRPC/GraphQL/WebSocket detection (grpc_enabled etc.) sets its own type.",
                        },
                    },
                    -- Metric configuration
                    {
                        metric_name_pattern = {
                            type = "string",
                            default = "{method} {path}",
                            description = "DEPRECATED. Template for metric name: {method}, {path}, {service}, {route}, {consumer}. Produces one metric per endpoint, which Aforo rejects unless every endpoint is registered in the catalog as its own metric. Prefer metric_mappings. Honoured only when set to something other than the default.",
                        },
                    },
                    {
                        metric_mappings = {
                            type = "array",
                            required = false,
                            description = "Ordered endpoint-to-metric rules; first match wins, so put specific rules before general ones. path_pattern is a Lua pattern matched against the request path (anchor with ^). method is optional and matches any verb when omitted. Example: {path_pattern='^/api/sms', metric_name='sms_sent'}.",
                            elements = {
                                type = "record",
                                fields = {
                                    { path_pattern = { type = "string", required = true } },
                                    { method = { type = "string", required = false } },
                                    { metric_name = { type = "string", required = true } },
                                },
                            },
                        },
                    },
                    {
                        mappings_url = {
                            type = "string",
                            description = "Aforo catalog gateway-mappings endpoint, e.g. https://catalog.aforo.ai/internal/v1/metrics/gateway-mappings. When set, endpoint-to-metric rules are fetched from Aforo and refreshed in the background, so adding a metric needs no gateway change. Falls back to metric_mappings then default_metric when unset or unreachable. Leave empty to disable.",
                        },
                    },
                    {
                        mappings_refresh_seconds = {
                            type = "number",
                            default = 300,
                            description = "How often to refresh central mappings. Only used until the first successful response; after that the TTL the API returns wins, so cadence is tuned centrally rather than per gateway.",
                        },
                    },
                    {
                        mappings_timeout_ms = {
                            type = "number",
                            default = 3000,
                            description = "Timeout for the background mappings fetch. Never on the request path -- a slow catalog delays a refresh, it does not delay traffic.",
                        },
                    },
                    {
                        default_metric = {
                            type = "string",
                            default = "api_calls",
                            description = "Metric used when no mapping matches. Must exist in the Aforo catalog. Keeps an unmapped endpoint billing as generic usage instead of being rejected, so adding an endpoint is not a billing outage.",
                        },
                    },
                    {
                        metric_header = {
                            type = "string",
                            default = "X-Aforo-Metric",
                            description = "Upstream RESPONSE header that overrides the metric for a single request. For cases only the backend knows, e.g. one endpoint serving several billable actions. Read from the response, so clients cannot forge it. Set to null to disable.",
                        },
                    },
                    {
                        quantity_header = {
                            type = "string",
                            default = "X-Aforo-Quantity",
                            description = "Upstream RESPONSE header supplying the quantity for a single request. Needed for metrics whose value only the backend knows -- call_minutes, tokens, bytes processed -- which a gateway cannot observe. Ignored unless it parses to a positive number. Set to null to disable.",
                        },
                    },
                    {
                        quantity_source = {
                            type = "string",
                            default = "1",
                            description = "Quantity source: '1' (count), 'response_size' (response body bytes sent to the client, also for chunked and streamed responses), or a number",
                        },
                    },
                    -- AI_AGENT identity (product_type=AI_AGENT only).
                    -- Aforo requires agentId and sessionId on every AI_AGENT
                    -- event. Both come from operator config or the upstream
                    -- RESPONSE, never from a request header: X-Agent-Id and
                    -- friends are client-settable, so a caller could choose
                    -- which agent its usage is attributed to.
                    {
                        agent_id = {
                            type = "string",
                            description = "Agent ID for AI_AGENT events on the service/route this plugin is attached to. Operator config, so trusted. Used when the upstream does not send agent_id_header; without either, the Kong service's id is the agent. Not used for MCP tool calls, whose agent is the caller.",
                        },
                    },
                    {
                        agent_id_header = {
                            type = "string",
                            default = "X-Aforo-Agent-Id",
                            description = "Upstream RESPONSE header carrying the agent ID for a single AI_AGENT request (wins over agent_id) or MCP tool call (wins over the verified customer). Read from the response, so clients cannot forge it. Set to null to disable.",
                        },
                    },
                    {
                        session_id_header = {
                            type = "string",
                            default = "X-Aforo-Session-Id",
                            description = "Upstream RESPONSE header carrying the session ID for an AI_AGENT request or MCP tool call, so several requests can share one session. Without it, an AI_AGENT request is its own session (Kong's request ID) and an MCP call uses the upstream's Mcp-Session-Id response header. Set to null to disable.",
                        },
                    },
                    -- AGENTIC_API trace (product_type=AGENTIC_API only). Aforo
                    -- groups a trace's events into one goal, so the trace is
                    -- billing identity: from the upstream RESPONSE, never the
                    -- client's traceparent.
                    {
                        trace_id_header = {
                            type = "string",
                            default = "X-Aforo-Trace-Id",
                            description = "Upstream RESPONSE header naming the trace (goal) an AGENTIC_API request belongs to, so several requests can be one goal. Without it, each request is its own trace (Kong's request ID). The client's traceparent is never used as the trace. Set to null to disable.",
                        },
                    },
                    {
                        customer_id_source = {
                            type = "string",
                            default = "consumer",
                            -- "header" and "query_param" were REMOVED 2026-04-23.
                            -- Both read client-settable values and enabled billing
                            -- attribution spoofing (IDOR advisory findings #8 #9).
                            -- The only accepted source is Kong's native consumer
                            -- identity, which is bound to the verified credential.
                            -- When a JWT is validated (jwt_validation_enabled=true),
                            -- the JWT's customer_id claim takes precedence over
                            -- the consumer source — see handler.lua.
                            one_of = { "consumer" },
                            description = "Kong consumer identity (custom_id, else username, else id). The only accepted value. A verified JWT takes precedence when configured: customer_id_jwt_claim (JWT verified by Kong's jwt plugin; exclusive), else jwt_validation_enabled (JWT verified by this plugin). No identity, no event.",
                        },
                    },
                    {
                        customer_id_jwt_claim = {
                            type = "string",
                            required = false,
                            len_min = 1,
                            description = "Claim of the Kong-verified JWT to use as customerId (e.g. 'tenant_id'). Requires Kong's jwt plugin on the same route or service.",
                        },
                    },
                    {
                        customer_id_jwt_exclude_claims = {
                            type = "array",
                            elements = { type = "string", len_min = 1 },
                            default = {},
                            description = "With customer_id_jwt_claim: a verified token carrying any of these claims (present and not false/empty) is not metered. Example: staff impersonation tokens.",
                        },
                    },
                    -- Batching
                    {
                        flush_interval_ms = {
                            type = "integer",
                            default = 5000,
                            gt = 0,
                            description = "How often to flush batched events (milliseconds)",
                        },
                    },
                    {
                        flush_count = {
                            type = "integer",
                            default = 50,
                            gt = 0,
                            description = "Flush when this many events are buffered",
                        },
                    },
                    -- Metadata
                    {
                        include_metadata = {
                            type = "boolean",
                            default = true,
                            description = "Whether to include request metadata (method, path, status, latency)",
                        },
                    },
                    -- MCP Server detection
                    {
                        mcp_enabled = {
                            type = "boolean",
                            default = false,
                            description = "Meter MCP JSON-RPC tools/call requests as tool invocations (one event per call, also in a JSON-RPC batch). Bodies up to 1 MB are read. Always on when product_type is MCP_SERVER.",
                        },
                    },
                    {
                        mcp_meter_non_tool_calls = {
                            type = "boolean",
                            default = false,
                            description = "With mcp_enabled: also meter JSON-RPC messages that are not tools/call (initialize, tools/list, ping, notifications), as plain API calls. Off by default: they are protocol traffic, not usage. Requests that are not JSON-RPC are always metered.",
                        },
                    },
                    {
                        mcp_product_id = {
                            type = "string",
                            description = "Aforo product ID for MCP server metering (required when mcp_enabled=true)",
                        },
                    },
                    -- gRPC / GraphQL / WebSocket detection (opt-in, each off by default)
                    {
                        grpc_enabled = {
                            type = "boolean",
                            default = false,
                            description = "Enable gRPC detection (via Content-Type: application/grpc) for per-method billing",
                        },
                    },
                    {
                        grpc_product_id = {
                            type = "string",
                            description = "Aforo product ID for gRPC metering (required when grpc_enabled=true)",
                        },
                    },
                    {
                        grpc_path_prefix = {
                            type = "string",
                            -- No default: Kong rejects "" as a string default
                            -- ("length must be at least 1"). Unset = no prefix.
                            description = "Optional Kong route prefix to strip before parsing gRPC service/method. Leave empty if gRPC is routed at /. Example: '/grpc' for paths like /grpc/acme.UserService/GetUser",
                        },
                    },
                    {
                        graphql_enabled = {
                            type = "boolean",
                            default = false,
                            description = "Enable GraphQL detection (HTTP POST with application/json containing {query}) for per-operation billing",
                        },
                    },
                    {
                        graphql_product_id = {
                            type = "string",
                            description = "Aforo product ID for GraphQL metering (required when graphql_enabled=true)",
                        },
                    },
                    {
                        graphql_path_pattern = {
                            type = "string",
                            default = "graphql",
                            description = "Substring required in the request path to consider an HTTP POST a GraphQL operation. Default: 'graphql' (also matches 'gql').",
                        },
                    },
                    {
                        websocket_enabled = {
                            type = "boolean",
                            default = false,
                            description = "Enable WebSocket detection. Emits one CONNECTION_OPENED event per successful 101 handshake. Frame-level metering requires @aforo/ws-metering SDK.",
                        },
                    },
                    {
                        websocket_product_id = {
                            type = "string",
                            description = "Aforo product ID for WebSocket metering (required when websocket_enabled=true)",
                        },
                    },
                    -- executionStatus overrides (OUTCOME_BASED pricing): an
                    -- exact upstream status code -> one of the ingestor's
                    -- execution statuses. Wins over the default table (README
                    -- "Execution status"). org-service writes this map.
                    {
                        status_outcomes = {
                            type = "map",
                            required = false,
                            keys = { type = "string", match = "^[2-5]%d%d$" },
                            values = {
                                type = "string",
                                one_of = {
                                    "SUCCESS", "PARTIAL", "TIMEOUT", "ERROR",
                                    "VALIDATION_FAILED", "FAILED", "FAILURE",
                                    "CANCELLED", "PENDING", "BLOCKED", "HITL_REQUIRED",
                                },
                            },
                            description = "Per-status-code executionStatus overrides, e.g. {\"404\": \"VALIDATION_FAILED\"}. Keys are exact HTTP codes 200-599. Without an entry: 2xx/3xx SUCCESS, 408/504 TIMEOUT, 499 CANCELLED, 400/422 VALIDATION_FAILED, 401/403/429 BLOCKED, other 4xx/5xx ERROR.",
                        },
                    },
                    -- ── JWT Validation ──
                    -- Enable to validate Aforo RS256 JWTs before metering.
                    -- Checks: expiry, issuer, RS256 signature, tenant_id (must
                    -- equal this plugin's tenant_id), jti blocklist, client
                    -- revocation. The signature is verified with resty.openssl,
                    -- which ships with Kong; no extra library is needed. The key
                    -- comes from jwt_public_key, else from jwt_jwks_uri.
                    {
                        jwt_validation_enabled = {
                            type = "boolean",
                            default = false,
                            description = "Verify the Aforo RS256 JWT in the access phase (signature against the key from jwt_jwks_uri or jwt_public_key, exp, nbf, iss, revocation) and answer 401 when it fails. Its customer_id claim then identifies the customer.",
                        },
                    },
                    {
                        jwt_issuer = {
                            type = "string",
                            default = "https://auth.aforo.ai",
                            description = "Expected JWT issuer (iss claim). Leave empty to skip issuer check.",
                        },
                    },
                    {
                        jwt_jwks_uri = {
                            type = "string",
                            description = "https URL of the token issuer's JWKS (organization-service: /.well-known/jwks.json). The RS256 key is chosen by the token's kid, so a key rotation needs no config change. Cached per worker for jwt_jwks_cache_ttl seconds; an unknown kid refreshes it at most every 30 s; the last good set is used for up to 24 h while the JWKS cannot be fetched. jwt_public_key, when also set, verifies tokens the JWKS has no key for.",
                        },
                    },
                    {
                        jwt_jwks_cache_ttl = {
                            type = "integer",
                            default = 600,
                            between = { 30, 86400 },
                            description = "Seconds a fetched JWKS is used before it is fetched again.",
                        },
                    },
                    {
                        jwt_public_key = {
                            type = "string",
                            encrypted = true,
                            description = "PEM-encoded RSA PUBLIC key of the token issuer. With jwt_validation_enabled the plugin verifies the RS256 signature against it (resty.openssl) before reading any claim -- for tokens jwt_jwks_uri has no key for, when both are set. A private key is refused.",
                        },
                    },
                    {
                        jwt_allow_unverified_signature = {
                            type = "boolean",
                            default = false,
                            description = "DANGEROUS. Let a JWT through when this plugin cannot verify its signature (no jwt_public_key and no jwt_jwks_uri). For deployments that verify the token before it reaches this plugin. Since 2.2.0 such a token grants ACCESS only: its claims are not used for customerId or keyId unless Kong's jwt plugin verified the same token. With this true and nothing verifying upstream, any caller can mint a token.",
                        },
                    },
                    -- Redis host/port/password are shared with rate-limit enforcement
                    -- below. jwt_validation uses rate_limit_redis_host / _port /
                    -- _password unless the jwt_redis_* settings say otherwise. Set
                    -- them only if the jti blocklist Redis is not the rate-limit one.
                    {
                        jwt_redis_host = {
                            type = "string",
                            description = "Redis host for jti blocklist (defaults to rate_limit_redis_host if not set)",
                        },
                    },
                    {
                        jwt_redis_port = {
                            type = "integer",
                            description = "Redis port for jti blocklist (defaults to rate_limit_redis_port if not set)",
                        },
                    },
                    {
                        jwt_redis_password = {
                            type = "string",
                            encrypted = true,
                            description = "Redis password for the jti blocklist. Defaults to rate_limit_redis_password when the blocklist uses the same Redis host and port as rate limiting.",
                        },
                    },
                    {
                        jti_redis_fail_mode = {
                            type = "string",
                            default = "closed",
                            one_of = { "closed", "open" },
                            description = "What the jti blocklist and client-revocation checks do when Redis cannot answer (connect or GET fails). closed (default): refuse the request with 503. open: let it through, log a throttled warning and count it in aforo_metering_revocation_check_unavailable_total. Before 2.4.0 the behaviour was always open.",
                        },
                    },
                    -- Rate limit enforcement (reads policies from Redis)
                    {
                        rate_limit_enabled = {
                            type = "boolean",
                            default = false,
                            description = "Enable rate limit enforcement in the access phase",
                        },
                    },
                    {
                        rate_limit_redis_host = {
                            type = "string",
                            default = "127.0.0.1",
                            description = "Redis host for rate limit counters and policy cache",
                        },
                    },
                    {
                        rate_limit_redis_port = {
                            type = "integer",
                            default = 6379,
                            description = "Redis port for rate limit counters",
                        },
                    },
                    {
                        rate_limit_redis_password = {
                            type = "string",
                            encrypted = true,
                            description = "Redis password (optional)",
                        },
                    },
                    {
                        rate_limit_redis_timeout_ms = {
                            type = "integer",
                            default = 50,
                            description = "Redis timeout in milliseconds (fail-open on timeout)",
                        },
                    },
                    -- Margin guard pre-flight check (calls pricing-service quick-check)
                    {
                        margin_guard_enabled = {
                            type = "boolean",
                            default = false,
                            description = "Ask pricing-service before proxying whether the tenant (GLOBAL scope) or the customer is margin-blocked or throttled, and answer 429 if so. Fails open. Requires margin_guard_url.",
                        },
                    },
                    {
                        margin_guard_url = {
                            type = "string",
                            description = "Pricing-service base URL for the margin guard quick-check, e.g. http://pricing:8083. Kong must reach pricing's internal API (/internal/v1/margin-guard/quick-check, no auth). Required when margin_guard_enabled is true.",
                        },
                    },
                    {
                        margin_guard_cache_ttl = {
                            type = "integer",
                            default = 30,
                            description = "How long an ALLOW or BLOCK answer is cached per tenant and scope, in seconds. THROTTLE is never cached. 0 disables the cache.",
                        },
                    },
                    -- Pre-flight quota check (calls the ingestor's /api/v1/quota/check)
                    {
                        preflight_quota_enabled = {
                            type = "boolean",
                            default = false,
                            description = "Ask Aforo before proxying whether the customer is within quota (rate limit, prepaid wallet, cumulative quota) for the metric the request will be billed to, and answer 429 on DENY. Requests that will not be billed (e.g. MCP initialize) are not checked. Adds a synchronous call on every request that misses the local cache, so it is off by default.",
                        },
                    },
                    {
                        preflight_quota_url = {
                            type = "string",
                            description = "Quota-check endpoint. Defaults to aforo_endpoint's scheme and host plus /api/v1/quota/check, since the check lives on the same ingestor.",
                        },
                    },
                    {
                        preflight_quota_api_key = {
                            type = "string",
                            encrypted = true,
                            description = "API key for the quota check, sent as X-API-Key. Defaults to api_key. Set it only when the ingestor does not accept api_key for /api/v1/quota/check.",
                        },
                    },
                    {
                        preflight_quota_timeout_ms = {
                            type = "integer",
                            default = 300,
                            gt = 0,
                            description = "Timeout for the quota check, in ms. This is on the request path (only on a cache miss); on timeout the request proceeds (see preflight_quota_fail_open). 300 allows for Kong-to-Aforo over the internet.",
                        },
                    },
                    {
                        preflight_quota_cache_ttl_ms = {
                            type = "integer",
                            default = 1000,
                            between = { 0, 60000 },
                            description = "How long an ALLOW or WARN is cached per tenant/customer/metric. DENY is never cached, so a top-up unblocks immediately. 0 disables the cache.",
                        },
                    },
                    {
                        preflight_quota_fail_open = {
                            type = "boolean",
                            default = true,
                            description = "When the quota check errors, times out or answers non-200, let the request through (true) or refuse it with 503 (false).",
                        },
                    },
                    -- Exclusions
                    {
                        exclude_paths = {
                            type = "array",
                            elements = { type = "string" },
                            default = { "/health", "/ready", "/metrics" },
                            description = "Paths to exclude from metering. An entry matches that path and anything below it: /health excludes /health and /health/live, not /healthcare.",
                        },
                    },
                    {
                        exclude_status_codes = {
                            type = "array",
                            elements = { type = "integer" },
                            default = { 401, 403, 429 },
                            description = "HTTP status codes to exclude from metering",
                        },
                    },
                },
            },
        },
    },
    entity_checks = {
        -- Without a URL the margin guard has nothing to ask; this used to be
        -- accepted and then raise on every request (a 500).
        { conditional = {
            if_field = "config.margin_guard_enabled", if_match = { eq = true },
            then_field = "config.margin_guard_url", then_match = { required = true },
        } },
    },
}
