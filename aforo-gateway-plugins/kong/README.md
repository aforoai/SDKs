# kong-plugin-aforo-metering

A Kong Gateway plugin that captures API usage events in Kong's `log` phase and batch-forwards them to Aforo for billing and analytics. Metering runs after the response is sent, so it adds no latency to the request path.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

When you already run Kong and want usage events flowing to Aforo without touching your upstream, install this as a custom plugin and enable it on a service or route.

Intended public install (once published):

```bash
luarocks install kong-plugin-aforo-metering
```

> **Not yet on the public LuaRocks registry — install from source for now.** The rockspec is already in this repo; build and pack it locally.

From source:

```bash
# 1. Clone the distribution repo and enter the plugin folder
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/kong

# 2. Install the runtime dependency (HTTP client used by the log-phase flush)
luarocks install lua-resty-http

# 3. Build + install the plugin from the rockspec in this folder
luarocks make kong-plugin-aforo-metering-2.0.0-1.rockspec
```

Then tell Kong to load it and reserve the shared-memory buffer the log phase writes to. In `kong.conf`:

```
plugins = bundled,aforo-metering
nginx_http_lua_shared_dict = aforo_buffer 10m
```

> ⚠ The `lua_shared_dict aforo_buffer 10m` line is mandatory. Without it the log phase logs `Shared dict 'aforo_buffer' not available` and drops every event. The directive name in `kong.conf` is `nginx_http_lua_shared_dict`; in a raw nginx template it is `lua_shared_dict aforo_buffer 10m;`.

Reload Kong: `kong reload`.

## Quickstart

Enable the plugin on a service via the Admin API with the three values every Aforo artifact needs — `aforo_endpoint`, `api_key`, `tenant_id`:

```bash
curl -X POST http://localhost:8001/services/my-service/plugins \
  --data "name=aforo-metering" \
  --data "config.aforo_endpoint=https://ingest.aforo.ai/v1/ingest/batch" \
  --data "config.api_key=$AFORO_API_KEY" \
  --data "config.tenant_id=$AFORO_TENANT_ID"
```

Declarative config (`kong.yml`) equivalent:

```yaml
plugins:
  - name: aforo-metering
    service: my-service
    config:
      aforo_endpoint: https://ingest.aforo.ai/v1/ingest/batch
      api_key: ${AFORO_API_KEY}
      tenant_id: ${AFORO_TENANT_ID}
```

Send a request through Kong, then check the proxy logs for `[aforo-metering] Flushed N events to Aforo (status=2xx)`.

## Configuration

Every option lives under `config.*`. `aforo_endpoint`, `api_key`, and `tenant_id` are required; the rest have defaults.

| Option | Type | Default | What it does |
|--------|------|---------|--------------|
| `aforo_endpoint` | string | — (required) | Aforo ingestor batch URL. Use `https://ingest.aforo.ai/v1/ingest/batch`. |
| `api_key` | string | — (required) | Aforo API key. Sent as `Authorization: Bearer <api_key>` on the flush. Stored encrypted. |
| `tenant_id` | string | — (required) | Aforo tenant identifier. Sent as the `X-Tenant-Id` header on the flush. |
| `metric_name_pattern` | string | `{method} {path}` | Metric-name template. Variables: `{method}`, `{path}`, `{service}`, `{route}`, `{consumer}`. |
| `quantity_source` | string | `1` | `1` = one unit per request, `response_size` = response bytes, or a literal number. |
| `customer_id_source` | string | `consumer` | Only `consumer` is accepted. A validated JWT `customer_id` claim takes precedence when `jwt_validation_enabled=true`. Request headers / query params are never read. |
| `flush_interval_ms` | integer | `5000` | Max time before a non-empty buffer flushes. |
| `flush_count` | integer | `50` | Flush immediately once this many events are buffered. |
| `include_metadata` | boolean | `true` | Include request metadata (method, path, status, latency, sizes) in the event. |
| `mcp_enabled` | boolean | `false` | Detect MCP JSON-RPC `tools/call` POST bodies and emit `mcp_server.tool_invocations` events. |
| `mcp_product_id` | string | — | Aforo product ID for MCP metering (set when `mcp_enabled=true`). |
| `jwt_validation_enabled` | boolean | `false` | Validate an Aforo RS256 JWT in the access phase before metering (exp, iss, jti blocklist, client revocation). |
| `jwt_issuer` | string | `https://auth.aforo.ai` | Expected `iss` claim. Empty string skips the issuer check. |
| `jwt_jwks_uri` | string | — | JWKS URI for RS256 key resolution (used when `lua-resty-jwt` is installed). |
| `jwt_public_key` | string | — | PEM RSA public key for offline RS256 verification. Stored encrypted. |
| `jwt_redis_host` | string | — | Redis host for the jti blocklist. Falls back to `rate_limit_redis_host`. |
| `jwt_redis_port` | integer | — | Redis port for the jti blocklist. Falls back to `rate_limit_redis_port`. |
| `rate_limit_enabled` | boolean | `false` | Enforce rate limits in the access phase (returns 429 on a HARD breach). |
| `rate_limit_redis_host` | string | `127.0.0.1` | Redis host for rate-limit counters and policy cache. |
| `rate_limit_redis_port` | integer | `6379` | Redis port for rate-limit counters. |
| `rate_limit_redis_password` | string | — | Redis password (optional, encrypted). |
| `rate_limit_redis_timeout_ms` | integer | `50` | Redis timeout; fail-open on timeout. |
| `margin_guard_enabled` | boolean | `false` | Run a pricing-service margin-guard quick-check in the access phase (429 on L2/L3). |
| `margin_guard_url` | string | — | Pricing-service base URL for the margin-guard check. |
| `margin_guard_cache_ttl` | integer | `30` | Cache TTL (seconds) for margin-guard decisions. |
| `exclude_paths` | array | `["/health","/ready","/metrics"]` | Paths skipped from metering (prefix match). |
| `exclude_status_codes` | array | `[401,403,429]` | Status codes skipped from metering. |

## Walk me through it

Step-by-step from install to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Crypto signature verification is opt-in.** With `jwt_validation_enabled=true`, the plugin always enforces `exp`, `iss`, the jti blocklist, and client revocation, but full RS256 signature verification requires `lua-resty-jwt` (Kong OSS) or Kong Enterprise's native JWT plugin with a JWKS URI. When `lua-resty-jwt` is absent the plugin logs a warning and skips the signature check (claims checks still run). On Kong Enterprise, prefer the native JWT plugin and leave `jwt_validation_enabled=false` here.
- **No durable buffer.** Events live in the `aforo_buffer` shared dict until flush. A Kong worker restart, or three consecutive failed flush attempts, drops the buffered events — this is fire-and-forget metering, not a guaranteed-delivery queue.
- **Rate-limit and margin-guard enforcement need Redis / pricing-service reachable.** Both fail open: a Redis timeout or unreachable pricing-service lets the request through rather than blocking it.
