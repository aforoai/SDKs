# kong-plugin-aforo-metering — User Guide

**Version:** 2.8.1 · **Updated:** 2026-10-28 · **Audience:** engineers running Kong Gateway (OSS, Enterprise or Kong Konnect data planes) who want API usage metered into Aforo.

## What you'll build

A Kong service with the `aforo-metering` plugin enabled, capturing one usage event per proxied request in the `log` phase and batch-shipping them to Aforo. By the end you'll see your events land in Aforo with the request method, path, status, and latency attached.

## Prerequisites

- A running Kong Gateway (3.x; tested on 3.4, 3.14 and 3.16) you can reload, with Admin API access (or declarative config you can edit, or a Kong Konnect control plane).
- LuaRocks on the Kong host (to build the plugin from source).
- An Aforo API key and tenant id. Production events go to `https://api.aforo.ai/v1/ingest/batch` (`aforo_endpoint` is required; set it per environment).
- For MCP metering: a route that proxies JSON-RPC `tools/call` POST bodies.

## Step 1 — Install the plugin from source

Not yet on LuaRocks, so build it from the rockspec in this folder:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/kong
luarocks install lua-resty-http
luarocks make kong-plugin-aforo-metering-2.8.1-1.rockspec
```

`luarocks make` reads `kong-plugin-aforo-metering-2.8.1-1.rockspec` and installs the `handler`, `schema`, `rate-limit-enforce`, `margin-guard`, `preflight-quota`, `redis-util`, `event-buffer` and `event-util` modules under `kong.plugins.aforo-metering.*`.

Two things that will bite you if you skip them:

- **Run `luarocks make` from inside this directory.** It resolves `build.modules` paths relative to the working directory, so `luarocks make kong/…rockspec` from a parent fails with `handler.lua: No such file or directory`.
- **Do not install `lua-resty-jwt`.** RS256 verification uses `resty.openssl`, which already ships with Kong. `lua-resty-jwt` depends on `lua-resty-hmac`, whose FFI binding cannot load against the OpenSSL 3 that Kong 3.x links — it fails with `size of C type is unknown or too large` because `HMAC_CTX` is opaque in OpenSSL 3. It installs cleanly and then fails at `require()`, which looks like a Lua-path problem and is not one.

### Running in Docker

Installing the plugin into a *running* Kong container does not survive, and the reason is not obvious. `KONG_PLUGINS` is an environment variable, so changing it forces `docker rm` + `docker run` — which discards whatever `luarocks make` put in the old container. The new container then dies during `init_by_lua` with `aforo-metering plugin is enabled but not installed`, and because it never reaches a running state you cannot `docker exec` in to install it. That is a deadlock, not a flaky install.

Build an image with the plugin already present:

```bash
cd SDKs/aforo-gateway-plugins/kong
docker build -t kong-aforo:3.4 .
docker run -d --name kong --network=kong-net \
  -e KONG_DATABASE=postgres -e KONG_PG_HOST=kong-database \
  -e KONG_PG_USER=kong -e KONG_PG_PASSWORD=kong \
  -e KONG_ADMIN_LISTEN=127.0.0.1:8001 \
  -p 8000:8000 kong-aforo:3.4
```

The Admin API listens on the container's loopback only: it has no authentication, so anyone who can reach it can reconfigure the gateway. Call it with `docker exec kong curl -s http://localhost:8001/...`. To reach it from the host, keep it off the network: `-e KONG_ADMIN_LISTEN=0.0.0.0:8001 -p 127.0.0.1:8001:8001`.

The `Dockerfile` sets `KONG_PLUGINS` and the `aforo_buffer` and `aforo_cache` shared dicts for you. It builds on
`kong:3.4` unless you pass another base, e.g. the Kong Gateway image (Kong ships no open-source image
after 3.9; see "Supported Kong versions" in the README for what was tested, and for the read-only
mode of unlicensed Kong Gateway 3.16):

```bash
docker build --build-arg KONG_IMAGE_BASE=kong/kong-gateway:3.16.0.1 -t kong-aforo:3.16 .
```

Verify:

```bash
docker exec kong curl -s http://localhost:8001/ | grep -o aforo-metering
```

### Local development: mounting the plugin from source

Rebuilding the image for every edit is slow. Mount the source over the installed copy instead — edit a `.lua` file, `docker restart kong`, done:

```bash
cd SDKs/aforo-gateway-plugins/kong
docker run -d --name kong --network=kong-net \
  -e KONG_DATABASE=postgres -e KONG_PG_HOST=kong-database \
  -e KONG_PG_USER=kong -e KONG_PG_PASSWORD=kong \
  -e KONG_ADMIN_LISTEN=127.0.0.1:8001 \
  -v "$PWD:/usr/local/share/lua/5.1/kong/plugins/aforo-metering:ro" \
  -p 8000:8000 kong-aforo:3.4
```

Still based on `kong-aforo:3.4`, because the mount only replaces the plugin's code — `KONG_PLUGINS` and the shared dicts still come from the image.

## Choosing what each endpoint bills as

Out of the box every event is sent as `default_metric` (`api_calls`), which must exist in
your catalog. The old default template, `metric_name_pattern = "{method} {path}"`, produced
one metric per endpoint (`GET /api/products`, `POST /api/sms/v2/send`); the ingestor refuses
any metric that is not in the catalog, so the template is now used only when you set it to
something else.

Registering one metric per endpoint is not the fix. It makes the catalog track URL
structure instead of business meaning, puts a line item per endpoint on the invoice, and
turns adding an endpoint into a billing change. Billing wants `sms_sent`, `otp_delivered`,
`call_minutes` — and many endpoints map onto one of those.

Aforo cannot do this mapping server-side. Metric filters narrow which events count toward
a metric the event has **already named**, so the name has to be correct when it arrives.
The gateway is the right place.

### Map paths to metrics

```yaml
config:
  metric_mappings:
    - path_pattern: "^/api/otp"      # specific first — first match wins
      metric_name: otp_delivered
    - path_pattern: "^/api/sms"
      metric_name: sms_sent
    - path_pattern: "^/api/call"
      method: POST                   # optional; any verb when omitted
      metric_name: call_minutes
  default_metric: api_calls          # unmapped endpoints still bill
```

`path_pattern` is a Lua pattern, not a glob — anchor with `^`. Rules are evaluated in
order, so put specific before general. A malformed pattern is skipped with an error rather
than taking metering down.

`default_metric` matters more than it looks: it means a newly added endpoint bills as
generic usage instead of being rejected. Adding a route is not a billing outage. It must
exist in your catalog.

### When only the backend knows

Some values a gateway cannot observe — call duration, tokens consumed, which of several
billable actions a multi-purpose endpoint performed. The backend can say so per request:

```
X-Aforo-Metric: call_minutes
X-Aforo-Quantity: 7.5
```

These are **response** headers, set by your upstream, so a client cannot forge them. Both
override the mapping for that request. A quantity that is not a positive number is ignored
with a warning, because the ingestor requires `quantity > 0` and a malformed value would
otherwise fail the whole batch. A metric name the plugin cannot use (not valid UTF-8 text,
or longer than 255 characters) skips the event with a warning, rather than billing it under
the default metric. The same applies to `X-Aforo-Agent-Id` and `X-Aforo-Session-Id`.

Configurable via `metric_header` / `quantity_header`; set either to `null` to disable.

### Resolution order

1. `metric_header` from the upstream response
2. a matching central mapping (`mappings_url`)
3. first matching `metric_mappings` rule
4. for an MCP tool call: `default_metric` on an `MCP_SERVER` product (unless it is still `api_calls`), else `mcp_server.tool_invocations`
5. `metric_name_pattern`, only if explicitly set to something other than the default
6. `default_metric`

The pre-flight quota check, when on, checks the metric from steps 2-6: the response header does not exist yet when it runs.

Existing deployments that set a custom `metric_name_pattern` keep working unchanged.

MCP tool calls use the metric above; gRPC, GraphQL and WebSocket events (`grpc_enabled`, `graphql_enabled`, `websocket_enabled`) use fixed names (`grpc_api.rpc_calls`, `graphql_api.operations`, `websocket_api.connection_opened`). The mappings apply to plain HTTP events.

### Fetching the rules from Aforo

Set `mappings_url` to your catalog's gateway-mappings endpoint and the plugin reads the rules you declared on each metric, so a new metric needs no gateway change. The fetch runs in a background timer with `mappings_timeout_ms` (3 s); requests only read the cached table. One worker fetches at a time, a failed fetch is retried after `mappings_refresh_seconds`, and the last good table keeps being used.


### What happens to a metric name Aforo does not know

The plugin cannot see your catalog. A name that is not valid text or longer than 255 characters is dropped at the gateway and counted (`aforo_dropped:invalid_field`). A well-formed name that is not a catalog metric is sent, refused by the ingestor for that event only, and counted as `ingestor_rejected` with the ingestor's message in the Kong log. Neither is retried. Watch `aforo_dropped:ingestor_rejected` after changing mappings.

### Metering an AI agent

If the service behind Kong is an AI agent, bill it as `AI_AGENT`. Aforo needs two
values on every AI agent event that Kong cannot see for itself: which agent did the
work (`agentId`) and which session the request belongs to (`sessionId`). The plugin
takes both from your plugin config or your upstream's response only. It never reads
them from the client's request, because a client can set a request header to anything.

1. Set `product_type: AI_AGENT` on the agent's service or route.
2. Name the agent. Set `agent_id` in the plugin config (simplest when one service is
   one agent), or have the upstream send `X-Aforo-Agent-Id: <agent id>` on its response.
   If both are present, the response header wins. With neither, the id of the Kong
   service the request went to is the agent, so an agent with no configuration is
   still metered.
3. Report tokens. Have the upstream send `X-Aforo-Quantity: <tokens>` on its response,
   as in [When only the backend knows](#when-only-the-backend-knows). Without it, each
   request counts as 1.
4. If a session spans several requests, have the upstream send
   `X-Aforo-Session-Id: <session id>` on each of those responses. Without it, each
   request is its own session.

The customer is still the Kong consumer, or the validated JWT claim (see Step 4). The
agent ID records which agent did the work, not who pays for it.

```yaml
services:
  - name: fraud-shield
    url: http://fraud-shield.internal:8080
    routes:
      - name: fraud-shield
        paths: [/agents/fraud-shield]
    plugins:
      - name: key-auth
      - name: aforo-metering
        config:
          aforo_endpoint: https://api.aforo.ai/v1/ingest/batch
          api_key: ${AFORO_API_KEY}
          tenant_id: ${AFORO_TENANT_ID}
          product_type: AI_AGENT
          agent_id: fraud-shield-agent
```

A response from the agent that used 2,100 tokens in session `sess-42`:

```
HTTP/1.1 200 OK
X-Aforo-Quantity: 2100
X-Aforo-Session-Id: sess-42
```

is metered as `agentId: fraud-shield-agent`, `sessionId: sess-42`, `quantity: 2100`. The
event's `traceId` is its session (`sess-42`): Aforo groups an agent's sessions by trace,
and the client's `traceparent` is never used for that.

For an AI agent the headers are:

| Response header | Required? | Without it |
|---|---|---|
| `X-Aforo-Quantity` | optional | 1 per request |
| `X-Aforo-Session-Id` | optional | each request is its own session |
| `X-Aforo-Agent-Id` | optional | `agent_id`, else the Kong service's id |
| `X-Aforo-Metric` | optional | `default_metric` / mappings |

Only a request routed to no Kong service can be left without an agent; it is not
metered, and the log says how to fix it:

```
[aforo-metering] Skipping events: product_type AI_AGENT requires agentId, which this request did not supply (e.g. POST /agents/fraud-shield). Fix: set config.agent_id to this service's agent ID, or have the upstream send it in the X-Aforo-Agent-Id response header.
```

The header names are configurable with `agent_id_header`, `session_id_header` and
`quantity_header`. To turn one off, set it to `null` (Kong does not accept an empty
string for these settings).

> ⚠ The plugin reads these headers after the response has gone to the client, so the
> client receives them too. Do not remove them with another plugin such as
> `response-transformer`. If you do, the plugin never sees them: the agent ID falls back
> to `agent_id` (or the service id), each request becomes its own session, and the
> quantity falls back to 1.

### Metering an agentic API

Set `product_type: AGENTIC_API`. Aforo bills an agentic API per trace: all calls of
one trace are one goal. The trace is therefore billing identity, and the plugin never
takes it from the client — a client that sent the same `traceparent` on every call would
otherwise fold all its goals into one. It comes from:

1. the upstream's `X-Aforo-Trace-Id` response header (`trace_id_header`), when several
   calls make up one goal and the backend knows it;
2. otherwise Kong's ID for the request: each call is its own goal.

| Response header | Required? | Without it |
|---|---|---|
| `X-Aforo-Trace-Id` | optional | one goal per call |
| `X-Aforo-Quantity` | optional | 1 per call |
| `X-Aforo-Metric` | optional | `default_metric` / mappings |

An upstream with no Aforo code is metered one goal per call. The client's `traceparent`,
`tracestate`, `x-trace-id` and `x-request-id` are still sent in the event's `trace`, so
you can correlate with your own tracing.

## Step 2 — Register the plugin and the shared dicts

In `kong.conf`:

```
plugins = bundled,aforo-metering
nginx_http_lua_shared_dict = aforo_buffer 10m; lua_shared_dict aforo_cache 5m
lua_ssl_verify_depth = 3
```

Kong writes the value after `lua_shared_dict `, so the second dict is a second directive inside the same line.

> ⚠ `lua_ssl_verify_depth` is not optional when `aforo_endpoint` is `https://` — which it is in production. Kong defaults it to `1`, too shallow for an ordinary leaf → intermediate → root chain, and every flush then fails with `20: unable to get local issuer certificate`. That message reads like a missing CA bundle and is not one: Kong already trusts the system store via `lua_ssl_trusted_certificate`, so installing certificates changes nothing. Only the depth does. Events are re-buffered rather than lost, so the symptom is a stalled pipeline rather than an outage.

> ⚠ The `aforo_buffer` dict is not optional. The log phase buffers events into it and a timer flushes them. Without it, every request logs `Shared dict 'aforo_buffer' not available` and the event is dropped. In a raw nginx template the equivalent directives are `lua_shared_dict aforo_buffer 10m;` and `lua_shared_dict aforo_cache 5m;`.

`aforo_cache` (2.8.0) holds everything that is not an event: the pre-flight quota cache and circuit breaker, the margin guard cache, the rate-limit policy cache, the metric mappings, warning throttles and the drop and revocation counters. Keeping them apart means a cache can never take the room buffered events need. Without `aforo_cache` they go to `aforo_buffer` as before 2.8.0, and each worker logs `Shared dict 'aforo_cache' is not declared` once.

Reload:

```bash
kong reload
```

## Step 3 — Enable metering on a service

Use the Admin API with your three Aforo values:

```bash
curl -X POST http://localhost:8001/services/my-service/plugins \
  --data "name=aforo-metering" \
  --data "config.aforo_endpoint=https://api.aforo.ai/v1/ingest/batch" \
  --data "config.api_key=$AFORO_API_KEY" \
  --data "config.tenant_id=$AFORO_TENANT_ID"
```

The same in declarative `kong.yml`:

```yaml
plugins:
  - name: aforo-metering
    service: my-service
    config:
      aforo_endpoint: https://api.aforo.ai/v1/ingest/batch
      api_key: ${AFORO_API_KEY}
      tenant_id: ${AFORO_TENANT_ID}
      product_type: API        # optional; default API
```

> ⚠ `api_key` is sent as the `X-API-Key` header (the ingestor would also accept an `sk_live_…` / `sk_test_…` key as `Authorization: Bearer`, but this plugin always uses `X-API-Key`) and `tenant_id` as the `X-Tenant-Id` header **only on the flush to Aforo** — neither is read from inbound client requests. Customer identity comes from the Kong consumer (or a validated JWT claim), never from a request header.

## Step 4 — Attach a customer identity

A request with no verified customer produces no event. Pick the model that matches how the route authenticates.

### A. Kong consumers (key-auth, basic-auth, …)

Nothing to configure. Bind a consumer to the credential:

```bash
curl -X POST http://localhost:8001/consumers --data "username=acme-corp" --data "custom_id=cust_acme"
curl -X POST http://localhost:8001/consumers/acme-corp/key-auth --data "key=acme-secret-key"
curl -X POST http://localhost:8001/services/my-service/plugins --data "name=key-auth"
```

`customerId` is the consumer's `custom_id` (`cust_acme`), else `username`, else `id`.

> ⚠ If neither a JWT claim nor a Kong consumer resolves, the request has no customer and is not metered: the plugin skips it and logs `no customer identity resolved`. Bind a consumer (or enable JWT validation) before relying on the data.

### B. Kong's `jwt` plugin verifies the token (`customer_id_jwt_claim`)

Use this when the route already carries Kong's `jwt` plugin and one issuer signs tokens for every caller. On such a route the Kong consumer is the issuer, so billing by consumer would bill all callers as one customer.

```yaml
config:
  customer_id_jwt_claim: tenant_id
  customer_id_jwt_exclude_claims: [impersonated_by]   # optional: tokens not to meter
```

The claim is read from the token Kong's `jwt` plugin stored after verifying the signature. The `Authorization` header is never parsed. In this mode the claim is the only source: no verified token, or no such claim, means no event.

### C. This plugin verifies an Aforo JWT (`jwt_validation_enabled`)

Use this when no Kong auth plugin is on the route and callers present an Aforo-issued RS256 token.

```yaml
config:
  jwt_validation_enabled: true
  jwt_issuer: https://auth.aforo.ai
  jwt_public_key: |
    -----BEGIN PUBLIC KEY-----
    ...
    -----END PUBLIC KEY-----
```

In the access phase the plugin checks, in order: the token is RS256, the signature verifies against the key from `jwt_jwks_uri` (chosen by the token's `kid`) or `jwt_public_key`, `exp` (required) and `nbf`, `iss`, the token's `tenant_id` equals `config.tenant_id`, then revocation. A failure answers 401 (`TENANT_MISMATCH` for a token issued for another tenant). `X-Tenant-Id` sent upstream is always `config.tenant_id`. `customerId` is the token's `customer_id` claim (else `sub`); if the token names neither, the Kong consumer is used.

> `jwt_jwks_uri` works: set it to organization-service's `https://<org host>/.well-known/jwks.json` instead of (or as well as) `jwt_public_key`, and organization-service can rotate its signing key without a Kong config change. The set is cached per worker for `jwt_jwks_cache_ttl` seconds (default 600). A token with an unknown `kid`, or one whose cached key no longer verifies (organization-service makes a new key pair on every start and keeps the `kid`), refreshes it at most every 30 s. While the JWKS cannot be fetched the last good set is used for up to 24 h. With both set, the JWKS key is used first and `jwt_public_key` verifies tokens the JWKS has no key for.

> ⚠ The revocation checks (jti blocklist, revoked `client_id` / `key_id`) refuse the request with 503 when Redis cannot answer within `jwt_redis_timeout_ms` (default 250 ms), including an error reply such as `NOAUTH` or `MOVED`. The keys are read with one `GET` each in one pipelined round trip, so ElastiCache Serverless and cluster proxies that route per key work; one node of a classic Redis Cluster does not. If the blocklist Redis needs a password, set `jwt_redis_password` (it defaults to `rate_limit_redis_password` on the same Redis). Set `jwt_redis_host`/`jwt_redis_port` to a reachable Redis, or `jti_redis_fail_mode: open` to let requests through (logged and counted) as before.

> ⚠ `jwt_allow_unverified_signature: true` lets a token through when the plugin has no key to verify it with. Since 2.2.0 that token grants access only. Its claims are not used for `customerId` or `keyId` unless Kong's `jwt` plugin verified the same token. If you relied on this flag for identity, move to model B.

If you configure both B and C, B decides the customer.

## Step 5 — Send a request and trigger a flush

```bash
curl -H "apikey: acme-secret-key" http://localhost:8000/my-service/anything
```

The buffer flushes when either threshold trips: `flush_count` events buffered (default 50), or `flush_interval_ms` elapsed since the first buffered event (default 5000 ms). For a quick test, lower both:

```bash
curl -X PATCH http://localhost:8001/services/my-service/plugins/<plugin-id> \
  --data "config.flush_count=1"
```

Now a single request flushes immediately.

## Step 6 — Verify it landed in Aforo

Watch the Kong proxy log:

```bash
# tail Kong's proxy error log (path varies by install)
tail -f /usr/local/kong/logs/error.log | grep aforo-metering
```

A successful flush logs:

```
[aforo-metering] Flushed 1 events to Aforo (status=200)
```

> ⚠ That line is logged at `info`. Kong's default `log_level` is `notice`, which hides it: set `KONG_LOG_LEVEL=info` (or `log_level = info` in `kong.conf`) while you verify. Flush failures are logged at `warn` and are visible at the default level.

A failure logs each attempt, then says what happened to the events. They are kept and retried every `flush_interval_ms`:

```
[aforo-metering] Flush attempt 1/3 failed (status=503, err=none)
[aforo-metering] Delivery to https://api.aforo.ai/v1/ingest/batch failed. 1 event(s) re-buffered for retry on the next flush. Repeats suppressed for 60s.
```

A 401, 403 or 404 means the key, its permission or `aforo_endpoint` is wrong, and the log says `The ingestor answered 401 ...`. The newest 500 events refused under that key are kept and retried with that same key, backing off to once every 5 minutes; they go out if the key works again, and are dropped after 72 hours. Events are never re-sent with a different key — see [Rotating the Aforo API key](#rotating-the-aforo-api-key).

Then confirm the event under the matching customer + metric in your Aforo usage view. The metric is the first matching mapping, else `default_metric` (`api_calls` unless you set it).

## Step 7 (optional) — Turn on MCP tool-invocation metering

If the service is an MCP server sold as an MCP product, set `product_type: MCP_SERVER` and its tool-call metric as `default_metric`:

```bash
curl -X PATCH http://localhost:8001/services/my-service/plugins/<plugin-id> \
  --data "config.product_type=MCP_SERVER" \
  --data "config.default_metric=ledger_tool_calls"
```

That is all; the MCP server needs no Aforo code. (`mcp_enabled=true` turns the same parsing on for a route of another product type.) The log phase parses POST bodies (up to 1 MB). Each JSON-RPC `2.0` message with `method: "tools/call"` becomes one `MCP_SERVER` event carrying `toolName`, `agentId`, `sessionId`, `executionStatus` and `executionDurationMs`, with quantity 1. A JSON-RPC batch (an array) gives one event per `tools/call` in it.

- **Agent.** The upstream's `X-Aforo-Agent-Id` response header, else the customer (the Kong consumer or JWT claim): the caller of an MCP server is the agent. `params._meta.agent_id` and the `X-Agent-Id` request header are never read, and neither is `config.agent_id`, which would put every customer under one agent.
- **Session.** The upstream's `X-Aforo-Session-Id` response header, else the `Mcp-Session-Id` the upstream answered with, else none. The client's own `Mcp-Session-Id` request header is not used: Aforo bills MCP session time per session, and a client could rotate it.
- **Metric.** The upstream's `X-Aforo-Metric` response header, else a matching central mapping or `metric_mappings` rule, else `default_metric` on an `MCP_SERVER` product (unless it is still `api_calls`), else `mcp_server.tool_invocations`.
- **Only tool calls are billed.** `initialize`, `tools/list`, `ping` and notifications are MCP plumbing, so they are not metered, and the pre-flight quota check never refuses them. On an `MCP_SERVER` product nothing else is metered either (a `GET` or `DELETE` on the MCP endpoint is session plumbing). On a route of another product type, `config.mcp_meter_non_tool_calls=true` meters the protocol messages as plain API calls, and requests that are not JSON-RPC are metered as usual.
- On a route with `product_type: AI_AGENT`, the agent and session come from config and the upstream only, as described in [Metering an AI agent](#metering-an-ai-agent).

| Response header | Required? | Without it |
|---|---|---|
| `X-Aforo-Agent-Id` | optional | the customer |
| `X-Aforo-Session-Id` / `Mcp-Session-Id` | optional | no session |
| `X-Aforo-Metric` | optional | `default_metric` / mappings |

## Rotating the Aforo API key

Events are always delivered with the key they were buffered under; they never move to another key, tenant or endpoint. So rotate in this order:

1. Create the new key in Aforo.
2. Put it in the plugin's `config.api_key` in Kong. New events use it from then on; events already buffered under the old key are still sent with the old key, which still works.
3. Wait a few `flush_interval_ms` (until the log shows no more flushes for the old key), then revoke the old key in Aforo.

If the old key is revoked first, Aforo refuses the events still buffered under it. The plugin keeps the newest 500 of them under that key and retries them with it, backing off to once every 5 minutes. They are delivered if the old key works again, and dropped after 72 hours. Changing `tenant_id` or `aforo_endpoint` works the same way: events already buffered keep their original tenant and endpoint.

## Configuration reference

See the full option table in [README.md](README.md#configuration). The three you must set: `aforo_endpoint`, `api_key`, `tenant_id`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Shared dict 'aforo_buffer' not available` in logs, no events sent | The `aforo_buffer` shared dict was never declared | Add `nginx_http_lua_shared_dict = aforo_buffer 10m; lua_shared_dict aforo_cache 5m` to `kong.conf` and `kong reload`. |
| `Shared dict 'aforo_cache' is not declared` once per worker | Upgraded to 2.8.0 without the second dict | Caches share `aforo_buffer` with events until you add `lua_shared_dict aforo_cache 5m` (see Step 2). Nothing else changes. |
| JWTs answered 500 `ISSUER_NOT_CONFIGURED` | `jwt_validation_enabled` without `jwt_issuer` (2.8.0) | Set `jwt_issuer` to your token issuer (`https://auth.aforo.ai`), or set `jwt_issuer_check_disabled = true` to accept any issuer. |
| 503 `REVOCATION_CHECK_UNAVAILABLE` after upgrading to 2.8.0 | The revocation lookup now times out after `jwt_redis_timeout_ms` (250 ms for the connect, TLS handshake included, and for the one round trip; was 500 ms per `GET`) | Put Kong near the blocklist Redis, or raise `jwt_redis_timeout_ms`. |
| 503 `REVOCATION_CHECK_UNAVAILABLE`, log shows `MOVED` | `jwt_redis_host` is one node of a classic Redis Cluster; keys on other shards answer `MOVED` and the plugin does not follow redirects | Point `jwt_redis_host` at ElastiCache Serverless or a cluster proxy that routes per key. |
| Margin guard never refuses; log shows `Check failed: timeout` or `Pricing check failed N times in a row` | Pricing does not answer within `margin_guard_timeout_ms` (300 ms), and after 5 failures the breaker stops calling it for 10 s | Check `margin_guard_url` reachability; raise `margin_guard_timeout_ms` for a distant pricing host. The breaker settings are `margin_guard_breaker_threshold` / `margin_guard_breaker_cooldown_s`. |
| Events buffer but never flush | `flush_count` not reached and `flush_interval_ms` not yet elapsed | Wait for the interval, lower `flush_count` to 1 for testing, or send more traffic. |
| Flush logs `status=401` | Wrong `api_key` or `tenant_id` | Re-check the Aforo API key and tenant; both are sent on the flush (`X-API-Key` + `X-Tenant-Id`). |
| Events land in Aforo with empty/missing customer | No Kong consumer bound and no JWT claim | Add an auth plugin (key-auth/JWT) with a consumer, or enable `jwt_validation_enabled`. |
| 401 `TENANT_MISMATCH` | The token was issued for a different Aforo tenant than this plugin's `tenant_id` | Use a token for this tenant, or correct `tenant_id`. |
| 503 `REVOCATION_CHECK_UNAVAILABLE` with `jwt_validation_enabled` | Kong cannot reach the blocklist Redis, AUTH failed, or Redis answered an error (`NOAUTH`, `LOADING`, `MOVED`) | The Kong log says which (`Redis could not answer the jti revocation check at ...`). Set `jwt_redis_host` / `jwt_redis_port` / `jwt_redis_password`; or set `jti_redis_fail_mode: open` to let requests through (logged and counted). |
| 401 `UNSUPPORTED_ALGORITHM` | Token is not RS256 | Issue RS256 tokens, or verify with Kong's `jwt` plugin and use `customer_id_jwt_claim`. |
| No events for a route with `customer_id_jwt_claim` | No verified token on the request, or no such claim | Confirm Kong's `jwt` plugin runs on the route and the token carries the claim. In this mode the claim is the only identity source. |
| 401 `INVALID_SIGNATURE`, log says `No JWKS key to verify a token` | `jwt_jwks_uri` unreachable from Kong, or the token's `kid` is not in the JWKS | Check that Kong can reach `jwt_jwks_uri` and that it serves the issuer's current key. |
| `Delivery to … failed: N event(s) kept for retry` | Ingestor unreachable or returning 5xx | Check `aforo_endpoint` reachability and Aforo status. The events are retried every `flush_interval_ms`, up to 10,000 per buffer (fewer if the shared dict fills up first). A line that says `dropped` means events were lost: the buffer or the dict was full. |
| `The ingestor answered 401` (or 403 / 404) | Wrong or revoked `api_key`, a key without `usage-events:ingest`, or a wrong `aforo_endpoint` | Fix the setting. The newest 500 events refused under the old key stay with that key: they are delivered if it works again, and dropped after 72 hours. New events use the new setting. |
| `Could not buffer an event: shared dict 'aforo_buffer' is full` | The ingestor has been failing for a while, or the dict is small for your traffic | Fix delivery first (see the other flush errors); raise `lua_shared_dict aforo_buffer` if it recurs with a healthy ingestor. |
| `The ingestor rejected N of M event(s)` | Those events are invalid for Aforo (the log gives the reasons, e.g. an unknown metric) | Fix the metric mapping or the upstream header that produced them. They are not retried. |
| Health-check requests show up as billed usage | Path not excluded | They shouldn't — `/health`, `/ready`, `/metrics` are excluded by default. Add yours to `exclude_paths`. |

## What this guide does NOT cover

- **The rate-limit and margin-guard access-phase modules** (`rate-limit-enforce.lua`, `margin-guard.lua`, `preflight-quota.lua`) ship in this folder and are wired into the handler, but their Redis policy schema and pricing-service contract are documented with the Aforo platform, not here. This guide covers metering.
- **JWKS against a live issuer.** The JWKS path is tested with mocked HTTP; it has not been run against organization-service's live JWKS.
- **A live run of the failure paths.** The unit suites (busted, 315 tests in 2.6.0) run against mocks of the Kong PDK. The 2.3.0 commit (`35b2ff3`) records one live run on Kong 3.9 against usage-ingestor `main` in which API, AGENTIC_API, MCP_SERVER, AI_AGENT, GRAPHQL_API, GRPC_API and WEBSOCKET_API events were stored; re-buffering on a 5xx, behaviour with the ingestor unreachable, and buffer loss on restart have not been exercised live.
- **Guaranteed delivery.** Events are buffered in shared memory and lost on a Kong restart. For exactly-once accounting, reconcile against your upstream's own logs.
