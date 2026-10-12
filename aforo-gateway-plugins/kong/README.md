# kong-plugin-aforo-metering

A Kong Gateway plugin that captures API usage events in Kong's `log` phase and batch-forwards them to Aforo for billing and analytics. Metering runs after the response is sent, so it adds no latency to the request path.

**Version:** 2.1.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

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
luarocks make kong-plugin-aforo-metering-2.1.0-1.rockspec
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
| `product_type` | string | `API` | `productType` sent on every event (trimmed, upper-cased; unknown values passed through). MCP `tools/call` (with `mcp_enabled`) is sent as `MCP_SERVER` when both `toolName` and `agentId` are known, otherwise keeps this value. Events missing the fields their type requires are skipped, not sent (one invalid event fails the whole batch). `AI_AGENT` needs an agent ID and a session ID: set `agent_id`, or have the upstream send them as response headers (`agent_id_header`, `session_id_header`); see [Metering an AI agent](USER_GUIDE.md#metering-an-ai-agent). `GRPC_API`/`GRAPHQL_API`/`WEBSOCKET_API`/`MQTT_BROKER` need fields an HTTP gateway cannot observe, so their events are skipped. |
| `metric_name_pattern` | string | `{method} {path}` | Metric-name template. Variables: `{method}`, `{path}`, `{service}`, `{route}`, `{consumer}`. |
| `quantity_source` | string | `1` | `1` = one unit per request, `response_size` = response body bytes sent to the client (also for chunked and streamed responses), or a literal number. |
| `agent_id` | string | — | `AI_AGENT` only. The agent ID for the service or route this plugin is on. Used when the upstream does not send `agent_id_header`. |
| `agent_id_header` | string | `X-Aforo-Agent-Id` | `AI_AGENT` only. Upstream **response** header carrying the agent ID for one request; wins over `agent_id`. A request header of the same name is never read. `null` disables it. |
| `session_id_header` | string | `X-Aforo-Session-Id` | `AI_AGENT` only. Upstream **response** header carrying the session ID, so several requests can share one session. Without it, each request is its own session. A request header of the same name is never read. `null` disables it. |
| `customer_id_source` | string | `consumer` | Only `consumer` is accepted. A validated JWT `customer_id` claim takes precedence when `jwt_validation_enabled=true`. Request headers / query params are never read. |
| `flush_interval_ms` | integer | `5000` | Max time before a non-empty buffer flushes. Also the wait before retrying after a failed flush. |
| `flush_count` | integer | `50` | Flush immediately once this many events are buffered. |
| `include_metadata` | boolean | `true` | Include request metadata (method, path, status, latency, sizes) in the event. `metadata.endpoint_path` is always sent, because metric mappings and filters use it. |
| `mcp_enabled` | boolean | `false` | Meter MCP JSON-RPC `tools/call` POST bodies as tool invocations: one event per call, also inside a JSON-RPC batch. Bodies up to 1 MB are read. See [Step 7 of the user guide](USER_GUIDE.md#step-7-optional--turn-on-mcp-tool-invocation-metering). |
| `mcp_meter_non_tool_calls` | boolean | `false` | With `mcp_enabled`, also meter JSON-RPC messages that are not `tools/call` (`initialize`, `tools/list`, `ping`, notifications) as plain API calls. Off by default: they are protocol traffic. Requests that are not JSON-RPC are metered either way. |
| `mcp_product_id` | string | — | Aforo product ID for MCP metering (set when `mcp_enabled=true`). |
| `jwt_validation_enabled` | boolean | `false` | Validate an Aforo RS256 JWT in the access phase before metering: `exp`, `iss`, the signature, `tenant_id`, the jti blocklist and client revocation. A token whose `tenant_id` is not this plugin's `tenant_id` is rejected with 401 `TENANT_MISMATCH`. |
| `jwt_issuer` | string | `https://auth.aforo.ai` | Expected `iss` claim. Empty string skips the issuer check. |
| `jwt_jwks_uri` | string | — | The issuer's JWKS URL, e.g. `https://<issuer>/.well-known/jwks.json`. The key is chosen by the token's `kid`. Keys are cached for an hour and refreshed in the background; a token with an unknown `kid` triggers a refetch, at most once every 30 s. Used when `jwt_public_key` is not set. |
| `jwt_public_key` | string | — | PEM RSA public key for offline RS256 verification. Takes precedence over `jwt_jwks_uri`. Stored encrypted. |
| `jwt_allow_unverified_signature` | boolean | `false` | Accept a JWT whose signature cannot be verified (no key configured, or no JWKS key for its `kid`). A signature that fails verification is always rejected. Enable only when signatures are verified before Kong reaches this plugin. |
| `jwt_redis_host` | string | — | Redis host for the jti blocklist. Falls back to `rate_limit_redis_host`. |
| `jwt_redis_port` | integer | — | Redis port for the jti blocklist. Falls back to `rate_limit_redis_port`. |
| `jwt_redis_password` | string | — | Redis password for the jti blocklist. Falls back to `rate_limit_redis_password` when the blocklist is on the same Redis host and port as rate limiting. Stored encrypted. |
| `rate_limit_enabled` | boolean | `false` | Enforce the Aforo rate-limit policy of the caller's API key in the access phase (429 on a HARD breach). The key is the Kong key-auth credential's key, or an API key sent as `Authorization: Bearer <key>`. Requests authenticated with a JWT are not rate limited yet. |
| `rate_limit_redis_host` | string | `127.0.0.1` | Redis host for rate-limit counters and policy cache. |
| `rate_limit_redis_port` | integer | `6379` | Redis port for rate-limit counters. |
| `rate_limit_redis_password` | string | — | Redis password (optional, encrypted). |
| `rate_limit_redis_timeout_ms` | integer | `50` | Redis timeout; fail-open on timeout. |
| `margin_guard_enabled` | boolean | `false` | Before proxying, ask pricing-service whether the tenant (GLOBAL scope) or the customer is margin-blocked or throttled, and answer 429 with `Retry-After` if so. Fails open. Requires `margin_guard_url`. |
| `margin_guard_url` | string | — | Pricing-service base URL, e.g. `http://pricing:8083`. Kong must be able to reach pricing's internal `/internal/v1/margin-guard/quick-check`. Required when `margin_guard_enabled` is true. |
| `margin_guard_cache_ttl` | integer | `30` | How long an ALLOW or BLOCK answer is cached, in seconds. THROTTLE is never cached. `0` disables the cache. |
| `preflight_quota_enabled` | boolean | `false` | Ask the ingestor's `POST /api/v1/quota/check` before proxying (rate limit, prepaid wallet, cumulative quota); 429 on `DENY`. Off by default: it adds a synchronous call per cache miss. |
| `preflight_quota_url` | string | origin of `aforo_endpoint` + `/api/v1/quota/check` | Quota-check endpoint. |
| `preflight_quota_api_key` | string | `api_key` | Key sent as `X-API-Key` on the check. Set when `api_key` is ingest-only: with RBAC enforced the check needs `quotas:read`. Stored encrypted. |
| `preflight_quota_timeout_ms` | integer | `100` | Timeout for the check (it is on the request path). |
| `preflight_quota_cache_ttl_ms` | integer | `1000` | How long an `ALLOW` is cached per tenant/customer/metric. `DENY` is never cached. `0` disables. |
| `preflight_quota_fail_open` | boolean | `true` | On error, timeout or non-200: let the request through (`true`) or answer 503 (`false`). |
| `exclude_paths` | array | `["/health","/ready","/metrics"]` | Paths skipped from metering. An entry matches that path and anything below it: `/health` skips `/health` and `/health/live`, not `/healthcare`. |
| `exclude_status_codes` | array | `[401,403,429]` | Status codes skipped from metering. Separately, a request this plugin refuses itself (JWT 401, rate-limit or margin-guard 429, pre-flight quota 429/503) is never metered, whatever this list says. |

## Walk me through it

Step-by-step from install to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **JWT revocation checks fail open.** With `jwt_validation_enabled=true` the signature is always verified, with the key from `jwt_public_key` or `jwt_jwks_uri` (using `resty.openssl`, which ships with Kong; no extra library). A token that cannot be verified is rejected unless `jwt_allow_unverified_signature=true`. The jti blocklist and client revocation live in Redis: if Redis is unreachable, or answers with an error such as `NOAUTH`, tokens are let through without the revocation check and a warning is logged.
- **No durable buffer.** Events live in the `aforo_buffer` shared dict until they are delivered, in one buffer per destination (`aforo_endpoint` + `tenant_id`), always sent with that destination's current `api_key`. What the ingestor could not take is kept and retried every `flush_interval_ms`: timeouts, 5xx, 408, 429, and events a 202 reports as not stored — up to 10,000 per destination, and together at most three quarters of the dict. A destination the ingestor refuses (401/403/404, or 400 for the whole request) keeps only its newest 1,000 events, none older than 72 hours, and gives up its memory first when others need it. A batch answered 400 or 413 is split in halves so one bad event does not take others with it; an event refused on its own is dropped with the reason logged. On a reload or graceful stop each buffer gets one quick last send, and the new workers pick up what is left; a crash or `kill -9` loses whatever is buffered — this is best-effort metering, not a guaranteed-delivery queue.
- **Rate limiting does not apply to JWT-authenticated requests yet.** Aforo's rate-limit policies are keyed by API key, and a JWT carries only the key's id, so these requests pass without a rate-limit check. The plugin logs this once.
- **Rate-limit, margin-guard and pre-flight quota enforcement need Redis / pricing-service / the ingestor reachable.** All fail open: a timeout or an unreachable dependency lets the request through rather than blocking it (the quota check can be made fail-closed with `preflight_quota_fail_open=false`).
