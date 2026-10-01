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
                    {
                        product_type = {
                            type = "string",
                            default = "API",
                            description = "productType sent on plain HTTP events (trimmed, upper-cased; default API). "
                                .. "Protocol events set their own: MCP tools/call is MCP_SERVER when toolName and agentId are known, "
                                .. "gRPC / GraphQL / WebSocket detection set GRPC_API / GRAPHQL_API / WEBSOCKET_API, and a request "
                                .. "carrying a trace id is AGENTIC_API. The ingestor requires the field. An event missing the fields "
                                .. "its type requires (e.g. AI_AGENT needs agentId + sessionId, which an HTTP gateway cannot observe) "
                                .. "is skipped and counted, not sent.",
                        },
                    },
                    -- Metric configuration
                    {
                        metric_name_pattern = {
                            type = "string",
                            default = "{method} {path}",
                            description = "Fixed metric name or template ({method}, {path}, {service}, {route}, {consumer}). Used only when set to something other than the default \"{method} {path}\": the default would produce one metric per endpoint, which the ingestor refuses unless each is a catalog metric. Resolution order: metric_header response header, mappings_url, metric_mappings, metric_name_pattern, default_metric.",
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
                            description = "Upstream RESPONSE header that overrides the metric for a single request. For cases only the backend knows, e.g. one endpoint serving several billable actions. Read from the response, so clients cannot forge it. Set empty to disable.",
                        },
                    },
                    {
                        quantity_header = {
                            type = "string",
                            default = "X-Aforo-Quantity",
                            description = "Upstream RESPONSE header supplying the quantity for a single request. Needed for metrics whose value only the backend knows -- call_minutes, tokens, bytes processed -- which a gateway cannot observe. Ignored unless it parses to a positive number. Set empty to disable.",
                        },
                    },
                    {
                        quantity_source = {
                            type = "string",
                            default = "1",
                            description = "Quantity source: '1' (count), 'response_size' (bytes), or a number",
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
                    -- Customer id from a JWT that Kong's bundled `jwt` plugin
                    -- already verified on the same route/service. The claim is
                    -- read from kong.ctx.shared.authenticated_jwt_token, which
                    -- that plugin sets only after the signature check passes;
                    -- the Authorization header is never parsed directly. When
                    -- set, this is the only source: the Kong consumer on a jwt
                    -- route is the token issuer, not the caller. No verified
                    -- token, or no such claim -> the request is not metered.
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
                            description = "Enable MCP JSON-RPC detection for tool call metering",
                        },
                    },
                    {
                        mcp_product_id = {
                            type = "string",
                            description = "Aforo product ID for MCP server metering (required when mcp_enabled=true)",
                        },
                    },
                    -- executionStatus overrides (OUTCOME_BASED pricing).
                    -- Exact upstream status code -> canonical outcome. Wins
                    -- over the default table (README "Execution status
                    -- mapping"). Also applies to gRPC, which maps each
                    -- grpc-status to an equivalent HTTP code first
                    -- (UNAUTHENTICATED=401, PERMISSION_DENIED=403,
                    -- RESOURCE_EXHAUSTED=429, ...). Example:
                    --   { ["404"] = "VALIDATION_FAILED", ["429"] = "ERROR" }
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
                            description = "Per-status-code executionStatus overrides, e.g. {\"404\": \"VALIDATION_FAILED\"}. Keys are exact HTTP codes 200-599.",
                        },
                    },
                    -- gRPC detection
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
                    -- GraphQL detection
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
                    -- WebSocket detection
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
                    -- ── JWT Validation ──
                    -- Enable to validate Aforo RS256 JWTs before metering.
                    -- Checks: expiry, issuer, jti blocklist, client revocation.
                    -- Signature verification requires lua-resty-jwt (Kong OSS) or
                    -- the native JWT plugin with JWKS URI (Kong Enterprise).
                    {
                        jwt_validation_enabled = {
                            type = "boolean",
                            default = false,
                            description = "Verify the Aforo RS256 JWT in the access phase (signature against jwt_public_key, exp, nbf, iss, revocation) and answer 401 when it fails. Its customer_id claim then identifies the customer.",
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
                            description = "Accepted for compatibility; NOT used. No JWKS fetch is implemented, so a JWKS-only configuration verifies nothing and tokens are rejected. Set jwt_public_key, or verify tokens with Kong's jwt plugin and set customer_id_jwt_claim.",
                        },
                    },
                    {
                        jwt_public_key = {
                            type = "string",
                            encrypted = true,
                            description = "PEM-encoded RSA PUBLIC key of the token issuer. With jwt_validation_enabled the plugin verifies the RS256 signature against it (resty.openssl) before reading any claim. A private key is refused.",
                        },
                    },
                    {
                        jwt_allow_unverified_signature = {
                            type = "boolean",
                            default = false,
                            description = "DANGEROUS. Let a JWT through when this plugin cannot verify its signature (no jwt_public_key). For deployments that verify the token before it reaches this plugin. Since 2.2.0 such a token grants ACCESS only: its claims are not used for customerId or keyId unless Kong's jwt plugin verified the same token. With this true and nothing verifying upstream, any caller can mint a token.",
                        },
                    },
                    -- Redis host/port are shared with rate-limit enforcement above.
                    -- jwt_validation uses rate_limit_redis_host / rate_limit_redis_port.
                    -- Add dedicated jwt_redis_host/jwt_redis_port below only if the
                    -- jti blocklist Redis is on a different host than rate-limit Redis.
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
                            description = "Enable margin guard pre-flight check in the access phase",
                        },
                    },
                    {
                        margin_guard_url = {
                            type = "string",
                            description = "Pricing-service base URL for margin guard quick-check (e.g. http://pricing:8083)",
                        },
                    },
                    {
                        margin_guard_cache_ttl = {
                            type = "integer",
                            default = 30,
                            description = "Cache TTL in seconds for margin guard decisions (default 30s)",
                        },
                    },
                    -- Pre-flight quota check (calls the ingestor's /api/v1/quota/check)
                    {
                        preflight_quota_enabled = {
                            type = "boolean",
                            default = false,
                            description = "Ask Aforo before proxying whether the customer is within quota (rate limit, prepaid wallet, cumulative quota) and answer 429 on DENY. Adds a synchronous call on every request that misses the local cache, so it is off by default.",
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
                            description = "API key for the quota check, sent as X-API-Key. Defaults to api_key. Set it when api_key is an ingest-only key: with RBAC enforced the check needs quotas:read.",
                        },
                    },
                    {
                        preflight_quota_timeout_ms = {
                            type = "integer",
                            default = 100,
                            gt = 0,
                            description = "Timeout for the quota check. This is on the request path; on timeout the request proceeds (see preflight_quota_fail_open).",
                        },
                    },
                    {
                        preflight_quota_cache_ttl_ms = {
                            type = "integer",
                            default = 1000,
                            between = { 0, 60000 },
                            description = "How long an ALLOW is cached per tenant/customer/metric. DENY is never cached, so a top-up unblocks immediately. 0 disables the cache.",
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
                            description = "Paths to exclude from metering",
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
}
