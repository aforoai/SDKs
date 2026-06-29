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
                    -- Metric configuration
                    {
                        metric_name_pattern = {
                            type = "string",
                            default = "{method} {path}",
                            description = "Template for metric name. Variables: {method}, {path}, {service}, {route}, {consumer}",
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
                            description = "Customer ID source. Only Kong consumer identity is accepted (JWT claim takes precedence when JWT validation is enabled).",
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
                    -- ── JWT Validation ──
                    -- Enable to validate Aforo RS256 JWTs before metering.
                    -- Checks: expiry, issuer, jti blocklist, client revocation.
                    -- Signature verification requires lua-resty-jwt (Kong OSS) or
                    -- the native JWT plugin with JWKS URI (Kong Enterprise).
                    {
                        jwt_validation_enabled = {
                            type = "boolean",
                            default = false,
                            description = "Validate Aforo JWT in the access phase before metering",
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
                            description = "Aforo JWKS URI for RS256 public key resolution (e.g. https://auth.smartai.com/.well-known/jwks.json). Used when lua-resty-jwt is installed.",
                        },
                    },
                    {
                        jwt_public_key = {
                            type = "string",
                            encrypted = true,
                            description = "PEM-encoded RSA public key for offline RS256 verification. Alternative to jwt_jwks_uri for static key setups.",
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
