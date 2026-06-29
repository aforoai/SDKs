# kong-plugin-aforo-metering — User Guide

**Version:** 2.0.0 · **Updated:** 2026-06-29 · **Audience:** engineers running Kong Gateway (OSS or Enterprise) who want API usage metered into Aforo.

## What you'll build

A Kong service with the `aforo-metering` plugin enabled, capturing one usage event per proxied request in the `log` phase and batch-shipping them to Aforo. By the end you'll see your events land in Aforo with the request method, path, status, and latency attached.

## Prerequisites

- A running Kong Gateway (3.x) you can reload, with Admin API access (or declarative config you can edit).
- LuaRocks on the Kong host (to build the plugin from source).
- An Aforo API key and tenant id. The plugin sends events to `https://ingest.aforo.ai/v1/ingest/batch` by default — override `aforo_endpoint` per environment.
- For MCP metering: a route that proxies JSON-RPC `tools/call` POST bodies.

## Step 1 — Install the plugin from source

Not yet on LuaRocks, so build it from the rockspec in this folder:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/kong
luarocks install lua-resty-http
luarocks make kong-plugin-aforo-metering-2.0.0-1.rockspec
```

`luarocks make` reads `kong-plugin-aforo-metering-2.0.0-1.rockspec` and installs the `kong.plugins.aforo-metering.handler` and `.schema` modules.

## Step 2 — Register the plugin and the shared buffer

In `kong.conf`:

```
plugins = bundled,aforo-metering
nginx_http_lua_shared_dict = aforo_buffer 10m
```

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
  --data "config.aforo_endpoint=https://ingest.aforo.ai/v1/ingest/batch" \
  --data "config.api_key=$AFORO_API_KEY" \
  --data "config.tenant_id=$AFORO_TENANT_ID"
```

The same in declarative `kong.yml`:

```yaml
plugins:
  - name: aforo-metering
    service: my-service
    config:
      aforo_endpoint: https://ingest.aforo.ai/v1/ingest/batch
      api_key: ${AFORO_API_KEY}
      tenant_id: ${AFORO_TENANT_ID}
```

> ⚠ `api_key` is sent as `Authorization: Bearer <api_key>` and `tenant_id` as the `X-Tenant-Id` header **only on the flush to Aforo** — neither is read from inbound client requests. Customer identity comes from the Kong consumer (or a validated JWT claim), never from a request header.

## Step 4 — Attach a customer identity

`customer_id_source` is `consumer` and accepts only that. To attribute usage to a customer, bind a Kong consumer to the request credential (key-auth, JWT, etc.) so `kong.client.get_consumer()` resolves. Example with key-auth:

```bash
# Create a consumer and a key
curl -X POST http://localhost:8001/consumers --data "username=acme-corp" --data "custom_id=cust_acme"
curl -X POST http://localhost:8001/consumers/acme-corp/key-auth --data "key=acme-secret-key"

# Enable key-auth on the same service
curl -X POST http://localhost:8001/services/my-service/plugins --data "name=key-auth"
```

The event's `customerId` becomes the consumer's `custom_id` (`cust_acme`), falling back to `username`, then `id`.

> ⚠ If neither a JWT claim nor a Kong consumer resolves, `customerId` is `nil`. The event still buffers, but Aforo's ingestor rejects events without a `customerId` at schema validation. Bind a consumer (or enable JWT validation) before relying on the data.

To use a validated JWT claim instead, set `config.jwt_validation_enabled=true` and `config.jwt_issuer`; when present, the JWT's `customer_id` claim wins over the consumer identity. See the Configuration reference for the JWT options.

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

A failure logs the attempt count and dropped-event count:

```
[aforo-metering] Flush attempt 1/3 failed (status=401, err=none)
[aforo-metering] All 3 flush attempts failed. 1 events dropped.
```

Then confirm the event under the matching customer + metric in your Aforo usage view. The metric name follows `metric_name_pattern` — by default `GET /my-service/anything`.

## Step 7 (optional) — Turn on MCP tool-invocation metering

If the service proxies an MCP server, set `mcp_enabled=true`:

```bash
curl -X PATCH http://localhost:8001/services/my-service/plugins/<plugin-id> \
  --data "config.mcp_enabled=true" \
  --data "config.mcp_product_id=$AFORO_MCP_PRODUCT_ID"
```

The log phase parses POST bodies, and any JSON-RPC `2.0` request with `method: "tools/call"` emits a `mcp_server.tool_invocations` event carrying `toolName`, `sessionId` (from `Mcp-Session-Id`), and `executionStatus`.

> ⚠ `agentId` is taken from the JSON-RPC payload at `params._meta.agent_id` only. The plugin will not read an `X-Agent-Id` request header for the agent — that path was removed in 2.0.0 because the header is client-settable.

## Configuration reference

See the full option table in [README.md](README.md#configuration). The three you must set: `aforo_endpoint`, `api_key`, `tenant_id`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Shared dict 'aforo_buffer' not available` in logs, no events sent | The `aforo_buffer` shared dict was never declared | Add `nginx_http_lua_shared_dict = aforo_buffer 10m` to `kong.conf` and `kong reload`. |
| Events buffer but never flush | `flush_count` not reached and `flush_interval_ms` not yet elapsed | Wait for the interval, lower `flush_count` to 1 for testing, or send more traffic. |
| Flush logs `status=401` | Wrong `api_key` or `tenant_id` | Re-check the Aforo API key and tenant; both are sent on the flush (`Authorization` + `X-Tenant-Id`). |
| Events land in Aforo with empty/missing customer | No Kong consumer bound and no JWT claim | Add an auth plugin (key-auth/JWT) with a consumer, or enable `jwt_validation_enabled`. |
| `lua-resty-jwt not found; RS256 signature NOT verified` warning | `jwt_validation_enabled=true` but the lib isn't installed | `luarocks install lua-resty-jwt`, or use Kong Enterprise's native JWT plugin and leave validation off here. Claims checks (exp/iss/jti/revocation) still run regardless. |
| `All 3 flush attempts failed. N events dropped.` | Ingestor unreachable or returning 5xx for the full retry window | Check `aforo_endpoint` reachability and Aforo status; these events are not re-queued after the third attempt. |
| Health-check requests show up as billed usage | Path not excluded | They shouldn't — `/health`, `/ready`, `/metrics` are excluded by default. Add yours to `exclude_paths`. |

## What this guide does NOT cover

- **The rate-limit and margin-guard access-phase modules** (`rate-limit-enforce.lua`, `margin-guard.lua`, `preflight-quota.lua`) ship in this folder and are wired into the handler, but their Redis policy schema and pricing-service contract are documented with the Aforo platform, not here. This guide covers metering.
- **Full RS256 verification setup** with a JWKS fetcher — the handler supports a `jwt_public_key` PEM and a `jwt_jwks_uri`, but production key rotation/fetching is an integration you wire with `lua-resty-jwt` or Kong Enterprise. See the inline notes in `handler.lua`.
- **Guaranteed delivery.** This is fire-and-forget metering. For exactly-once accounting, reconcile against your upstream's own logs.
