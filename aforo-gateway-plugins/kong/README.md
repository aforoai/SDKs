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

## Minimal config per product type

Your upstream needs no Aforo code for `API` and `MCP_SERVER`. Each end customer is a Kong consumer whose `custom_id` is their Aforo customer id, behind `key-auth` (or a validated JWT); that is who is billed. Every example below also sets `aforo_endpoint`, `api_key` and `tenant_id`.

| `product_type` | Minimal config | What each event carries |
|---|---|---|
| `API` | `default_metric` (or `metric_mappings`) naming a catalog metric | one event per call, quantity 1 |
| `AI_AGENT` | `default_metric`; `agent_id` recommended | `agentId` = `X-Aforo-Agent-Id` response header, else `agent_id`, else the Kong service's id. `sessionId` = `X-Aforo-Session-Id` response header, else one session per request. Quantity = `X-Aforo-Quantity` (e.g. tokens), else 1 |
| `AGENTIC_API` | `default_metric` | `traceId` (the goal) = `X-Aforo-Trace-Id` response header, else one goal per request |
| `MCP_SERVER` | `default_metric` = the tool-call metric | one event per JSON-RPC `tools/call` (also inside a batch); `initialize`, `tools/list`, `ping` and notifications are not billed. `agentId` = `X-Aforo-Agent-Id` response header, else the customer. `sessionId` = `X-Aforo-Session-Id`, else the `Mcp-Session-Id` the upstream answered with |

`mcp_enabled` is implied by `MCP_SERVER`. On an `MCP_SERVER` product, tool calls bill to `default_metric` unless it is still `api_calls`, in which case they bill to `mcp_server.tool_invocations`.

### Upstream response headers

All are **optional** and read from the upstream's **response** only; a request header of the same name is never read, so a client cannot set any of them. None is required for any product type.

| Header (setting) | Types | Without it |
|---|---|---|
| `X-Aforo-Metric` (`metric_header`) | all | the mapped / default metric |
| `X-Aforo-Quantity` (`quantity_header`) | all but MCP tool calls | `quantity_source` (1) |
| `X-Aforo-Agent-Id` (`agent_id_header`) | `AI_AGENT`, `MCP_SERVER` | `AI_AGENT`: `agent_id`, else the Kong service id. `MCP_SERVER`: the customer |
| `X-Aforo-Session-Id` (`session_id_header`) | `AI_AGENT`, `MCP_SERVER` | `AI_AGENT`: one session per request. `MCP_SERVER`: the upstream's `Mcp-Session-Id`, else no session |
| `X-Aforo-Trace-Id` (`trace_id_header`) | `AGENTIC_API` | one trace (goal) per request |

A header that is present but unusable (not valid text, or longer than Aforo accepts: agent 36, session 64, trace 128, metric 255 characters) skips that event with a warning rather than billing it under a fallback. Headers must be sent with the response headers: for a chunked or streamed (SSE) response they have to be known before the body starts, because trailers are not read.

## When usage is recorded

In the `log` phase, after the last byte of the response has gone to the client — also for chunked and streamed responses — so metering never delays the call. A call is not recorded when:

- this plugin refused it (JWT 401, rate-limit or margin-guard 429, pre-flight 429/503);
- its status is in `exclude_status_codes` (default 401, 403, 429 — which also covers `key-auth` and `acl` refusals, which happen before this plugin runs; keep those codes in the list);
- its path is in `exclude_paths`, or it is a CORS preflight;
- it is an MCP message that is not a `tools/call` (see above).

Upstream errors are recorded, with the status as `executionStatus` (table below), the way Aforo treats failed executions: an `OUTCOME_BASED` rate plan prices each status by its weight, and a metric filter on Execution Status can leave failures out. To not record a status at all, add it to `exclude_status_codes`.

### Execution status

Every event carries `executionStatus`, from the status the client received: 2xx/3xx `SUCCESS`, 408/504 `TIMEOUT`, 499 `CANCELLED`, 400/422 `VALIDATION_FAILED`, 401/403/429 `BLOCKED`, any other 4xx/5xx `ERROR`. `status_outcomes` overrides it per code, e.g. `{"404": "VALIDATION_FAILED"}`. The table is the same in every Aforo gateway plugin.

### Pre-flight quota check

With `preflight_quota_enabled`, the access phase asks the ingestor's `POST /api/v1/quota/check` (`{customerId, metricName}`, `X-API-Key` + `X-Tenant-Id`) before proxying:

- It checks the metric(s) the call's events will be billed to (`metric_mappings`, central mappings, `default_metric`, the MCP tool-call metric). A call that will not be billed is not checked, so an MCP `initialize`, `tools/list` or `ping` is never refused.
- `X-Aforo-Metric` and `X-Aforo-Quantity` come from the response and do not exist yet: the configured metric is checked, and the question is whether the quota is already used up. A metric the upstream renames is still enforced by the ingestor when the event arrives.
- `DENY` answers 429 with `Retry-After` (whole seconds, at least 1), and the refused call is not metered. `WARN` lets the call through with `X-RateLimit-Warning`.
- Timeout (default 300 ms), error or non-200: the call goes through (fail-open), unless `preflight_quota_fail_open=false`, which answers 503.

## Configuration

Every option lives under `config.*`. `aforo_endpoint`, `api_key`, and `tenant_id` are required; the rest have defaults.

| Option | Type | Default | What it does |
|--------|------|---------|--------------|
| `aforo_endpoint` | string | — (required) | Aforo ingestor batch URL. Use `https://api.aforo.ai/v1/ingest/batch`. |
| `api_key` | string | — (required) | Aforo API key, scoped `usage:ingest`. Sent as `X-API-Key` on the flush — never as `Authorization: Bearer`, which the ingestor rejects with 401. Stored encrypted. |
| `tenant_id` | string | — (required) | Aforo tenant identifier. Sent as the `X-Tenant-Id` header on the flush. |
| `product_type` | string | `API` | `productType` sent on every event (trimmed, upper-cased; unknown values passed through). See [Minimal config per product type](#minimal-config-per-product-type). MCP `tools/call` is always sent as `MCP_SERVER`; on an `MCP_SERVER` product only tool calls are metered. Events missing the fields their type requires are skipped, not sent (one invalid event fails the whole batch). `GRPC_API`/`GRAPHQL_API`/`WEBSOCKET_API`/`MQTT_BROKER` need fields an HTTP gateway cannot observe, so their events are skipped. |
| `metric_name_pattern` | string | `{method} {path}` | Metric-name template. Variables: `{method}`, `{path}`, `{service}`, `{route}`, `{consumer}`. |
| `quantity_source` | string | `1` | `1` = one unit per request, `response_size` = response body bytes sent to the client (also for chunked and streamed responses), or a literal number. |
| `agent_id` | string | — | `AI_AGENT` only: the agent ID for the service or route this plugin is on (at most 36 characters), used when the upstream does not send `agent_id_header`. Without either, the Kong service's id is the agent. Not used for MCP tool calls: their agent is the caller. |
| `agent_id_header` | string | `X-Aforo-Agent-Id` | Upstream **response** header carrying the agent ID for one `AI_AGENT` request (wins over `agent_id`) or MCP tool call (wins over the customer). If the upstream sends it with a value that cannot be used (not valid text, or over 36 characters), the event is skipped with a warning rather than billed to a fallback. A request header of the same name, and an MCP `params._meta.agent_id`, are never read. `null` disables it. |
| `session_id_header` | string | `X-Aforo-Session-Id` | Upstream **response** header carrying the session ID for an `AI_AGENT` request or MCP tool call, so several requests can share one session. Without it, an `AI_AGENT` request is its own session and an MCP call uses the upstream's `Mcp-Session-Id` response header. A value that cannot be used (not valid text, or over 64 characters) skips the event with a warning. Request headers are never read. `null` disables it. |
| `trace_id_header` | string | `X-Aforo-Trace-Id` | `AGENTIC_API` only. Upstream **response** header naming the trace (goal) a request belongs to, so several requests can make up one goal. Without it, each request is its own trace. The client's `traceparent` / `x-trace-id` are never the trace (they are still sent in `trace` for correlation): Aforo bills an agentic API per trace, and a client repeating one `traceparent` would fold all its goals into one. A value that cannot be used (not valid text, or over 128 characters) skips the event. `null` disables it. |
| `status_outcomes` | map | — | Per-status-code `executionStatus` overrides, e.g. `{"404": "VALIDATION_FAILED"}`; keys are exact codes 200-599. See [Execution status](#execution-status). |
| `customer_id_source` | string | `consumer` | Only `consumer` is accepted. A validated JWT `customer_id` claim takes precedence when `jwt_validation_enabled=true`. Request headers / query params are never read. |
| `flush_interval_ms` | integer | `5000` | Max time before a non-empty buffer flushes. Also the wait before retrying after a failed flush. |
| `flush_count` | integer | `50` | Flush immediately once this many events are buffered. |
| `include_metadata` | boolean | `true` | Include request metadata (method, path, status, latency, sizes) in the event. `metadata.endpoint_path` is always sent, because metric mappings and filters use it. |
| `mcp_enabled` | boolean | `false` | Meter MCP JSON-RPC `tools/call` POST bodies as tool invocations: one event per call, also inside a JSON-RPC batch. Bodies up to 1 MB are read. Always on for `product_type: MCP_SERVER`. See [Step 7 of the user guide](USER_GUIDE.md#step-7-optional--turn-on-mcp-tool-invocation-metering). |
| `mcp_meter_non_tool_calls` | boolean | `false` | With `mcp_enabled`, also meter JSON-RPC messages that are not `tools/call` (`initialize`, `tools/list`, `ping`, notifications) as plain API calls. Off by default: they are protocol traffic. Requests that are not JSON-RPC are metered either way. |
| `mcp_product_id` | string | — | Aforo product ID for MCP metering (set when `mcp_enabled=true`). |
| `jwt_validation_enabled` | boolean | `false` | Validate an Aforo RS256 JWT in the access phase before metering: `exp`, `iss`, the signature, `tenant_id`, the jti blocklist and client revocation. A token whose `tenant_id` is not this plugin's `tenant_id` is rejected with 401 `TENANT_MISMATCH`. |
| `jwt_issuer` | string | `https://auth.aforo.ai` | Expected `iss` claim. Empty string skips the issuer check. |
| `jwt_jwks_uri` | string | — | The issuer's JWKS URL, e.g. `https://<issuer>/.well-known/jwks.json`. The key is chosen by the token's `kid`. Keys are cached for an hour and refreshed in the background; a token with an unknown `kid` triggers a refetch, at most once every 30 s. Used when `jwt_public_key` is not set. |
| `jwt_public_key` | string | — | PEM RSA public key for offline RS256 verification. Takes precedence over `jwt_jwks_uri`. Stored encrypted. |
| `jwt_allow_unverified_signature` | boolean | `false` | Accept JWTs without checking the signature, but only when no key is configured (neither `jwt_public_key` nor `jwt_jwks_uri`) or `resty.openssl` cannot load. With a key configured, a token that does not verify, or names a `kid` the JWKS does not have, is always rejected. Enable only when signatures are verified before Kong reaches this plugin. |
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
| `margin_guard_cache_ttl` | integer | `30` | How long a BLOCK, or an ALLOW while no throttle is active, is cached, in seconds. THROTTLE, and the ALLOW for a request a throttle let through, are never cached. `0` disables the cache. Throttling is exact only with a pricing-service version that marks a throttle pass (`currentLevel: L2_THROTTLE`); older versions answer it as a plain ALLOW, which is cached. |
| `preflight_quota_enabled` | boolean | `false` | Ask the ingestor's `POST /api/v1/quota/check` before proxying (rate limit, prepaid wallet, cumulative quota) for the metric the call will be billed to; 429 on `DENY`. Calls that will not be billed are not checked. Off by default: it adds a synchronous call per cache miss. See [Pre-flight quota check](#pre-flight-quota-check). |
| `preflight_quota_url` | string | origin of `aforo_endpoint` + `/api/v1/quota/check` | Quota-check endpoint. |
| `preflight_quota_api_key` | string | `api_key` | Key sent as `X-API-Key` on the check. Set it only when the ingestor does not accept `api_key` for the check. Stored encrypted. |
| `preflight_quota_timeout_ms` | integer | `300` | Timeout for the check, in ms (it is on the request path, on a cache miss). 300 allows for Kong-to-Aforo over the internet. |
| `preflight_quota_cache_ttl_ms` | integer | `1000` | How long an `ALLOW` is cached per tenant/customer/metric. `DENY` is never cached. `0` disables. |
| `preflight_quota_fail_open` | boolean | `true` | On error, timeout or non-200: let the request through (`true`) or answer 503 (`false`). |
| `exclude_paths` | array | `["/health","/ready","/metrics"]` | Paths skipped from metering. An entry matches that path and anything below it: `/health` skips `/health` and `/health/live`, not `/healthcare`. |
| `exclude_status_codes` | array | `[401,403,429]` | Status codes skipped from metering. Keep 401 and 403 in it when `key-auth` / `acl` sit in front: their refusals happen before this plugin runs. Separately, a request this plugin refuses itself (JWT 401, rate-limit or margin-guard 429, pre-flight quota 429/503) is never metered, whatever this list says. |

## Walk me through it

Step-by-step from install to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **JWT revocation checks fail open.** With `jwt_validation_enabled=true` the signature is always verified, with the key from `jwt_public_key` or `jwt_jwks_uri` (using `resty.openssl`, which ships with Kong; no extra library). A token that does not verify is rejected, and so is one whose `kid` the JWKS does not have. If the issuer replaces its key but keeps the `kid`, the first token that fails triggers one refetch of the JWKS (at most every 30 seconds). If the JWKS cannot be fetched, tokens it would verify are rejected. The jti blocklist and client revocation live in Redis: if Redis is unreachable, or answers with an error such as `NOAUTH`, tokens are let through without the revocation check and a warning is logged.
- **No durable buffer.** Events live in the `aforo_buffer` shared dict until they are delivered, in one buffer per destination (`aforo_endpoint` + `tenant_id` + `api_key`). A buffer is only ever delivered with its own endpoint, tenant and key, and events never move to another buffer — not when a plugin's `api_key`, `tenant_id` or `aforo_endpoint` changes either (see [Rotating the Aforo API key](USER_GUIDE.md#rotating-the-aforo-api-key)). What the ingestor could not take is kept and retried every `flush_interval_ms`: timeouts, 5xx, 408, 429, and events a 202 reports as not stored — up to 10,000 events per buffer, or until the dict is full. A destination the ingestor refuses (401/403/404, or 400 for the whole request) keeps only its newest 500 events and is retried with its own key, backing off from twice `flush_interval_ms` to every 5 minutes; events older than 72 hours are dropped (and logged), since the ingestor would refuse them. When the dict runs low, its events, and then those of destinations that are failing, make room for the healthy ones. The plugin's caches never push buffered events out. A batch answered 400 is split in halves so one bad event does not take others with it, and a batch answered 413 is split until the parts are small enough; an event refused on its own is dropped with the reason logged. On a reload or graceful stop each buffer gets one quick last send, and the new workers pick up what is left; a crash or `kill -9` loses whatever is buffered — this is best-effort metering, not a guaranteed-delivery queue.
- **Rate limiting does not apply to JWT-authenticated requests yet.** Aforo's rate-limit policies are keyed by API key, and a JWT carries only the key's id, so these requests pass without a rate-limit check. The plugin logs this once.
- **Rate-limit, margin-guard and pre-flight quota enforcement need Redis / pricing-service / the ingestor reachable.** All fail open: a timeout or an unreachable dependency lets the request through rather than blocking it (the quota check can be made fail-closed with `preflight_quota_fail_open=false`).
