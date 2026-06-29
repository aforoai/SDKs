# aforo_metering — Aforo MQTT Metering Plugin for EMQX

A broker-level EMQX 5.x plugin (Erlang/rebar3) that hooks the broker's connect / disconnect / publish / deliver / subscribe / unsubscribe events, buffers them in ETS, and ships batched usage events to Aforo's ingestor. Meter MQTT traffic for billing without touching any device or client SDK.

**Version:** 0.1.0 · **EXPERIMENTAL** · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

> ⚠ **Experimental.** This plugin has not been load-tested or run on the EMQX marketplace path. It is a working scaffold suitable for a proof-of-concept on EMQX 5.x. Production-hardening items (load test, release-engineering/CI, dashboard health endpoint) are tracked in [`TODO.md`](TODO.md). Treat it as pre-1.0: APIs, config keys, and event shape can change.

## When to reach for this

Reach for the broker plugin when MQTT is the pub/sub layer you bill on and you need **per-tenant, multi-device** metering. A device-side client SDK only sees one client's traffic; the broker is the one place that sees every device. The plugin runs in the hook (post-event) path and never blocks message delivery — a flush failure re-buffers, it does not back-pressure the broker.

This is broker-side metering only. It does not authenticate clients, does not gate publishes, and does not enforce quotas — it observes and reports.

## Install

This is a broker plugin, not a library — there is no package-registry coordinate. You build a release tarball with rebar3 and install it into your EMQX 5.x node. The repo is **not yet published** anywhere public; build from source.

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-emqx-plugin
rebar3 compile
rebar3 tar
# emits: _build/default/rel/aforo_metering/aforo_metering-<rel-vsn>.tar.gz
```

> The release tarball is named from `rebar.config`'s `relx` release version (currently `aforo_metering-1.0.0.tar.gz`). The plugin's declared application version (`vsn` in `aforo_metering.app.src`) is `0.1.0` — that is the version this documentation tracks. The build-version mismatch is harmless for install; `emqx ctl plugins list` shows the `vsn`.

Install the tarball into EMQX 5.x via the dashboard (**Plugins → Install From File**) or the CLI:

```bash
emqx ctl plugins install aforo_metering-1.0.0.tar.gz
emqx ctl plugins start aforo_metering
```

## Quickstart

Set the three values every Aforo artifact needs, then start the plugin. Edit `priv/emqx_plugins/aforo_metering.hocon` **before** `rebar3 tar` (it is copied into the release), or edit `etc/plugins/aforo_metering.hocon` on the node and restart the plugin:

```hocon
aforo_metering {
  tenant_id    = "tenant_acme"
  product_id   = "prod_mqtt_iot_telemetry"
  api_key      = "${AFORO_API_KEY}"
  ingestor_url = "https://ingest.aforo.ai/v1/ingest/batch"
}
```

```bash
# AFORO_API_KEY must be in the EMQX node's environment for ${AFORO_API_KEY} to resolve.
export AFORO_API_KEY="sk_live_..."
emqx ctl plugins start aforo_metering
```

Every metered MQTT event is shipped as one element of an `events[]` batch:

```json
{
  "events": [
    {
      "customerId": "device-user-7",
      "metricName": "mqtt_broker.publish",
      "quantity": 1,
      "occurredAt": "2026-06-29T10:15:42.318Z",
      "idempotencyKey": "mqtt:tenant_acme:sensor-42:PUBLISH:sensors/temp:1751191542318:a1b2c3d4",
      "productType": "MQTT_BROKER",
      "mqttEventType": "PUBLISH",
      "mqttClientId": "sensor-42",
      "mqttTopic": "sensors/temp",
      "mqttQos": 1,
      "mqttRetained": false,
      "dataBytes": 128,
      "metadata": { "sdkVersion": "1.0.0", "productId": "prod_mqtt_iot_telemetry" }
    }
  ]
}
```

> The `metadata.sdkVersion` field is hard-coded in the source (`?SDK_VERSION = <<"1.0.0">>`) and is independent of the plugin's `vsn`. It identifies the event-shape contract, not the package release.

The batch is POSTed with `Authorization: Bearer <api_key>` and `X-Tenant-Id: <tenant_id>`. Identity is resolved server-side by the plugin, never from a client-settable MQTT header.

## Hooks and events

| EMQX hook | Aforo `metricName` | `mqttEventType` | Notes |
|---|---|---|---|
| `client.connected` | `mqtt_broker.connect` | `CONNECT` | |
| `client.disconnected` | `mqtt_broker.disconnect` | `DISCONNECT` | Carries `disconnectReason` |
| `message.publish` | `mqtt_broker.publish` | `PUBLISH` | `dataBytes` = payload size; publisher resolved via the connect-time cache |
| `message.delivered` | `mqtt_broker.deliver` | `DELIVER` | One event per recipient; emitted only when `emit_deliver = true` |
| `session.subscribed` | `mqtt_broker.subscribe` | `SUBSCRIBE` | One event per topic filter |
| `session.unsubscribed` | `mqtt_broker.unsubscribe` | `UNSUBSCRIBE` | |

All hooks register at `?HP_LOWEST` priority, so they run after EMQX's own processing and never alter delivery.

## Configuration

All keys live under the `aforo_metering { ... }` HOCON block. Defaults are the source-code defaults (`aforo_metering.erl` `get_cfg/2`).

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | string | `"tenant_default"` | Sent as the `X-Tenant-Id` header. Your Aforo tenant. |
| `product_id` | string | `"prod_mqtt_default"` | Stamped into `metadata.productId`. The Aforo product this broker reports as. |
| `api_key` | string | `""` | Bearer token for the ingestor. Use `${AFORO_API_KEY}` and keep it out of the file. |
| `ingestor_url` | string | `https://ingestor.aforo.ai/v1/ingest/events` | The ingestor endpoint. Set to `https://ingest.aforo.ai/v1/ingest/batch` for the standard batch ingestor, or your per-environment override. |
| `flush_count` | integer | `500` | Flush when this many events are buffered (or `flush_interval_ms`, whichever first). |
| `flush_interval_ms` | integer | `3000` | Max milliseconds between flushes of a partial batch. |
| `emit_deliver` | boolean | `false` | Emit one event per fan-out delivery. High volume — enable only for per-subscriber-delivery pricing. |
| `exclude_topics` | list | `["$SYS/#", "$share/#"]` | Topic filters to skip. (System + shared topics are skipped in code regardless.) |
| `max_buffer_size` | integer | `50000` | ETS buffer cap. When hit, the oldest 50% are dropped and counted via `aforo.metering.events.dropped`. Bounds memory under sustained ingestor failure. |
| `circuit_failure_threshold` | integer | `5` | Consecutive flush failures before the circuit opens (POSTs skipped, events re-buffered). |
| `circuit_cooldown_seconds` | integer | `60` | How long the circuit stays open before a half-open probe. |
| `customer_resolver` | string | `"username"` | How customer ID is derived from CONNECT info: `username`, `clientid_prefix`, `jwt`, or `http`. See the user guide. |
| `customer_resolver_clientid_separator` | string | `"_"` | Separator for `clientid_prefix` (`cust<sep><id><sep><rest>` → `<id>`). |
| `customer_resolver_jwt_claim` | string | `"sub"` | JWT claim to read for the customer ID (`jwt` resolver). |
| `customer_resolver_http_url` | string | `""` | Auth-service URL for the `http` resolver. |

## Walk me through it

Build → install → configure → see your first metered MQTT event land in Aforo: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Authentication / authorization.** The plugin meters; it does not decide who may connect or publish. Pair it with EMQX's own auth.
- **Quota enforcement / margin guard.** No pre-publish gating — this is observe-and-report only.
- **Load-tested throughput numbers.** The 10K/100K msg/sec targets in `TODO.md` have not been run. Don't quote them as guarantees.
- **A dashboard health UI.** `aforo_metering:health/0` returns a status map, but the HTTP endpoint to expose it is not built (see `TODO.md`).
