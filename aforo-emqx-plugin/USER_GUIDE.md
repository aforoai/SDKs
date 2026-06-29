# aforo_metering — User Guide

**Version:** 0.1.0 (EXPERIMENTAL) · **Updated:** 2026-06-29 · **Audience:** platform/infra engineers running an EMQX 5.x broker who need per-tenant MQTT metering for Aforo billing.

## What you'll build

An EMQX 5.x node with the `aforo_metering` plugin installed and started, reporting connect/publish/subscribe traffic to Aforo's ingestor. By the end you'll have published one MQTT message and confirmed the matching `mqtt_broker.publish` event reached Aforo.

## Prerequisites

- **EMQX 5.x** running locally or on a node you can install plugins onto. (The plugin uses EMQX 5.x hook APIs — it will not load on 4.x.)
- **Erlang/OTP + rebar3** to build the release tarball. Match the OTP version your EMQX build expects.
- An **Aforo API key**, **tenant ID**, and **product ID** for an MQTT-broker product. The three values you need: `ingestor_url`, `api_key`, `tenant_id` (`product_id` rides along in event metadata).
- A `customer_id` strategy: by default the plugin uses the MQTT CONNECT username. Decide this before you go live (Step 4).

## Step 1 — Build the release tarball

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-emqx-plugin
rebar3 compile
rebar3 tar
```

This emits `_build/default/rel/aforo_metering/aforo_metering-1.0.0.tar.gz`.

> ⚠ The tarball filename carries the `relx` release version (`1.0.0`), not the plugin's `vsn` (`0.1.0`). They're independent. `emqx ctl plugins list` reports the `vsn` — `0.1.0` — which is the version that matters for "what's running."

## Step 2 — Configure before you package (recommended)

The config file `priv/emqx_plugins/aforo_metering.hocon` is copied into the release by the `overlay` in `rebar.config`. Edit it **before** `rebar3 tar` so the tarball ships with your values, or edit `etc/plugins/aforo_metering.hocon` on the node afterward and restart the plugin.

```hocon
aforo_metering {
  tenant_id    = "tenant_acme"
  product_id   = "prod_mqtt_iot_telemetry"
  api_key      = "${AFORO_API_KEY}"
  ingestor_url = "https://ingest.aforo.ai/v1/ingest/batch"

  flush_count       = 500
  flush_interval_ms = 3000
  emit_deliver      = false
  exclude_topics    = ["$SYS/#", "$share/#"]
}
```

> ⚠ Keep `api_key` out of the file. Use `${AFORO_API_KEY}` and set the env var on the EMQX node — the HOCON `${VAR}` substitution reads the broker process environment, so it must be exported in the EMQX node's environment, not just your shell.

## Step 3 — Install and start

```bash
# Dashboard: Plugins → Install From File → upload the tarball → Start.
# Or via CLI on the node:
emqx ctl plugins install aforo_metering-1.0.0.tar.gz
emqx ctl plugins start aforo_metering
emqx ctl plugins list      # confirm aforo_metering shows running, vsn 0.1.0
```

On load the plugin logs a structured line with the live config — grep the EMQX log for `aforo_metering plugin loaded` to confirm `tenant_id`, `product_id`, `flush_count`, and `customer_resolver` are what you set:

```bash
grep "aforo_metering plugin loaded" /path/to/emqx/log/emqx.log
```

## Step 4 — Choose how a client maps to a customer

A metered event needs a `customerId`. A client whose customer ID can't be resolved is **not metered** (silently skipped) — so getting this right is the difference between billing and dropping data. Set `customer_resolver`:

| `customer_resolver` | Where the customer ID comes from | Extra config |
|---|---|---|
| `username` (default) | MQTT CONNECT username | — |
| `clientid_prefix` | `cust_<id>_<rest>` parsed from the client ID | `customer_resolver_clientid_separator` (default `_`) |
| `jwt` | A claim in the JWT carried in MQTT 5 CONNECT Authentication-Data | `customer_resolver_jwt_claim` (default `sub`) |
| `http` | POST `{clientId, username, tenantId}` to your auth service; reads `customerId` from the response | `customer_resolver_http_url` |

> ⚠ On `message.publish` the hook only receives the client identifier, not full CONNECT info, so the publisher's customer ID is read from the connect-time cache. A client that publishes without ever firing `client.connected` (rare, but possible with persistent sessions across a plugin restart) is skipped. Resolution is cached per `(tenant, clientid)` and invalidated on disconnect.

## Step 5 — Send a test message and verify it landed

Publish one message (any MQTT client; `mosquitto_pub` shown). Use a username that your resolver maps to a known customer:

```bash
mosquitto_pub \
  -h localhost -p 1883 \
  -u "device-user-7" -P "<mqtt-password>" \
  -i "sensor-42" \
  -t "sensors/temp" \
  -m '{"c":22.5}'
```

Wait up to `flush_interval_ms` (3s) — or publish `flush_count` (500) messages to force an immediate flush. Then confirm the event reached Aforo two ways:

**a) From the broker — the health map:** Call `aforo_metering:health/0` from an EMQX remote console (`emqx remote_console`):

```erlang
aforo_metering:health().
%% => #{plugin => <<"aforo_metering">>, version => <<"1.0.0">>,
%%      tenant_id => <<"tenant_acme">>, buffer_depth => 0,
%%      circuit_state => <<"closed">>,
%%      counters => #{'aforo.metering.events.flushed' => 1,
%%                    'aforo.metering.flush.success' => 1, ...}}
```

`events.flushed` ≥ 1 and `circuit_state => <<"closed">>` means the batch was accepted. (`version` here is the `?SDK_VERSION` event-contract string, not the plugin `vsn`.)

**b) In Aforo:** Open the tenant's usage/ingestion view and filter to `metricName = mqtt_broker.publish` for `productId = prod_mqtt_iot_telemetry`. You should see one event for `customerId = device-user-7` with `mqttTopic = sensors/temp` and `dataBytes` matching your payload size.

If `buffer_depth` keeps climbing and `flush.success` stays at 0, the ingestor isn't accepting the batch — go to Troubleshooting.

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | string | `"tenant_default"` | `X-Tenant-Id` header value. |
| `product_id` | string | `"prod_mqtt_default"` | Stamped into `metadata.productId`. |
| `api_key` | string | `""` | Ingestor Bearer token. Use `${AFORO_API_KEY}`. |
| `ingestor_url` | string | `https://ingestor.aforo.ai/v1/ingest/events` | Ingestor endpoint. Standard batch ingestor: `https://ingest.aforo.ai/v1/ingest/batch`. |
| `flush_count` | integer | `500` | Buffered-event count that triggers a flush. |
| `flush_interval_ms` | integer | `3000` | Max ms between partial-batch flushes. |
| `emit_deliver` | boolean | `false` | One event per fan-out delivery. High volume. |
| `exclude_topics` | list | `["$SYS/#", "$share/#"]` | Topic filters to skip. |
| `max_buffer_size` | integer | `50000` | ETS cap; oldest 50% dropped + counted on overflow. |
| `circuit_failure_threshold` | integer | `5` | Consecutive failures before the circuit opens. |
| `circuit_cooldown_seconds` | integer | `60` | Open-circuit cooldown before a half-open probe. |
| `customer_resolver` | string | `"username"` | `username` \| `clientid_prefix` \| `jwt` \| `http`. |
| `customer_resolver_clientid_separator` | string | `"_"` | Separator for `clientid_prefix`. |
| `customer_resolver_jwt_claim` | string | `"sub"` | JWT claim for the `jwt` resolver. |
| `customer_resolver_http_url` | string | `""` | Auth-service URL for the `http` resolver. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No events in Aforo, `events.buffered` is 0 | The publisher's customer ID didn't resolve — clients with no resolvable customer ID are not metered. | Confirm the MQTT username (or your chosen resolver source) maps to a customer. Check the resolver config matches how your devices connect. |
| `events.buffered` climbs, `flush.success` stays 0 | Ingestor unreachable or rejecting the batch (bad `api_key`, wrong `ingestor_url`, network). | Check the EMQX log for `aforo_metering flush retry`. Verify `api_key` resolved (it's `${AFORO_API_KEY}` — is the var exported on the node?) and `ingestor_url` is reachable from the broker. |
| `circuit_state => <<"open">>` in `health/0` | `circuit_failure_threshold` consecutive flush failures tripped the breaker. | Fix the underlying ingestor/auth problem. After `circuit_cooldown_seconds` the circuit half-opens and probes; one success closes it. |
| `events.dropped` is non-zero | Buffer hit `max_buffer_size` during a sustained flush outage; oldest 50% dropped to bound memory. | Restore ingestor connectivity. Raise `max_buffer_size` if your outage window needs more headroom — but it's a memory trade-off, not free. |
| `${AFORO_API_KEY}` shows up literally / 401 from ingestor | The env var wasn't set in the **EMQX node's** environment when HOCON resolved it. | Export `AFORO_API_KEY` for the broker process (systemd unit, container env, or `emqx.conf` env) and restart the plugin. |
| Plugin won't load on EMQX 4.x | The hooks (`?HP_LOWEST`, `emqx_hooks:add/4`) are EMQX 5.x APIs. | Run on EMQX 5.x. There is no 4.x build. |
| Publish events missing but connect/subscribe present | Persistent sessions surviving a plugin restart can publish before re-firing `client.connected`, so the publisher isn't in the cache. | Restart affected clients, or use a resolver (`clientid_prefix` / `jwt`) that doesn't depend on the connect-time cache. |

## What this guide does NOT cover

- **Production hardening status.** Load testing, CI, GPG-signed releases, online upgrade (`code_change/3`), and a dashboard health endpoint are tracked in [`TODO.md`](TODO.md) — several are unbuilt. This guide gets you to a working PoC, not a hardened production rollout.
- **The metrics module internals.** `aforo_metering_metrics` wires counters through `emqx_metrics`, scrapeable at `/api/v5/prometheus/stats` — but configuring your Prometheus/Grafana stack is your monitoring stack's concern.
- **EMQX clustering specifics.** Each node runs its own buffer and ships independently; cross-node aggregation is the ingestor's job, not the plugin's.
