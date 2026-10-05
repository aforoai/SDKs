# kong-plugin-aforo-metering — User Guide

**Version:** 2.2.0 · **Updated:** 2026-10-02 · **Audience:** engineers running Kong Gateway (OSS or Enterprise) who want API usage metered into Aforo.

## What you'll build

A Kong service with the `aforo-metering` plugin enabled, capturing one usage event per proxied request in the `log` phase and batch-shipping them to Aforo. By the end you'll see your events land in Aforo with the request method, path, status, and latency attached.

## Prerequisites

- A running Kong Gateway (3.x) you can reload, with Admin API access (or declarative config you can edit).
- LuaRocks on the Kong host (to build the plugin from source).
- An Aforo API key and tenant id. Production events go to `https://api.aforo.ai/v1/ingest/batch` (`aforo_endpoint` is required; set it per environment).
- For MCP metering: a route that proxies JSON-RPC `tools/call` POST bodies.

## Step 1 — Install the plugin from source

Not yet on LuaRocks, so build it from the rockspec in this folder:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/kong
luarocks install lua-resty-http
luarocks make kong-plugin-aforo-metering-2.2.0-1.rockspec
```

`luarocks make` reads `kong-plugin-aforo-metering-2.2.0-1.rockspec` and installs the `handler`, `schema`, `rate-limit-enforce`, `margin-guard`, `preflight-quota` and `compound-metering` modules under `kong.plugins.aforo-metering.*`.

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
  -e KONG_ADMIN_LISTEN=0.0.0.0:8001 \
  -p 8000:8000 -p 8001:8001 kong-aforo:3.4
```

The `Dockerfile` sets `KONG_PLUGINS` and the `aforo_buffer` shared dict for you. Verify:

```bash
curl -s http://localhost:8001/ | grep -o aforo-metering
```

### Local development: mounting the plugin from source

Rebuilding the image for every edit is slow. Mount the source over the installed copy instead — edit a `.lua` file, `docker restart kong`, done:

```bash
cd SDKs/aforo-gateway-plugins/kong
docker run -d --name kong --network=kong-net \
  -e KONG_DATABASE=postgres -e KONG_PG_HOST=kong-database \
  -e KONG_PG_USER=kong -e KONG_PG_PASSWORD=kong \
  -e KONG_ADMIN_LISTEN=0.0.0.0:8001 \
  -v "$PWD:/usr/local/share/lua/5.1/kong/plugins/aforo-metering:ro" \
  -p 8000:8000 -p 8001:8001 kong-aforo:3.4
```

Still based on `kong-aforo:3.4`, because the mount only replaces the plugin; `lua-resty-http` still has to come from the image.

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
otherwise fail the whole batch.

Configurable via `metric_header` / `quantity_header`; set either to empty to disable.

### Resolution order

1. `metric_header` from the upstream response
2. first matching rule fetched from `mappings_url` (EXACT / PREFIX / CONTAINS on the path)
3. first matching `metric_mappings` rule
4. `metric_name_pattern`, only if set to something other than `{method} {path}` (a fixed name such as `platform_api_calls`, or a template)
5. `default_metric`

Existing deployments that set a custom `metric_name_pattern` keep working unchanged.

MCP, gRPC, GraphQL and WebSocket events use fixed metric names (`mcp_server.tool_invocations`, `grpc_api.rpc_calls`, `graphql_api.operations`, `websocket_api.connection_opened`); the mappings apply to plain HTTP events.

### Fetching the rules from Aforo

Set `mappings_url` to your catalog's gateway-mappings endpoint and the plugin reads the rules you declared on each metric, so a new metric needs no gateway change. The fetch runs in a background timer with `mappings_timeout_ms` (3 s); requests only read the cached table. One worker fetches at a time, a failed fetch is retried after `mappings_refresh_seconds`, and the last good table keeps being used.

### What happens to a metric name Aforo does not know

The plugin cannot see your catalog. A name that is blank or longer than 255 characters is dropped at the gateway (`invalid_metric`). A well-formed name that is not a catalog metric is sent, refused by the ingestor for that event only, and counted as `ingestor_rejected` with the ingestor's message in the Kong log. Neither is retried. Watch `aforo_dropped:ingestor_rejected` after changing mappings.

## Step 2 — Register the plugin and the shared buffer

In `kong.conf`:

```
plugins = bundled,aforo-metering
nginx_http_lua_shared_dict = aforo_buffer 10m
lua_ssl_verify_depth = 3
```

> ⚠ `lua_ssl_verify_depth` is not optional when `aforo_endpoint` is `https://` — which it is in production. Kong defaults it to `1`, too shallow for an ordinary leaf → intermediate → root chain, and every flush then fails with `20: unable to get local issuer certificate`. That message reads like a missing CA bundle and is not one: Kong already trusts the system store via `lua_ssl_trusted_certificate`, so installing certificates changes nothing. Only the depth does. Events are re-buffered rather than lost, so the symptom is a stalled pipeline rather than an outage.

> ⚠ The shared dict is not optional. The log phase buffers events into the `aforo_buffer` dict and a timer flushes them. Without the dict line, every request logs `Shared dict 'aforo_buffer' not available` and the event is dropped. In a raw nginx template the equivalent directive is `lua_shared_dict aforo_buffer 10m;`.

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

> ⚠ `api_key` is sent as the `X-API-Key` header (never `Authorization: Bearer`, which the ingestor rejects 401) and `tenant_id` as the `X-Tenant-Id` header **only on the flush to Aforo** — neither is read from inbound client requests. Customer identity comes from the Kong consumer (or a validated JWT claim), never from a request header.

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

In the access phase the plugin checks, in order: the token is RS256, the signature verifies against `jwt_public_key`, `exp` (required) and `nbf`, `iss`, then revocation. A failure answers 401. `customerId` is the token's `customer_id` claim (else `sub`); if the token names neither, the Kong consumer is used.

> ⚠ `jwt_jwks_uri` is accepted and not used: there is no JWKS fetch. Without `jwt_public_key` every token is rejected. For rotating keys use model B.

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

A refused batch logs the status and the ingestor's answer, and is not retried:

```
[aforo-metering] Flush attempt 1/3 failed (status=401, err=none)
[aforo-metering] Ingestor rejected the batch with 401 -- dropping 1 event(s) rather than retrying them forever.
```

A transient failure (network, 5xx, 408, 429) is retried up to three times, honouring `Retry-After` on 429 up to 30 seconds, then the batch goes back into the buffer for the next flush with the same idempotency keys.

Then confirm the event under the matching customer + metric in your Aforo usage view. The metric is `api_calls` unless a mapping or `metric_name_pattern` says otherwise.

## Step 7 (optional) — Turn on MCP tool-invocation metering

If the service proxies an MCP server, set `mcp_enabled=true`:

```bash
curl -X PATCH http://localhost:8001/services/my-service/plugins/<plugin-id> \
  --data "config.mcp_enabled=true" \
  --data "config.mcp_product_id=$AFORO_MCP_PRODUCT_ID"
```

The log phase parses POST bodies, and any JSON-RPC `2.0` request with `method: "tools/call"` emits a `mcp_server.tool_invocations` event carrying `toolName`, `sessionId` (from `Mcp-Session-Id`), and `executionStatus`.

`agentId` is read from the JSON-RPC payload at `params._meta.agent_id`, else from the `X-Agent-Id` request header. Both are supplied by the caller. A tool call with no agent id is sent with the configured `product_type` instead of `MCP_SERVER`, which requires one.

## Configuration reference

See the full option table in [README.md](README.md#configuration). The three you must set: `aforo_endpoint`, `api_key`, `tenant_id`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Shared dict 'aforo_buffer' not available` in logs, no events sent | The `aforo_buffer` shared dict was never declared | Add `nginx_http_lua_shared_dict = aforo_buffer 10m` to `kong.conf` and `kong reload`. |
| Events buffer but never flush | `flush_count` not reached and `flush_interval_ms` not yet elapsed | Wait for the interval, lower `flush_count` to 1 for testing, or send more traffic. |
| Flush logs `status=401` or `403` | Wrong `api_key`, or the key lacks `usage:ingest` | Re-check the Aforo API key. It is sent as `X-API-Key`. |
| No events for a route, log says `no verified customer identity` (debug level) | No identity model resolved | See Step 4. With `customer_id_jwt_claim`, confirm Kong's `jwt` plugin runs on the route and the token carries the claim. |
| 401 `INVALID_SIGNATURE` with `jwt_validation_enabled` | `jwt_public_key` missing, not the issuer's key, or a private key | Set the issuer's PEM public key. `jwt_jwks_uri` alone verifies nothing. |
| 401 `UNSUPPORTED_ALGORITHM` | Token is not RS256 | Issue RS256 tokens, or verify with Kong's `jwt` plugin and use `customer_id_jwt_claim`. |
| `Ingestor refused N of M event(s) in an accepted batch` | Usually a metric name that is not in the catalog | Fix `metric_mappings` / `default_metric` / `metric_name_pattern`; add the metric in Aforo. |
| `All flush attempts failed. N events re-buffered` | Ingestor unreachable or returning 5xx | Check `aforo_endpoint` reachability. Events stay buffered (up to 10,000) and are retried. |
| Health-check requests show up as billed usage | Path not excluded | `/health`, `/ready`, `/metrics` are excluded by default; a configured `exclude_paths` replaces that list, so include them again. |

## What this guide does NOT cover

- **The rate-limit and margin-guard access-phase modules** (`rate-limit-enforce.lua`, `margin-guard.lua`, `preflight-quota.lua`) ship in this folder and are wired into the handler, but their Redis policy schema and pricing-service contract are documented with the Aforo platform, not here. This guide covers metering.
- **JWKS and key rotation.** In-plugin verification takes one PEM key. Rotating keys belong to Kong's `jwt` plugin (model B).
- **A real Kong run of this release.** The unit suite runs against mocks of the Kong PDK; the Docker image in this folder has not been exercised against a live ingestor for 2.2.0.
- **Guaranteed delivery.** Events are buffered in shared memory and lost on a Kong restart. For exactly-once accounting, reconcile against your upstream's own logs.
