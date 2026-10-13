# kong-plugin-aforo-metering — User Guide

**Version:** 2.1.0 · **Updated:** 2026-10-12 · **Audience:** engineers running Kong Gateway (OSS or Enterprise) who want API usage metered into Aforo.

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
luarocks make kong-plugin-aforo-metering-2.1.0-1.rockspec
```

`luarocks make` reads `kong-plugin-aforo-metering-2.1.0-1.rockspec` and installs the `handler`, `schema`, `rate-limit-enforce`, `margin-guard`, `preflight-quota`, `compound-metering`, `event-buffer` and `event-util` modules under `kong.plugins.aforo-metering.*`.

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

Still based on `kong-aforo:3.4`, because the mount only replaces the plugin's code — `KONG_PLUGINS` and the `aforo_buffer` shared dict still come from the image.

## Choosing what each endpoint bills as

The plugin's legacy default, `metric_name_pattern = "{method} {path}"`, produces one
metric per endpoint — `GET /api/products`, `POST /api/sms/v2/send`. Aforo rejects any
metric not registered in the catalog, so out of the box every event fails.

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
2. first matching `metric_mappings` rule
3. `metric_name_pattern`, only if explicitly set to something other than the default
4. `default_metric`

Existing deployments that set a custom `metric_name_pattern` keep working unchanged.

### Metering an AI agent

If the service behind Kong is an AI agent, bill it as `AI_AGENT`. Aforo needs two
values on every AI agent event that Kong cannot see for itself: which agent did the
work (`agentId`) and which session the request belongs to (`sessionId`). The plugin
takes both from your plugin config or your upstream's response only. It never reads
them from the client's request, because a client can set a request header to anything.

1. Set `product_type: AI_AGENT` on the agent's service or route.
2. Name the agent. Set `agent_id` in the plugin config (simplest when one service is
   one agent), or have the upstream send `X-Aforo-Agent-Id: <agent id>` on its response.
   If both are present, the response header wins.
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

is metered as `agentId: fraud-shield-agent`, `sessionId: sess-42`, `quantity: 2100`.

If neither `agent_id` nor the response header supplies an agent ID, the event is not
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
> to `agent_id`, each request becomes its own session, and the quantity falls back to 1.

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

`customer_id_source` is `consumer` and accepts only that. To attribute usage to a customer, bind a Kong consumer to the request credential (key-auth, JWT, etc.) so `kong.client.get_consumer()` resolves. Example with key-auth:

```bash
# Create a consumer and a key
curl -X POST http://localhost:8001/consumers --data "username=acme-corp" --data "custom_id=cust_acme"
curl -X POST http://localhost:8001/consumers/acme-corp/key-auth --data "key=acme-secret-key"

# Enable key-auth on the same service
curl -X POST http://localhost:8001/services/my-service/plugins --data "name=key-auth"
```

The event's `customerId` becomes the consumer's `custom_id` (`cust_acme`), falling back to `username`, then `id`.

> ⚠ If neither a JWT claim nor a Kong consumer resolves, the request has no customer and is not metered: the plugin skips it and logs `no customer identity resolved`. Bind a consumer (or enable JWT validation) before relying on the data.

To use a validated JWT claim instead, set `config.jwt_validation_enabled=true`, `config.jwt_issuer`, and the key that verifies the signature: `config.jwt_public_key` (a PEM) or `config.jwt_jwks_uri` (the issuer's JWKS URL, keys picked by `kid`). The JWT's `customer_id` claim then wins over the consumer identity. The token's `tenant_id` must equal `config.tenant_id`; a token issued for another tenant is rejected with 401 `TENANT_MISMATCH`. If the revocation Redis needs a password, set `config.jwt_redis_password`. See the Configuration reference for the JWT options.

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

A failure logs each attempt, then says what happened to the events. They are kept and retried every `flush_interval_ms`:

```
[aforo-metering] Flush attempt 1/3 failed (status=503, err=none)
[aforo-metering] Delivery to https://api.aforo.ai/v1/ingest/batch failed. 1 event(s) re-buffered for retry on the next flush. Repeats suppressed for 60s.
```

A 401, 403 or 404 means the key, its permission or `aforo_endpoint` is wrong, and the log says `The ingestor answered 401 ...`. The newest 1,000 events for that destination (none older than 72 hours) are kept; once you fix the setting they go out with the new key or endpoint.

Then confirm the event under the matching customer + metric in your Aforo usage view. The metric name follows `metric_name_pattern` — by default `GET /my-service/anything`.

## Step 7 (optional) — Turn on MCP tool-invocation metering

If the service proxies an MCP server, set `mcp_enabled=true`:

```bash
curl -X PATCH http://localhost:8001/services/my-service/plugins/<plugin-id> \
  --data "config.mcp_enabled=true" \
  --data "config.mcp_product_id=$AFORO_MCP_PRODUCT_ID"
```

The log phase parses POST bodies (up to 1 MB). Each JSON-RPC `2.0` message with `method: "tools/call"` becomes one event carrying `toolName`, `sessionId` (from the `Mcp-Session-Id` header), `executionStatus` and `executionDurationMs`. A JSON-RPC batch (an array) gives one event per `tools/call` in it.

- **Agent.** `agentId` is taken from `params._meta.agent_id`, else the upstream's `X-Aforo-Agent-Id` response header, else `config.agent_id`. The `X-Agent-Id` request header is never read: the client can set it to anything. With an agent the event is sent as `MCP_SERVER`; without one it keeps `product_type`.
- **Metric.** The upstream's `X-Aforo-Metric` response header, else a matching central mapping or `metric_mappings` rule, else `mcp_server.tool_invocations`.
- **Protocol messages are not billed.** `initialize`, `tools/list`, `ping` and notifications are MCP plumbing, so they are not metered. Set `config.mcp_meter_non_tool_calls=true` to meter them as plain API calls. Requests on the route that are not JSON-RPC are metered as usual.
- On a route with `product_type: AI_AGENT`, the agent and session come from config and the upstream only, as described in [Metering an AI agent](#metering-an-ai-agent).

## Configuration reference

See the full option table in [README.md](README.md#configuration). The three you must set: `aforo_endpoint`, `api_key`, `tenant_id`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Shared dict 'aforo_buffer' not available` in logs, no events sent | The `aforo_buffer` shared dict was never declared | Add `nginx_http_lua_shared_dict = aforo_buffer 10m` to `kong.conf` and `kong reload`. |
| Events buffer but never flush | `flush_count` not reached and `flush_interval_ms` not yet elapsed | Wait for the interval, lower `flush_count` to 1 for testing, or send more traffic. |
| Flush logs `status=401` | Wrong `api_key` or `tenant_id` | Re-check the Aforo API key and tenant; both are sent on the flush (`X-API-Key` + `X-Tenant-Id`). |
| Events land in Aforo with empty/missing customer | No Kong consumer bound and no JWT claim | Add an auth plugin (key-auth/JWT) with a consumer, or enable `jwt_validation_enabled`. |
| 401 `TENANT_MISMATCH` | The token was issued for a different Aforo tenant than this plugin's `tenant_id` | Use a token for this tenant, or correct `tenant_id`. |
| 401 `INVALID_SIGNATURE`, log says `No JWKS key to verify a token` | `jwt_jwks_uri` unreachable from Kong, or the token's `kid` is not in the JWKS | Check that Kong can reach `jwt_jwks_uri` and that it serves the issuer's current key. |
| Log says `Redis answered the JWT revocation lookup with an error (NOAUTH ...)` | The blocklist Redis needs a password | Set `jwt_redis_password`. Until then, revoked tokens are not rejected. |
| `Delivery to … failed. N event(s) re-buffered` | Ingestor unreachable or returning 5xx | Check `aforo_endpoint` reachability and Aforo status. The events are retried every `flush_interval_ms`, up to 10,000 per destination (fewer if the shared dict fills up first). |
| `The ingestor answered 401` (or 403 / 404) | Wrong or revoked `api_key`, a key without `usage-events:ingest`, or a wrong `aforo_endpoint` | Fix the setting. Meanwhile the newest 1,000 events for that destination, none older than 72 hours, are kept and go out with the new settings once fixed. |
| `Shared dict 'aforo_buffer' is full of buffered events` | The ingestor has been failing for a while, or the dict is small for your traffic | Fix delivery first (see the other flush errors); raise `lua_shared_dict aforo_buffer` if it recurs with a healthy ingestor. |
| `The ingestor rejected N of M event(s)` | Those events are invalid for Aforo (the log gives the reasons, e.g. an unknown metric) | Fix the metric mapping or the upstream header that produced them. They are not retried. |
| Health-check requests show up as billed usage | Path not excluded | They shouldn't — `/health`, `/ready`, `/metrics` are excluded by default. Add yours to `exclude_paths`. |

## What this guide does NOT cover

- **The rate-limit and margin-guard access-phase modules** (`rate-limit-enforce.lua`, `margin-guard.lua`, `preflight-quota.lua`) ship in this folder and are wired into the handler, but their Redis policy schema and pricing-service contract are documented with the Aforo platform, not here. This guide covers metering.
- **Guaranteed delivery.** This is fire-and-forget metering. For exactly-once accounting, reconcile against your upstream's own logs.
