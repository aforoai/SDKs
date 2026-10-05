# kong-plugin-aforo-metering

A Kong Gateway plugin that captures API usage events in Kong's `log` phase and batch-forwards them to Aforo for billing and analytics. Metering runs after the response is sent, so it adds no latency to the request path.

**Version:** 2.2.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

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
luarocks make kong-plugin-aforo-metering-2.2.0-1.rockspec
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
  --data "config.aforo_endpoint=https://api.aforo.ai/v1/ingest/batch" \
  --data "config.api_key=$AFORO_API_KEY" \
  --data "config.tenant_id=$AFORO_TENANT_ID"
```

Declarative config (`kong.yml`) equivalent:

```yaml
plugins:
  - name: aforo-metering
    service: my-service
    config:
      aforo_endpoint: https://api.aforo.ai/v1/ingest/batch
      api_key: ${AFORO_API_KEY}
      tenant_id: ${AFORO_TENANT_ID}
```

Send a request through Kong, then check the proxy logs for `[aforo-metering] Flushed N events to Aforo (status=2xx)`.

## Configuration

Every option lives under `config.*`. `aforo_endpoint`, `api_key`, and `tenant_id` are required; the rest have defaults.

| Option | Type | Default | What it does |
|--------|------|---------|--------------|
| `aforo_endpoint` | string | — (required) | Aforo ingestor batch URL. Use `https://api.aforo.ai/v1/ingest/batch`. |
| `api_key` | string | — (required) | Aforo API key, scoped `usage:ingest`. Sent as `X-API-Key` on the flush — never as `Authorization: Bearer`, which the ingestor rejects with 401. Stored encrypted. |
| `tenant_id` | string | — (required) | Aforo tenant identifier. Sent as the `X-Tenant-Id` header on the flush. |
| `product_type` | string | `API` | `productType` sent on every event (trimmed, upper-cased; unknown values passed through). MCP `tools/call` (with `mcp_enabled`) is sent as `MCP_SERVER` when both `toolName` and `agentId` are known, otherwise keeps this value. Events missing the fields their type requires are skipped, not sent (one invalid event fails the whole batch): `AI_AGENT`/`GRPC_API`/`GRAPHQL_API`/`WEBSOCKET_API`/`MQTT_BROKER` need fields an HTTP gateway cannot observe or trust (an agentId from `X-Agent-Id` would be client-settable), so use them only where every event is otherwise supplied. |
| `default_metric` | string | `api_calls` | Metric used when nothing below matches. Must exist in your Aforo catalog. |
| `metric_mappings` | array | — | Ordered `{path_pattern, method?, metric_name}` rules; first match wins. `path_pattern` is a Lua pattern (anchor with `^`). |
| `mappings_url` | string | — | Aforo catalog gateway-mappings endpoint. When set, EXACT / PREFIX / CONTAINS rules are fetched in a background timer and cached; a failed refresh keeps the last table. |
| `mappings_refresh_seconds` | number | `300` | Refresh interval until the endpoint returns its own `cacheTtlSeconds`. |
| `mappings_timeout_ms` | number | `3000` | Timeout of the background fetch. Never on the request path. |
| `metric_header` | string | `X-Aforo-Metric` | Upstream **response** header that names the metric for one request. Empty disables. |
| `quantity_header` | string | `X-Aforo-Quantity` | Upstream **response** header that supplies the quantity for one request. Empty disables. |
| `metric_name_pattern` | string | `{method} {path}` | Fixed metric name or template (`{method}`, `{path}`, `{service}`, `{route}`, `{consumer}`). Used only when set to something other than the default; the default produces one metric per endpoint, which the ingestor refuses. |
| `quantity_source` | string | `1` | `1` = one unit per request, `response_size` = response bytes, or a literal number. |
| `customer_id_source` | string | `consumer` | Only `consumer` is accepted. See [Customer identity](#customer-identity). Request headers / query params are never read. |
| `customer_id_jwt_claim` | string | — | Claim of the JWT that Kong's `jwt` plugin verified, used as `customerId`. When set it is the only identity source. |
| `customer_id_jwt_exclude_claims` | array | `[]` | With `customer_id_jwt_claim`: a token carrying any of these claims is not metered (e.g. staff impersonation). |
| `status_outcomes` | map | — | Exact status code → `executionStatus` override, e.g. `{"404": "VALIDATION_FAILED"}`. |
| `grpc_enabled` / `graphql_enabled` / `websocket_enabled` | boolean | `false` | Detect gRPC calls, GraphQL operations and WebSocket handshakes and send them with their own product type and fields. |
| `flush_interval_ms` | integer | `5000` | Max time before a non-empty buffer flushes. |
| `flush_count` | integer | `50` | Flush immediately once this many events are buffered. |
| `include_metadata` | boolean | `true` | Include request metadata (method, path, status, latency, sizes) in the event. |
| `mcp_enabled` | boolean | `false` | Detect MCP JSON-RPC `tools/call` POST bodies and emit `mcp_server.tool_invocations` events. |
| `mcp_product_id` | string | — | Aforo product ID for MCP metering (set when `mcp_enabled=true`). |
| `jwt_validation_enabled` | boolean | `false` | Verify an Aforo RS256 JWT in the access phase: signature against `jwt_public_key`, then `exp`, `nbf`, `iss`, jti blocklist, client revocation. 401 on failure. |
| `jwt_issuer` | string | `https://auth.aforo.ai` | Expected `iss` claim. Empty string skips the issuer check. |
| `jwt_jwks_uri` | string | — | Accepted, not used: no JWKS fetch is implemented. Set `jwt_public_key`. |
| `jwt_public_key` | string | — | PEM RSA **public** key of the issuer. Required for in-plugin verification; a private key is refused. Stored encrypted. |
| `jwt_allow_unverified_signature` | boolean | `false` | Let a token through when the plugin cannot verify it (no `jwt_public_key`). Access only: such a token supplies no `customerId`. |
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
| `preflight_quota_enabled` | boolean | `false` | Ask the ingestor's `POST /api/v1/quota/check` before proxying (rate limit, prepaid wallet, cumulative quota); 429 on `DENY`. Off by default: it adds a synchronous call per cache miss. |
| `preflight_quota_url` | string | origin of `aforo_endpoint` + `/api/v1/quota/check` | Quota-check endpoint. |
| `preflight_quota_api_key` | string | `api_key` | Key sent as `X-API-Key` on the check. Set when `api_key` is ingest-only: with RBAC enforced the check needs `quotas:read`. Stored encrypted. |
| `preflight_quota_timeout_ms` | integer | `100` | Timeout for the check (it is on the request path). |
| `preflight_quota_cache_ttl_ms` | integer | `1000` | How long an `ALLOW` is cached per tenant/customer/metric. `DENY` is never cached. `0` disables. |
| `preflight_quota_fail_open` | boolean | `true` | On error, timeout or non-200: let the request through (`true`) or answer 503 (`false`). |
| `exclude_paths` | array | `["/health","/ready","/metrics"]` | Paths skipped from metering (prefix match). |
| `exclude_status_codes` | array | `[401,403,429]` | Status codes skipped from metering. |

## Customer identity

Every event needs a `customerId`. The plugin takes it from one of three sources, chosen by configuration. A request with none produces no event.

| You have | Configure | `customerId` is |
|---|---|---|
| Kong consumers (key-auth, basic-auth, …) | nothing | the consumer's `custom_id`, else `username`, else `id` |
| Kong's `jwt` plugin on the route, one issuer for all callers | `customer_id_jwt_claim: <claim>` | that claim of the token Kong verified. The consumer is not used: on a `jwt` route it is the issuer, shared by every caller. |
| Aforo-issued JWTs and no Kong auth plugin | `jwt_validation_enabled: true` + `jwt_public_key` | the `customer_id` (else `sub`) claim of the token this plugin verified; the consumer when the token names none |

When both JWT options are set, `customer_id_jwt_claim` decides. A claim is used only from a token whose signature was verified on this gateway; an id longer than 64 characters is not used.

## Dropped events

Counters live in the `aforo_buffer` shared dict under `aforo_dropped:<reason>` and, when Kong's `prometheus` plugin is loaded, in `aforo_metering_dropped_events_total{reason}`.

| Reason | Meaning |
|---|---|
| `buffer_overflow` | More than 10,000 events buffered (ingestor unreachable); newest dropped. |
| `rejected` | The ingestor refused a whole batch with a 4xx other than 408/429. |
| `ingestor_rejected` | The ingestor accepted the batch and refused individual events, e.g. a metric name that is not in your catalog. |
| `invalid_metric` | Resolved metric name blank or longer than 255 characters. |
| `missing_fields` | The event's product type requires fields the request did not supply. |

## Walk me through it

Step-by-step from install to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **No JWKS fetch.** In-plugin verification reads one PEM public key from `jwt_public_key`. For rotating keys, verify tokens with Kong's `jwt` plugin and set `customer_id_jwt_claim`.
- **An unknown metric name is only detected by the ingestor.** The plugin cannot see your catalog. Those events come back refused in the batch response and are counted as `ingestor_rejected`; they are not retried.
- **No durable buffer.** Events live in the `aforo_buffer` shared dict until flush. A batch that fails transiently (5xx, timeout, 408, 429) is put back and retried on a later flush; a batch the ingestor rejects with any other 4xx is dropped with the reason logged. Past 10,000 buffered events the newest are dropped, and a Kong restart loses whatever is buffered — this is best-effort metering, not a guaranteed-delivery queue.
- **Rate-limit, margin-guard and pre-flight quota enforcement need Redis / pricing-service / the ingestor reachable.** All fail open: a timeout or an unreachable dependency lets the request through rather than blocking it (the quota check can be made fail-closed with `preflight_quota_fail_open=false`).
