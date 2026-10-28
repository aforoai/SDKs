# aforo_metering — Aforo MQTT Metering Plugin for EMQX

A broker-level EMQX 5.x plugin (Erlang/rebar3) that hooks the broker's connect / disconnect / publish / deliver / subscribe / unsubscribe events, counts them per customer per minute, and ships the totals to Aforo's ingestor. Meter MQTT traffic for billing without touching any device or client SDK.

**Version:** 2.0.1 · **EXPERIMENTAL** · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

> ⚠ **Experimental.** This plugin has not been load-tested or run inside a real EMQX broker by Aforo. Its eunit suites run on plain Erlang/OTP (EMQX headers from `emqx_plugin_helper`, a stand-in for EMQX's `emqx_plugins` config store) and against the Aforo mock ingestor. Production-hardening items (load test, release-engineering/CI, dashboard health endpoint) are tracked in [`TODO.md`](TODO.md).

> **Upgrading from 2.0.0?** The config is now top-level keys of the plugin config, not an `aforo_metering { }` block, and is set through the Dashboard or REST API; see [2.0.1](CHANGELOG.md#201--2026-10-28). 2.0.0 read its settings from the wrong place and ran on defaults.
>
> **Upgrading from 0.1.0?** 2.0.0 changes the default customer resolver, aggregates usage per minute and verifies TLS. Read [Upgrading to 2.0.0](CHANGELOG.md#upgrading-to-200) before you install it.

## When to reach for this

Reach for the broker plugin when MQTT is the pub/sub layer you bill on and you need **per-tenant, multi-device** metering. A device-side client SDK only sees one client's traffic; the broker is the one place that sees every device. Hooks only bump in-memory counters: they never send, never wait on the network and never block message delivery.

This is broker-side metering only. It does not authenticate clients, does not gate publishes, and does not enforce quotas — it observes and reports. It relies on EMQX authentication to tell it who a client is.

## Install

This is a broker plugin, not a library — there is no package-registry coordinate. You build the plugin package with rebar3 and install it into your EMQX 5.7+ node. The repo is **not yet published** anywhere public; build from source.

The build follows the official [EMQX plugin template](https://github.com/emqx/emqx-plugin-template): the EMQX headers come from the `emqx_plugin_helper` dependency (no EMQX source tree needed) and `emqx_plugrel` packs the package. Build with the Erlang/OTP major version your EMQX runs (OTP 26 for EMQX 5.7–5.8, OTP 27 for 5.9+); beams built on a newer OTP may not load on an older one.

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-emqx-plugin
rebar3 emqx_plugrel tar
# emits: _build/default/emqx_plugrel/aforo_metering-2.0.1.tar.gz
#        (release.json, README.md, aforo_metering-2.0.1, emqx_plugin_helper-5.9.1, jsone-1.8.1)

rebar3 eunit   # needs only Erlang/OTP (and node, for the mock-ingestor tests)
```

The build checks `priv/config.hocon` (the defaults EMQX installs) against `priv/config_schema.avsc` and fails if they disagree.

Install it with the Dashboard (**Plugins → Install Plugin**, upload the `.tar.gz`), the REST API (`POST /api/v5/plugins/install`), or the CLI. On EMQX 5.9+ a Dashboard/API upload must be allowed first: `emqx ctl plugins allow aforo_metering-2.0.1`. The CLI installs a package already copied into the node's plugin directory (`plugins.install_dir`, default `$EMQX_ROOT/plugins`):

```bash
cp aforo_metering-2.0.1.tar.gz /opt/emqx/plugins/
emqx ctl plugins install aforo_metering-2.0.1
# configure it (see Quickstart step 2), then:
emqx ctl plugins start aforo_metering-2.0.1
emqx ctl plugins list
```

The plugin is addressed by its name and version, `aforo_metering-2.0.1`, everywhere (CLI, REST paths). Until `tenant_id`, `product_id` and `api_key` are set it refuses to start and logs why.

## Quickstart

1. Make EMQX authentication set the customer. With JWT authentication (EMQX 5.7.0+), issue tokens with a `client_attrs` claim; EMQX checks the signature before it trusts the claim:

   ```json
   { "sub": "sensor-42", "client_attrs": { "aforo_customer_id": "cust_acme" } }
   ```

   With HTTP authentication, return `"client_attrs": {"aforo_customer_id": "cust_acme"}` in the success response.

2. Configure the plugin. EMQX keeps the plugin's config in `$EMQX_DATA_DIR/plugins/aforo_metering/config.hocon` (copied from `priv/config.hocon` at install). Change it through the Dashboard's plugin settings form (built from `priv/config_schema.avsc`, where `api_key` is declared as a password input) or the REST API. Fetch the current config, edit it, and send the whole object back:

   ```bash
   EMQX=http://localhost:18083/api/v5
   curl -s -u "$EMQX_API_KEY:$EMQX_API_SECRET" "$EMQX/plugins/aforo_metering-2.0.1/config" > aforo.json
   # edit aforo.json: tenant_id, product_id, api_key (and anything else), then:
   curl -s -u "$EMQX_API_KEY:$EMQX_API_SECRET" -X PUT -H 'Content-Type: application/json' \
        --data @aforo.json "$EMQX/plugins/aforo_metering-2.0.1/config"
   ```

   ```json
   { "tenant_id": "tenant_acme", "product_id": "prod_mqtt_iot_telemetry",
     "api_key": "sk_live_…", "ingestor_url": "https://api.aforo.ai/v1/ingest/batch", "…": "…" }
   ```

   EMQX does not substitute environment variables (`${VAR}`) in plugin config; put the key itself in the config (it is stored on each node's data directory, so protect that directory). The plugin refuses `${…}` values.

   How a change takes effect depends on the EMQX version:

   | EMQX | On a config change |
   |---|---|
   | 5.9+ | The plugin checks it on every node and applies it to the running plugin. A change it refuses is rejected with the reason; nothing is saved. |
   | 5.8 | Applied the same way, but EMQX saves the change even when the plugin refuses it. The running plugin keeps its config and logs `aforo_metering rejected a config change`; the next start uses the saved config if it is valid and refuses it otherwise. |
   | 5.7 | No callback: restart the plugin (`emqx ctl plugins restart aforo_metering-2.0.1`). |

   While running, a change applies without losing queued usage: a new API key, URL or CA is used on the next request and a paused delivery is retried at once; a new queue size is reached by sending, not evicting; a new window length or topic dimension sends the open windows at once as partial windows. `tenant_id` and `product_id` cannot change while running (usage already counted belongs to the current ones): stop the plugin, change them, start it.

3. In Aforo, define the billable units for `mqtt_broker.*` with **SUM** aggregation on quantity. Each usage event carries the number of messages in its window as `quantity`; a COUNT unit would count one per window.

A minute of publishing by one customer becomes one usage event:

```json
{
  "events": [
    {
      "customerId": "cust_acme",
      "metricName": "mqtt_broker.publish",
      "quantity": 1834,
      "occurredAt": "2026-10-27T10:15:00.000Z",
      "idempotencyKey": "mqtt:9f2c…(64 hex)",
      "productType": "MQTT_BROKER",
      "mqttEventType": "PUBLISH",
      "mqttTopic": "#",
      "dataBytes": 234752,
      "metadata": { "sdkVersion": "2.0.1", "productId": "prod_mqtt_iot_telemetry",
                    "aggregationWindowSeconds": 60, "messageCount": 1834 }
    }
  ]
}
```

`occurredAt` is the start of the window. `mqttTopic` is `"#"` (all topics) unless `aggregate_by_topic = true`. QoS and the retain flag stay dimensions (`mqttQos`, `mqttRetained`), so filters on them keep working. `dataBytes` is the summed payload size. The idempotency key is a SHA-256 of tenant, product, broker node, plugin start, window, customer, metric and topic; it is fixed when the event is built and reused on every re-send, so the ingestor never counts a window twice. With `aggregation_window_seconds = 0` every broker event is its own usage event (`quantity` 1, with `mqttClientId`, `mqttQos`, `mqttRetained`).

## Delivery

Delivery follows the same rules as the Aforo SDKs (`aforo-metering-sdks/contract/TRANSPORT-SPEC.md`):

- One process owns the queue; **one request is in flight** at a time, at most `flush_count` (≤ 1000) events, split further if the body would pass 4 MiB.
- `X-API-Key` and `X-Tenant-Id` headers only. TLS server certificates are always verified (CA and hostname); redirects are never followed.
- Network errors, timeouts, 408, 429 and 5xx are retried `max_retries` times with full-jitter backoff (500 ms base, 30 s cap); `Retry-After` is honoured in both forms (capped at 60 s).
- 401, 403 and 3xx are outages, not drops: the key or URL is wrong, and fixing it must not lose the queued usage. Logged at ERROR once per pause.
- After an outage the batch goes back to the front of the queue with the same keys and sending pauses for `max(250 ms, random(0, min(5 min, 5 s · 2ⁿ)))`; the next success resumes it.
- 413 halves the batch. Any other 4xx, and events a 2xx marks `retryable: false`, are dropped and logged. Events marked `retryable: true` are re-sent.
- The queue holds `max_buffer_size` events (counting the batch in flight). Closed windows that don't fit wait in the counter table until there is room, so a slow or failing ingestor fills the counter table before any queued usage is dropped. Once the table reaches `max_aggregation_keys`, usage for NEW (customer, metric, window) keys is dropped and counted; existing keys keep counting.
- On plugin stop, every open window is closed and sent within `shutdown_timeout_ms`; what is left is counted as dropped.

## Hooks and events

| EMQX hook | Aforo `metricName` | `mqttEventType` | Notes |
|---|---|---|---|
| `client.connected` | `mqtt_broker.connect` | `CONNECT` | Resolves and caches the customer |
| `client.disconnected` | `mqtt_broker.disconnect` | `DISCONNECT` | |
| `message.publish` | `mqtt_broker.publish` | `PUBLISH` | `dataBytes` = payload size; publisher resolved via the connect-time cache |
| `message.delivered` | `mqtt_broker.deliver` | `DELIVER` | Counted per recipient; only when `emit_deliver = true` |
| `session.subscribed` | `mqtt_broker.subscribe` | `SUBSCRIBE` | Per topic filter |
| `session.unsubscribed` | `mqtt_broker.unsubscribe` | `UNSUBSCRIBE` | |

All hooks register at `?HP_LOWEST` priority, so they run after EMQX's own processing and never alter delivery. A hook that fails is caught and counted.

## Customer identity

| `customer_resolver` | Source | Notes |
|---|---|---|
| `client_attrs` (default) | Attribute `customer_resolver_client_attr` (default `aforo_customer_id`) in the client attributes EMQX authentication set | EMQX 5.7.0+. Don't also set the attribute from `mqtt.client_attrs_init` using a client-supplied field |
| `http` | Your mapping service: POST `{clientId, username, clientAttrs, tenantId}`, reads `customerId` | `clientId` / `username` are what the client sent, `clientAttrs` what EMQX authentication set — map from `clientAttrs`, or from values your broker auth pins. Runs in a bounded worker pool, never in the client's process; answers (including "none") are cached and retried after the negative TTL, also for clients that only publish; the Aforo API key is never sent to it |
| `username`, `clientid_prefix`, `jwt_unverified` | Values the client chooses (`jwt_unverified` does not check the signature) | The plugin refuses to start unless `unsafe_trust_client_identity = true` |

A client with no resolvable customer is not billed; its events are counted as `aforo.metering.events.unresolved`.

## Configuration

Top-level keys of the plugin config. Defaults are those in `priv/config.hocon`, `priv/config_schema.avsc` and `aforo_metering_config:spec/0` (a test keeps the three equal). Settings with no default are required; the plugin refuses to start until they are set.

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | string | required | Sent as the `X-Tenant-Id` header. Placeholders (`tenant_default`, empty) are refused. Cannot change while running. |
| `product_id` | string | required | Stamped into `metadata.productId`. `prod_mqtt_default` / empty are refused. Cannot change while running. |
| `api_key` | string | required (secret) | Ingestor API key (scope `usage:ingest`), sent as `X-API-Key`. Empty and `${…}` values are refused. Masked in the Dashboard form and in logs. |
| `ingestor_url` | string | required; shipped as `https://api.aforo.ai/v1/ingest/batch` | Must be `https://` (plain `http://` only for localhost / 127.0.0.1 / ::1, or with `allow_insecure_http`). |
| `ca_cert_file` | string | `""` | PEM CA bundle; empty = OS trust store. |
| `allow_insecure_http` | boolean | `false` | Allow `http://` to a non-loopback host. |
| `aggregation_window_seconds` | integer | `60` | Window per usage event; `0` = one event per broker event. |
| `aggregate_by_topic` | boolean | `false` | Keep the topic as a dimension. |
| `max_aggregation_keys` | integer | `100000` | Cap on open counters; new keys over it are dropped and counted. |
| `flush_count` | integer | `500` | Events per request (max 1000). |
| `flush_interval_ms` | integer | `3000` | How often windows close and the queue is sent. |
| `max_buffer_size` | integer | `50000` | Queued usage events (including the batch in flight). Closed windows beyond it wait in the counter table. |
| `request_timeout_ms` / `connect_timeout_ms` | integer | `10000` / `5000` | Total request deadline / connect deadline. |
| `max_retries` | integer | `3` | Retries before the batch is re-queued and sending pauses. |
| `shutdown_timeout_ms` | integer | `5000` | Bound on the drain at plugin stop. |
| `emit_deliver` | boolean | `false` | Count fan-out deliveries. High volume. |
| `exclude_topics` | list | `["$SYS/#", "$share/#"]` | MQTT topic filters (`+`, `#`) not metered. `$SYS/` and `$share/` are always skipped. |
| `customer_resolver` | string | `"client_attrs"` | See Customer identity. |
| `customer_resolver_client_attr` | string | `"aforo_customer_id"` | Attribute name for `client_attrs`. |
| `unsafe_trust_client_identity` | boolean | `false` | Required for `username` / `clientid_prefix` / `jwt_unverified`. |
| `customer_resolver_clientid_separator` | string | `"_"` | `clientid_prefix` separator. |
| `customer_resolver_jwt_claim` | string | `"sub"` | Claim for `jwt_unverified`. |
| `customer_resolver_http_url` | string | `""` | Mapping-service URL (same https rule). |
| `customer_resolver_http_authorization` | string | `""` (secret) | Optional `Authorization` header for the mapping service. |
| `customer_resolver_http_timeout_ms` | integer | `1000` | Per-lookup deadline. |
| `customer_resolver_http_workers` | integer | `4` | Lookups in flight. |
| `customer_resolver_http_queue_size` | integer | `10000` | Queued lookups; over it a lookup is refused and cached as a miss. |
| `customer_resolver_negative_ttl_seconds` | integer | `30` | How long "no customer" / a failed lookup is cached. |
| `customer_resolver_pending_max_seconds` | integer | `300` | How long usage waits for a pending lookup. |

Removed in 2.0.0: `circuit_failure_threshold`, `circuit_cooldown_seconds` (the pause now follows the SDK breaker), and the `jwt` resolver value.

## Walk me through it

Build → install → configure → see your first metered MQTT event land in Aforo: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Authentication / authorization.** The plugin meters; it does not decide who may connect or publish. Pair it with EMQX's own auth.
- **Quota enforcement / margin guard.** No pre-publish gating — this is observe-and-report only.
- **Load-tested throughput numbers.** The 10K/100K msg/sec targets in `TODO.md` have not been run. Don't quote them as guarantees.
- **A run inside EMQX.** The plugin has not been loaded into a real broker. The suites cover reading the config through `emqx_plugin_helper:get_config/1` (both return shapes of `emqx_plugins:get_config/1`) and `on_config_changed/2`, but not EMQX's own install, Avro check or callback dispatch.
- **Usage across a broker restart.** Counters and the queue are in memory; what is open or queued when the node dies (rather than stopping the plugin) is lost. A crash of the flusher process alone keeps the open windows (the supervisor owns the tables) and counts the queued events it loses as dropped.
- **Changing `tenant_id` / `product_id` while running.** Stop the plugin first. On EMQX 5.7 any config change needs a restart.
- **A dashboard health UI.** `aforo_metering:health/0` returns a status map, but the HTTP endpoint to expose it is not built (see `TODO.md`).
