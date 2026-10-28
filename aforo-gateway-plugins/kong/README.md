# kong-plugin-aforo-metering

A Kong Gateway plugin that captures API usage events in Kong's `log` phase and batch-forwards them to Aforo for billing and analytics. Metering runs after the response is sent, so it adds no latency to the request path.

**Version:** 2.8.1 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

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
luarocks make kong-plugin-aforo-metering-2.8.1-1.rockspec
```

Then tell Kong to load it and reserve the shared memory it uses. In `kong.conf`:

```
plugins = bundled,aforo-metering
nginx_http_lua_shared_dict = aforo_buffer 10m; lua_shared_dict aforo_cache 5m
```

> ⚠ `aforo_buffer` is mandatory. Without it the log phase logs `Shared dict 'aforo_buffer' not available` and drops every event. `aforo_cache` (2.8.0) holds the caches, warning throttles and counters so they never take room from buffered events; without it they share `aforo_buffer` and each worker logs one error. Kong writes the `kong.conf` value after `lua_shared_dict `, hence the second directive inside the one line; in a raw nginx template the directives are `lua_shared_dict aforo_buffer 10m;` and `lua_shared_dict aforo_cache 5m;`.

Reload Kong: `kong reload`.

## Supported Kong versions

| Kong | Image | Result |
|---|---|---|
| 3.4 | `kong:3.4` (open source) | in production, self-hosted. 2.6.0: busted 315/315; 2.8.0: busted 342/342 locally on LuaJIT 2.1 (not yet on these images). Public line before the merge: end-to-end against a stand-in Aforo, set up through the Admin API (21 checks) and DB-less (8 checks) |
| 3.14 LTS | `kong/kong-gateway:3.14.0.15` | 2.6.0: busted 315/315; 2.8.0: busted 342/342 locally on LuaJIT 2.1 (not yet on these images). Public line before the merge: end-to-end, Admin API (21 checks) and DB-less (8 checks) |
| 3.16 | `kong/kong-gateway:3.16.0.1` | 2.6.0: busted 315/315; 2.8.0: busted 342/342 locally on LuaJIT 2.1 (not yet on these images). Public line before the merge: end-to-end DB-less (8 checks). Starts as a Kong Konnect data plane with the plugin loaded (tested without reaching a real control plane) |

End-to-end runs 2026-10-22 (public line, before the 2.6.0 merge; 2.6.0 has run only the busted suite on these images). On every version above, all four product types (`API`, `AI_AGENT`, `AGENTIC_API`,
`MCP_SERVER`) produce the same events, the pre-flight quota check answers 429 with `Retry-After`, and
RS256 verification through `resty.openssl` works. No code change was needed past 3.4.

Things that differ on newer Kong, none of them in the plugin:

- Kong ships no open-source image after 3.9. The Kong Gateway image (`kong/kong-gateway`) runs
  without a license. **From 3.16, unlicensed Kong Gateway is read-only**: the Admin API answers every
  write with 403 "Enterprise license missing or expired", so a self-hosted 3.16 needs a license to be
  configured through its Admin API. DB-less configuration still loads, and Konnect licenses its data
  planes.
- Kong Gateway creates a route for `https` only when `protocols` is not given (Kong 3.4: `http` and
  `https`). Plain-http calls to such a route get 426 "Please use HTTPS protocol". Set `protocols`
  when you create routes.

Build the image on another Kong with the `KONG_IMAGE_BASE` build argument (default `kong:3.4`):

```bash
docker build --build-arg KONG_IMAGE_BASE=kong/kong-gateway:3.16.0.1 -t kong-aforo:3.16 .
```

### Kong Konnect

On Kong Konnect, the plugin runs on your data plane nodes; Konnect is the control plane.

- **Data plane:** run a Kong Gateway image with the plugin installed, `KONG_PLUGINS=bundled,aforo-metering`
  and the `aforo_buffer` and `aforo_cache` shared dicts, i.e. the image above, with the settings from Konnect's "New Data
  Plane Node" page (`KONG_ROLE=data_plane`, `KONG_DATABASE=off`, `KONG_KONNECT_MODE=on`,
  `KONG_CLUSTER_MTLS=pki`, the control plane and telemetry endpoints, and the certificate and key it
  generates). Every data plane of the control plane needs the plugin.
- **Control plane:** Konnect stores an `aforo-metering` plugin only once it knows the plugin's schema.
  Upload `schema.lua` as a custom plugin schema (Konnect API `POST /v2/control-planes/{id}/core-entities/plugin-schemas`
  with `{"lua_schema": "<schema.lua>"}`, or the Konnect UI). Aforo does this when you connect Konnect
  in Aforo.

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

Send a request through Kong, then check the proxy logs for `[aforo-metering] Flushed N events to Aforo (status=2xx)`. That line is logged at `info`; Kong's default `log_level` is `notice`, so set `KONG_LOG_LEVEL=info` (or `log_level = info` in `kong.conf`) to see it. Failed flushes log at `warn` and show at the default level.

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

## Rate limiting

`rate_limit_enabled` enforces the rate-limit policy pricing-service publishes for the caller's API key.

- **Which key.** The verified JWT's `key_id` (policy `ratelimit:policy:{tenantId}:keyid:{keyId}`), else the key-auth credential's key or a raw `Authorization: Bearer` key (policy `ratelimit:policy:{tenantId}:{sha256(key)}`). A token refresh keeps the same counter, because the counter belongs to the key, not to the token. Claims of a token let through by `jwt_allow_unverified_signature` are never used.
- **Algorithm: sliding-window counter**, as Kong's rate-limiting-advanced and Cloudflare use. Each tier counts requests in fixed windows and weighs the previous window by the part of it still inside the last `windowSeconds`: `previous × (time left in this window / window) + current`. A client cannot send the limit at the end of one window and the limit again at the start of the next. Before 2.7.0 the plugin used a plain fixed window, which allowed up to twice the limit across a window edge.
- **Refused requests do not count** in `HARD` mode, so a client that keeps retrying is let back in as its earlier requests age out. `SOFT` mode counts every request and only adds `X-RateLimit-Warning`.
- **Headers.** `X-RateLimit-Limit` and `X-RateLimit-Remaining` describe the 60-second tier. `X-RateLimit-Reset` is the seconds until one more request fits when none is left, otherwise the seconds until the current window rolls over. A 429 carries `Retry-After`: the seconds until the next request would be allowed.
- **Cost per request.** One Redis round trip in steady state: AUTH only on a new connection (pooled connections are kept per host, port, TLS settings and password), the policy cached in `aforo_cache` for 5 seconds, and every tier checked and counted in one `EVALSHA` (`EVAL` the first time Redis sees the script).
- **When Redis fails** (connect, AUTH, an error reply, a script error) the request is let through and a warning is logged at most once a minute, as before. A refused script (CROSSSLOT included) is logged at error level.
- **Identity on a Kong-jwt route** (2.8.1): a verified JWT is limited by its `key_id`. Without `key_id` it is not rate limited and a warning says so; the plugin no longer falls back to `kong.client.get_credential()`, which on such a route is the jwt_secrets row whose `.key` is the issuer key every caller shares.
- **TLS** (2.8.0): `rate_limit_redis_ssl = true` connects over TLS with the certificate verified against `lua_ssl_trusted_certificate` (`rate_limit_redis_ssl_verify`, default `true`) and SNI set to `rate_limit_redis_server_name` (default the host).

## Pre-flight quota check

With `preflight_quota_enabled`, the access phase asks the ingestor's `POST /api/v1/quota/check` (`{customerId, metricName, estimatedQuantity}`, `X-API-Key` + `X-Tenant-Id`) before proxying:

- It checks the metric(s) the call's events will be billed to (`metric_mappings`, central mappings, `default_metric`, the MCP tool-call metric). A call that will not be billed is not checked, so an MCP `initialize`, `tools/list` or `ping` is never refused.
- `X-Aforo-Metric` and `X-Aforo-Quantity` come from the response and do not exist yet: the configured metric is checked, and the question is whether the quota is already used up. A metric the upstream renames is still enforced by the ingestor when the event arrives.
- `estimatedQuantity` is a numeric `quantity_source`, else 1 (a quantity from the response is not known yet).
- `DENY` answers 429 with `Retry-After` (whole seconds, at least 1), and the refused call is not metered. `WARN` lets the call through with `X-RateLimit-Warning`. `ALLOW` and `WARN` are cached for `preflight_quota_cache_ttl_ms`. A `DENY` is cached until its `retryAfterMs` (at most 60 s, 5 s when the answer has none) and answered from the cache with the remaining `Retry-After` (2.8.0; before, every refused request asked again). A top-up therefore unblocks within that wait.
- Timeout (default 300 ms), error or non-200: the call goes through (fail-open), unless `preflight_quota_fail_open=false`, which answers 503.
- **Circuit breaker** (2.8.0): after `preflight_quota_breaker_threshold` (5) failures in a row the check is not called for `preflight_quota_breaker_cooldown_s` (10 s) and the fail mode applies at once, so an outage does not cost each request the full timeout. Then one request probes; success closes the breaker, failure opens it again. Shared by all workers, per quota-check URL and tenant. `0` turns it off.

## Configuration

Every option lives under `config.*`. `aforo_endpoint`, `api_key`, and `tenant_id` are required; the rest have defaults.

| Option | Type | Default | What it does |
|--------|------|---------|--------------|
| `aforo_endpoint` | string | — (required) | Aforo ingestor batch URL. Use `https://api.aforo.ai/v1/ingest/batch`. |
| `api_key` | string | — (required) | Aforo API key, scoped `usage:ingest`. Sent as `X-API-Key` on the flush. (The ingestor also accepts an Aforo key — `sk_live_…` / `sk_test_…` — as `Authorization: Bearer`; this plugin does not use that form.) Stored encrypted. |
| `tenant_id` | string | — (required) | Aforo tenant identifier. Sent as the `X-Tenant-Id` header on the flush. |
| `product_type` | string | `API` | `productType` sent on every event (trimmed, upper-cased; unknown values passed through). See [Minimal config per product type](#minimal-config-per-product-type). MCP `tools/call` is always sent as `MCP_SERVER`; on an `MCP_SERVER` product only tool calls are metered. `AI_AGENT` takes `agentId` from `agent_id_header` / `agent_id` and `sessionId` from `session_id_header`. A request is `AGENTIC_API` only when this is set to it: a client's `traceparent` never changes the type (since 2.6.0). Events missing the fields their type requires are skipped and counted, not sent (one invalid event fails the whole batch). `GRPC_API` / `GRAPHQL_API` / `WEBSOCKET_API` come from detection (`grpc_enabled` etc.), not from this setting; `MQTT_BROKER` is not proxied by Kong. |
| `default_metric` | string | `api_calls` | Metric used when nothing below matches. Must exist in your Aforo catalog. |
| `metric_mappings` | array | — | Ordered `{path_pattern, method?, metric_name}` rules; first match wins. `path_pattern` is a Lua pattern (anchor with `^`). |
| `mappings_url` | string | — | Aforo catalog gateway-mappings endpoint. When set, EXACT / PREFIX / CONTAINS rules are fetched in a background timer and cached; a failed refresh keeps the last table. |
| `mappings_refresh_seconds` | number | `300` | Refresh interval until the endpoint returns its own `cacheTtlSeconds`. |
| `mappings_timeout_ms` | number | `3000` | Timeout of the background fetch. Never on the request path. |
| `metric_header` | string | `X-Aforo-Metric` | Upstream **response** header that names the metric for one request. Empty disables. |
| `quantity_header` | string | `X-Aforo-Quantity` | Upstream **response** header that supplies the quantity for one request. Empty disables. |
| `metric_name_pattern` | string | `{method} {path}` | Metric-name template. Variables: `{method}`, `{path}`, `{service}`, `{route}`, `{consumer}`. |
| `quantity_source` | string | `1` | `1` = one unit per request, `response_size` = response body bytes sent to the client (also for chunked and streamed responses), or a literal number. |
| `agent_id` | string | — | `AI_AGENT` only: the agent ID for the service or route this plugin is on (at most 36 characters), used when the upstream does not send `agent_id_header`. Without either, the Kong service's id is the agent. Not used for MCP tool calls: their agent is the caller. |
| `agent_id_header` | string | `X-Aforo-Agent-Id` | Upstream **response** header carrying the agent ID for one `AI_AGENT` request (wins over `agent_id`) or MCP tool call (wins over the customer). If the upstream sends it with a value that cannot be used (not valid text, or over 36 characters), the event is skipped with a warning rather than billed to a fallback. A request header of the same name, and an MCP `params._meta.agent_id`, are never read. `null` disables it. |
| `session_id_header` | string | `X-Aforo-Session-Id` | Upstream **response** header carrying the session ID for an `AI_AGENT` request or MCP tool call, so several requests can share one session. Without it, an `AI_AGENT` request is its own session and an MCP call uses the upstream's `Mcp-Session-Id` response header. A value that cannot be used (not valid text, or over 64 characters) skips the event with a warning. Request headers are never read. `null` disables it. |
| `trace_id_header` | string | `X-Aforo-Trace-Id` | `AGENTIC_API` only. Upstream **response** header naming the trace (goal) a request belongs to, so several requests can make up one goal. Without it, each request is its own trace. The client's `traceparent` / `x-trace-id` are never the trace (they are still sent in `trace` for correlation): Aforo bills an agentic API per trace, and a client repeating one `traceparent` would fold all its goals into one. A value that cannot be used (not valid text, or over 128 characters) skips the event. `null` disables it. |
| `status_outcomes` | map | — | Per-status-code `executionStatus` overrides, e.g. `{"404": "VALIDATION_FAILED"}`; keys are exact codes 200-599. See [Execution status](#execution-status). |
| `customer_id_source` | string | `consumer` | Only `consumer` is accepted. See [Customer identity](#customer-identity). A verified JWT takes precedence when configured: `customer_id_jwt_claim` (the JWT Kong's `jwt` plugin verified; then the only source), else the `customer_id` claim of the token this plugin verified with `jwt_validation_enabled`. Request headers / query params are never read. |
| `customer_id_jwt_claim` | string | — | Claim of the JWT that Kong's `jwt` plugin verified, used as `customerId`. When set it is the only identity source. |
| `customer_id_jwt_exclude_claims` | array | `[]` | With `customer_id_jwt_claim`: a token carrying any of these claims is not metered (e.g. staff impersonation). |
| `grpc_enabled` / `graphql_enabled` / `websocket_enabled` | boolean | `false` | Detect gRPC calls, GraphQL operations and WebSocket handshakes and send them with their own product type and fields. |
| `flush_interval_ms` | integer | `5000` | Max time before a non-empty buffer flushes. Also the wait before retrying after a failed flush. |
| `flush_count` | integer | `50` | Flush immediately once this many events are buffered. |
| `include_metadata` | boolean | `true` | Include request metadata (method, path, status, latency, sizes) in the event. `metadata.endpoint_path` is always sent, because metric mappings and filters use it. |
| `mcp_enabled` | boolean | `false` | Meter MCP JSON-RPC `tools/call` POST bodies as tool invocations: one event per call, also inside a JSON-RPC batch. Bodies up to 1 MB are read. Always on for `product_type: MCP_SERVER`. See [Step 7 of the user guide](USER_GUIDE.md#step-7-optional--turn-on-mcp-tool-invocation-metering). |
| `mcp_meter_non_tool_calls` | boolean | `false` | With `mcp_enabled`, also meter JSON-RPC messages that are not `tools/call` (`initialize`, `tools/list`, `ping`, notifications) as plain API calls. Off by default: they are protocol traffic. Requests that are not JSON-RPC are metered either way. |
| `mcp_product_id` | string | — | Aforo product ID for MCP metering (set when `mcp_enabled=true`). |
| `jwt_validation_enabled` | boolean | `false` | Verify an Aforo RS256 JWT in the access phase: signature against the key from `jwt_jwks_uri` (by `kid`) or `jwt_public_key`, then `exp`, `nbf`, `iss`, `tenant_id`, jti blocklist and client revocation. 401 on failure; a token whose `tenant_id` is not this plugin's `tenant_id` gets 401 `TENANT_MISMATCH`. 503 when the revocation check cannot reach Redis (see `jti_redis_fail_mode`). |
| `jwt_issuer` | string | `https://auth.aforo.ai` | Expected `iss` claim. Required with `jwt_validation_enabled` since 2.8.0: without it JWTs get 500 `ISSUER_NOT_CONFIGURED` (and a new config is refused) unless `jwt_issuer_check_disabled = true`. |
| `jwt_issuer_check_disabled` | boolean | `false` | Accept any issuer when `jwt_issuer` is not set. |
| `jwt_audience` | array | — | Accepted audiences. When set, the token's `aud` (string or array) must name one of them; a token without `aud` gets 401 `INVALID_AUDIENCE`. Unset: `aud` is not checked (Aforo's issuer mints tokens without `aud` and binds them to the tenant instead). |
| `jwt_jwks_uri` | string | — | https URL of the issuer's JWKS (organization-service serves it at `/.well-known/jwks.json`). The key is chosen by the token's `kid`, so a key rotation needs no config change. An unknown `kid`, or a cached key that no longer verifies (the issuer replaced it under the same `kid`), refreshes the set at most every 30 s; while the JWKS cannot be fetched the last good set is used for up to 24 h. Used first when `jwt_public_key` is also set. |
| `jwt_jwks_cache_ttl` | integer | `600` | Seconds a fetched JWKS is used before it is fetched again (30–86400). |
| `jwt_public_key` | string | — | PEM RSA **public** key of the issuer. Needed when `jwt_jwks_uri` is not set; with both set it verifies tokens the JWKS has no key for. A private key is refused. Stored encrypted. |
| `jwt_allow_unverified_signature` | boolean | `false` | Let a token through when the plugin cannot verify it (no `jwt_jwks_uri` and no `jwt_public_key`). Access only: such a token supplies no `customerId`. |
| `jwt_redis_host` | string | — | Redis host for the jti blocklist. Falls back to `rate_limit_redis_host`. |
| `jwt_redis_port` | integer | — | Redis port for the jti blocklist. Falls back to `rate_limit_redis_port`. |
| `jwt_redis_password` | string | — | Redis password for the jti blocklist. Falls back to `rate_limit_redis_password` when the blocklist is on the same Redis host and port as rate limiting. Stored encrypted. |
| `jwt_redis_timeout_ms` | integer | `250` | Timeout for each step of the revocation lookup: the connect (including the TLS handshake), then one round trip of pipelined `GET`s, one per key. On timeout `jti_redis_fail_mode` applies (503 by default). Was 500 ms per `GET`, up to three `GET`s, before 2.8.0. Works on ElastiCache Serverless and cluster proxies that route per key; see [What this doesn't cover](#what-this-doesnt-cover) for a classic Redis Cluster. |
| `jwt_redis_ssl` | boolean | — | Blocklist Redis over TLS. Unset: as `rate_limit_redis_ssl` when the blocklist is on the rate-limit Redis host and port, else plain. |
| `jwt_redis_ssl_verify` | boolean | — | Verify the blocklist Redis certificate against `lua_ssl_trusted_certificate` (default `true`; on the rate-limit Redis, as `rate_limit_redis_ssl_verify`). `false` encrypts without authenticating the server and is logged. |
| `jwt_redis_server_name` | string | — | TLS server name (SNI and certificate name) for the blocklist Redis. Defaults to the host. |
| `jti_redis_fail_mode` | string | `closed` | What the jti-blocklist and client-revocation checks do when Redis cannot answer (connect, AUTH or a GET fails, or an error reply such as `NOAUTH`). `closed`: refuse with **503** `{"error":"temporarily_unavailable","error_description":"REVOCATION_CHECK_UNAVAILABLE"}` and `Retry-After: 1`. `open`: let the request through, log a warning (once per 60s) and count it. Before 2.4.0 the plugin always failed open. With `jwt_validation_enabled` and no reachable Redis, every request with a `jti`, `client_id` or `key_id` claim now gets 503 — point `jwt_redis_host`/`jwt_redis_port` at Redis, or set `open`. Counted in `aforo_metering_revocation_check_unavailable_total{check="jti"\|"client",outcome="closed"\|"open"}` (when Kong's prometheus plugin is loaded) and in the `aforo_cache` shared dict under `aforo_revocation_unavailable:<check>:<outcome>`. |
| `rate_limit_enabled` | boolean | `false` | Enforce the Aforo rate-limit policy of the caller's API key in the access phase (429 on a HARD breach). The key is found from, in order: the `key_id` claim of a JWT whose signature was verified (by this plugin or by Kong's `jwt` plugin), the Kong key-auth credential's key, or an API key sent as `Authorization: Bearer <key>`. A JWT that was not verified, or carries no `key_id`, is not rate limited. Sliding-window counter: see [Rate limiting](#rate-limiting). |
| `rate_limit_redis_host` | string | `127.0.0.1` | Redis host for rate-limit counters and policy cache. |
| `rate_limit_redis_port` | integer | `6379` | Redis port for rate-limit counters. |
| `rate_limit_redis_password` | string | — | Redis password (optional, encrypted). |
| `rate_limit_redis_timeout_ms` | integer | `50` | Redis timeout; fail-open on timeout. |
| `rate_limit_redis_ssl` | boolean | `false` | Rate-limit Redis over TLS. |
| `rate_limit_redis_ssl_verify` | boolean | `true` | Verify the rate-limit Redis certificate against `lua_ssl_trusted_certificate`. |
| `rate_limit_redis_server_name` | string | — | TLS server name for the rate-limit Redis. Defaults to `rate_limit_redis_host`. |
| `margin_guard_enabled` | boolean | `false` | Before proxying, ask pricing-service whether the tenant (GLOBAL scope) or the customer is margin-blocked or throttled, and answer 429 with `Retry-After` if so. Fails open. Requires `margin_guard_url`. A customer id over 128 characters (pricing's limit) is not sent; only GLOBAL is asked. A 4xx answer other than 408 / 429 is logged and let through without counting against the breaker (2.8.1). |
| `margin_guard_url` | string | — | Pricing-service base URL, e.g. `http://pricing:8083`. The plugin calls pricing's `GET /api/v1/margin-guard/quick-check` with `api_key` as `X-API-Key`; pricing takes the tenant from the key (2.8.0; needs a pricing-service release that serves this path). Required when `margin_guard_enabled` is true. |
| `margin_guard_cache_ttl` | integer | `30` | How long a BLOCK, or an ALLOW while no throttle is active, is cached, in seconds. THROTTLE, and the ALLOW for a request a throttle let through, are never cached. `0` disables the cache. Throttling is exact only with a pricing-service version that marks a throttle pass (`currentLevel: L2_THROTTLE`); older versions answer it as a plain ALLOW, which is cached. |
| `margin_guard_timeout_ms` | integer | `300` | Timeout for each call to pricing, in ms (10–5000), connect and TLS handshake included. On timeout the request is let through. Was a fixed 50 ms before 2.8.0. |
| `margin_guard_breaker_threshold` | integer | `5` | Failures in a row (timeout, error, 408, 429, 5xx, no verdict) that open the margin guard circuit breaker; while open, pricing is not called and requests go through at once. Cached answers are still used. `0` turns it off. Shared by all workers, per tenant and pricing URL. |
| `margin_guard_breaker_cooldown_s` | integer | `10` | Seconds the margin guard breaker stays open before one request probes pricing again; a success closes it. |
| `preflight_quota_enabled` | boolean | `false` | Ask the ingestor's `POST /api/v1/quota/check` before proxying (rate limit, prepaid wallet, cumulative quota) for the metric the call will be billed to; 429 on `DENY`. Calls that will not be billed are not checked. Off by default: it adds a synchronous call per cache miss. See [Pre-flight quota check](#pre-flight-quota-check). |
| `preflight_quota_url` | string | origin of `aforo_endpoint` + `/api/v1/quota/check` | Quota-check endpoint. |
| `preflight_quota_api_key` | string | `api_key` | Key sent as `X-API-Key` on the check. Set it only when the ingestor does not accept `api_key` for the check. Stored encrypted. |
| `preflight_quota_timeout_ms` | integer | `300` | Timeout for the check, in ms (it is on the request path, on a cache miss). 300 allows for Kong-to-Aforo over the internet. |
| `preflight_quota_cache_ttl_ms` | integer | `1000` | How long an `ALLOW` or `WARN` is cached per tenant/customer/metric. A `DENY` is cached until its `Retry-After` (at most 60 s). `0` disables both. |
| `preflight_quota_fail_open` | boolean | `true` | On error, timeout, non-200 or an open breaker: let the request through (`true`) or answer 503 (`false`). |
| `preflight_quota_breaker_threshold` | integer | `5` | Failures in a row that open the quota-check circuit breaker. `0` turns it off. |
| `preflight_quota_breaker_cooldown_s` | integer | `10` | Seconds the breaker stays open before one request probes again. |
| `exclude_paths` | array | `["/health","/ready","/metrics"]` | Paths skipped from metering. An entry matches that path and anything below it: `/health` skips `/health` and `/health/live`, not `/healthcare`. |
| `exclude_status_codes` | array | `[401,403,429]` | Status codes skipped from metering. Keep 401 and 403 in it when `key-auth` / `acl` sit in front: their refusals happen before this plugin runs. Separately, a request this plugin refuses itself (JWT 401, rate-limit or margin-guard 429, pre-flight quota 429/503) is never metered, whatever this list says. |

## Customer identity

Every event needs a `customerId`. The plugin takes it from one of three sources, chosen by configuration. A request with none produces no event.

| You have | Configure | `customerId` is |
|---|---|---|
| Kong consumers (key-auth, basic-auth, …) | nothing | the consumer's `custom_id`, else `username`, else `id` |
| Kong's `jwt` plugin on the route, one issuer for all callers | `customer_id_jwt_claim: <claim>` | that claim of the token Kong verified. The consumer is not used: on a `jwt` route it is the issuer, shared by every caller. |
| Aforo-issued JWTs and no Kong auth plugin | `jwt_validation_enabled: true` + `jwt_public_key` | the `customer_id` (else `sub`) claim of the token this plugin verified; the consumer when the token names none |

When both JWT options are set, `customer_id_jwt_claim` decides. A claim is used only from a token whose signature was verified on this gateway. An id the ingestor would refuse (over 64 characters, counted as the ingestor counts them, or not valid text) is not metered and is counted as `invalid_field`.

## Dropped events

Counters live in the `aforo_cache` shared dict (`aforo_buffer` when `aforo_cache` is not declared) under `aforo_dropped:<reason>` and, when Kong's `prometheus` plugin is loaded, in `aforo_metering_dropped_events_total{reason}`.

| Reason | Meaning |
|---|---|
| `buffer_overflow` | No room: a buffer at its 10,000-event cap, a refused destination past its newest 500, or a full `aforo_buffer` dict (oldest events of failing destinations are evicted first). |
| `rejected` | The ingestor refused a whole batch with a 4xx other than 401/403/404/408/429, or a single event with 400/413. |
| `ingestor_rejected` | The ingestor accepted the batch and refused individual events, e.g. a metric name that is not in your catalog. |
| `expired` | Buffered longer than 72 hours, which the ingestor no longer accepts. |
| `too_large` | One encoded event over 16 KiB. |
| `invalid_field` | An identity field (customer, metric, agent, session, trace, gRPC / GraphQL / WebSocket names) the ingestor would refuse: not valid text, or over its length limit. |
| `missing_fields` | The event's product type requires fields the request did not supply. |

## Walk me through it

Step-by-step from install to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **JWT revocation checks fail closed.** With `jwt_validation_enabled=true` the signature is always verified, with the key from `jwt_jwks_uri` or `jwt_public_key` (using `resty.openssl`, which ships with Kong; no extra library). A token that does not verify is rejected, and so is one whose `kid` the JWKS does not have. If the issuer replaces its key but keeps the `kid`, the first token that fails triggers one refetch of the JWKS (at most every 30 seconds). The jti blocklist and client revocation live in Redis: if Redis is unreachable, or answers with an error such as `NOAUTH`, the request is refused with 503 unless `jti_redis_fail_mode = open`, which lets it through and logs a warning.
- **JWKS needs https and a reachable issuer.** Without `jwt_public_key` as a fallback, a token signed before the first successful JWKS fetch is rejected (401), and so is every token once the last good set is more than 24 h old.
- **An unknown metric name is only detected by the ingestor.** The plugin cannot see your catalog. Those events come back refused in the batch response and are counted as `ingestor_rejected`; they are not retried.
- **No durable buffer.** Events live in the `aforo_buffer` shared dict until they are delivered, in one buffer per destination (`aforo_endpoint` + `tenant_id` + `api_key`). A buffer is only ever delivered with its own endpoint, tenant and key, and events never move to another buffer — not when a plugin's `api_key`, `tenant_id` or `aforo_endpoint` changes either (see [Rotating the Aforo API key](USER_GUIDE.md#rotating-the-aforo-api-key)). What the ingestor could not take is kept and retried every `flush_interval_ms`: timeouts, 5xx, 408, 429, and events a 202 reports as not stored — up to 10,000 events per buffer, or until the dict is full. A destination the ingestor refuses (401/403/404, or 400 for the whole request) keeps only its newest 500 events and is retried with its own key, backing off from twice `flush_interval_ms` to every 5 minutes; events older than 72 hours are dropped (and logged), since the ingestor would refuse them. When the dict runs low, its events, and then those of destinations that are failing, make room for the healthy ones. The plugin's caches never push buffered events out. A batch answered 400 is split in halves so one bad event does not take others with it, and a batch answered 413 is split until the parts are small enough; an event refused on its own is dropped with the reason logged. On a reload or graceful stop each buffer gets one quick last send, and the new workers pick up what is left; a crash or `kill -9` loses whatever is buffered — this is best-effort metering, not a guaranteed-delivery queue.
- **JWT rate limiting needs pricing-service to publish policies by key id.** The plugin looks a JWT request's policy up under `ratelimit:policy:{tenantId}:keyid:{keyId}`. Until pricing-service writes that key next to `ratelimit:policy:{tenantId}:{keyHash}`, JWT requests find no policy and pass unlimited, as they did before 2.7.0.
- **Revocation on a classic Redis Cluster needs a proxy.** The revocation lookup sends one `GET` per key (pipelined, one round trip), so ElastiCache Serverless and proxies that route each key to its shard work. The plugin does not follow `MOVED` redirects: pointed at one node of a classic cluster, it gets `MOVED` for keys on other shards, which fails closed (503) unless `jti_redis_fail_mode = open`. The key names (`jti:blocked:<jti>`, `jti:client:<id>`) are written by organization-service without a hash tag.
- **Rate limiting on Redis Cluster and ElastiCache Serverless** (2.8.1): every counter key of one check carries the hash tag `{tenant:scope}` (`ratelimit:count:{tenantId:scope}:{window}:{epochWindow}`), so the one script's keys sit in one slot. Before 2.8.1 they had no hash tag, the cluster refused the script with CROSSSLOT, and the check failed open: HARD limits were never enforced. A CROSSSLOT or other script refusal is now logged at error level, naming HARD limits as not enforced.
- **Rate-limit, margin-guard and pre-flight quota enforcement need Redis / pricing-service / the ingestor reachable.** All fail open: a timeout or an unreachable dependency lets the request through rather than blocking it (the quota check can be made fail-closed with `preflight_quota_fail_open=false`).
