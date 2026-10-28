# aforo_metering — User Guide

**Version:** 2.0.3 (EXPERIMENTAL) · **Updated:** 2026-10-28 · **Audience:** platform/infra engineers running an EMQX 5.x broker who need per-tenant MQTT metering for Aforo billing.

## What you'll build

An EMQX 5.x node with the `aforo_metering` plugin installed and started, reporting connect/publish/subscribe traffic to Aforo's ingestor. By the end you'll have published MQTT messages and confirmed the matching `mqtt_broker.publish` usage event reached Aforo.

## Prerequisites

- **EMQX 5.7.0 or later** for the default `client_attrs` resolver (earlier 5.x releases don't set client attributes from authentication). The plugin uses EMQX 5.x hook APIs — it will not load on 4.x.
- **Erlang/OTP and rebar3** of the major version your EMQX runs (OTP 26 for EMQX 5.7–5.8, OTP 27 for 5.9+). No EMQX source tree: the headers come from the `emqx_plugin_helper` dependency.
- **EMQX REST API credentials** (an API key/secret from Dashboard → System → API Keys) or Dashboard access, to configure the plugin.
- An **Aforo API key**, **tenant ID**, and **product ID** for an MQTT-broker product. The three values you need: `ingestor_url`, `api_key`, `tenant_id` (`product_id` rides along in event metadata).
- **EMQX authentication that identifies the customer** — JWT or HTTP authentication setting a `client_attrs` attribute (Step 4). The plugin will not bill a value the client chooses unless you opt in by name.
- **Billable units with SUM aggregation** on the `mqtt_broker.*` metrics you price: each usage event carries a window's message count as `quantity`.

## Step 1 — Build the plugin package

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-emqx-plugin
rebar3 emqx_plugrel tar
```

This emits `_build/default/emqx_plugrel/aforo_metering-2.0.2.tar.gz` with a `release.json` that EMQX reads at install. The package name, the release version and the plugin `vsn` are all `2.0.2`; EMQX addresses the plugin as `aforo_metering-2.0.2`. Don't edit config before packaging — configure it on the broker (Step 3).

## Step 2 — Install

```bash
# Dashboard: Plugins → Install Plugin → upload the .tar.gz.
#   On EMQX 5.9+ allow the upload first: emqx ctl plugins allow aforo_metering-2.0.2
# Or via CLI on the node (the package must be in plugins.install_dir, default $EMQX_ROOT/plugins):
cp aforo_metering-2.0.2.tar.gz /opt/emqx/plugins/
emqx ctl plugins install aforo_metering-2.0.2
```

Installing copies the plugin's default config (`priv/config.hocon`) to `$EMQX_DATA_DIR/plugins/aforo_metering/config.hocon` and loads its schema (`priv/config_schema.avsc`). The defaults leave `tenant_id`, `product_id` and `api_key` empty, so the plugin will not start yet.

## Step 3 — Configure and start

Set the required values through the Dashboard's plugin settings form, or with the REST API — read the config, edit it, write the whole object back:

```bash
EMQX=http://localhost:18083/api/v5
AUTH="$EMQX_API_KEY:$EMQX_API_SECRET"
curl -s -u "$AUTH" "$EMQX/plugins/aforo_metering-2.0.2/config" > aforo.json
```

```json
{
  "tenant_id": "tenant_acme",
  "product_id": "prod_mqtt_iot_telemetry",
  "api_key": "sk_live_…",
  "ingestor_url": "https://api.aforo.ai/v1/ingest/batch",
  "customer_resolver": "client_attrs",
  "customer_resolver_client_attr": "aforo_customer_id",
  "aggregation_window_seconds": 60,
  "flush_count": 500,
  "flush_interval_ms": 3000,
  "emit_deliver": false
}
```

(keep the other keys `aforo.json` already has), then:

```bash
curl -s -u "$AUTH" -X PUT -H 'Content-Type: application/json' \
     --data @aforo.json "$EMQX/plugins/aforo_metering-2.0.2/config"
emqx ctl plugins start aforo_metering-2.0.2
emqx ctl plugins list      # confirm aforo_metering-2.0.2 is running
```

> ⚠ EMQX does not substitute environment variables in plugin config. Put the key itself in the config; the plugin refuses empty, placeholder and `${…}` values. The config is stored in each node's data directory — restrict access to it.

The plugin checks the configuration at start and refuses to load on a missing or placeholder `tenant_id` / `product_id` / `api_key`, on a client-chosen identity source without `unsafe_trust_client_identity = true`, on an `http://` URL to a non-local host, or when no CA certificates are available. Each reason is logged as `aforo_metering refused to start: invalid configuration`.

**Changing the config later.** On EMQX 5.8+ a change made through the Dashboard or REST API is applied to the running plugin with no usage lost (new key/URL/CA on the next request, on fresh connections for a new URL or CA; a paused delivery retried at once; a new flush interval at once; open windows sent as partial windows when the window length changes). What happens to a change the plugin refuses depends on the EMQX version:

| EMQX | Refused change (invalid value) | New `tenant_id` / `product_id` while running |
|---|---|---|
| 5.9+ | Rejected with the reason; nothing applied or saved. | Rejected as a whole; nothing applied or saved. |
| 5.8 | **Saved anyway** (5.8 ignores the plugin's answer) but never applied. Logged at error (`refused a config change that EMQX saved anyway`, with the keys), gauge `aforo.metering.config.invalid` = 1, `config_problem` in `aforo_metering:health()`. **The next start fails until you fix those keys** with another change. | Saved; the other keys of the change are applied, the plugin keeps the current tenant/product until it is stopped and started (logged at error, gauge set). |
| 5.7 | No callback: restart the plugin (`emqx ctl plugins restart aforo_metering-2.0.2`); the config is checked at start. | Same: takes effect at the restart. |

On 5.9+ an accepted change is applied before EMQX saves it; if the save fails, the running plugin keeps the new values until it restarts and then reads the saved (old) config. Each node checks and applies the change on its own and EMQX does not undo the other nodes when one fails, so cluster nodes can run different configs — check every node's log after a change.

## Step 4 — Let EMQX authentication say who the customer is

A usage event needs a `customerId`. The plugin takes it from what EMQX authentication verified, so a device cannot bill its traffic to someone else.

**JWT authentication (EMQX 5.7.0+).** Configure EMQX's JWT authenticator and issue tokens with a `client_attrs` claim. EMQX verifies the signature before the claim becomes a client attribute:

```json
{ "sub": "sensor-42", "exp": 1830000000, "client_attrs": { "aforo_customer_id": "cust_acme" } }
```

**HTTP authentication.** Return the attribute in the success response:

```json
{ "result": "allow", "client_attrs": { "aforo_customer_id": "cust_acme" } }
```

> ⚠ Don't also populate `aforo_customer_id` through `mqtt.client_attrs_init` from a field the client sends (username, client id, user property). That makes the value client-chosen again.

Other resolvers:

| `customer_resolver` | Where the customer ID comes from | Needs |
|---|---|---|
| `client_attrs` (default) | Client attribute set by EMQX authentication | `customer_resolver_client_attr` (default `aforo_customer_id`) |
| `http` | Your mapping service: POST `{clientId, username, clientAttrs, tenantId}`, reads `customerId` (map from `clientAttrs`, which EMQX authentication set) | `customer_resolver_http_url`; optional `customer_resolver_http_authorization` |
| `username` | MQTT CONNECT username | `unsafe_trust_client_identity = true` |
| `clientid_prefix` | `cust_<id>_<rest>` parsed from the client ID | `unsafe_trust_client_identity = true` |
| `jwt_unverified` | A claim in MQTT 5 Authentication-Data, **signature not checked** | `unsafe_trust_client_identity = true` |

Set `unsafe_trust_client_identity = true` only when broker authentication already ties that value to one customer (for example, username/password authentication where each username belongs to one customer).

The `http` resolver runs in a worker pool, never in the client's process: CONNECT does not wait for your service. Usage recorded while a lookup is pending is held under the client ID (up to `customer_resolver_pending_max_seconds`) and attributed when the answer arrives; a reconnect waits for its own answer (it never inherits the previous connection's customer). "No customer" answers and failed lookups are cached for `customer_resolver_negative_ttl_seconds`, then retried — also from `message.publish`, so a device that only publishes recovers after a mapping-service blip.

> ⚠ On `message.publish` the hook only receives the client identifier, so the publisher's customer comes from the connect-time cache. A client that publishes without `client.connected` firing after the plugin started (persistent sessions across a plugin restart) is not billed until it reconnects; its messages count as `aforo.metering.events.unresolved`.

## Step 5 — Send a test message and verify it landed

Publish a few messages with a client whose authentication sets the customer (any MQTT client; `mosquitto_pub` with a JWT as the password is shown):

```bash
for i in 1 2 3; do
  mosquitto_pub -h localhost -p 1883 \
    -i "sensor-42" -u "sensor-42" -P "<jwt with client_attrs>" \
    -t "sensors/temp" -m '{"c":22.5}'
done
```

Usage is counted per minute: the window closes one second after the minute ends and is sent on the next flush tick (`flush_interval_ms`). Wait about a minute, or call `aforo_metering:flush_now().` from the remote console to close finished windows and send immediately. Then confirm the event reached Aforo two ways:

**a) From the broker — the health map:** Call `aforo_metering:health/0` from an EMQX remote console (`emqx remote_console`):

```erlang
aforo_metering:health().
%% => #{plugin => <<"aforo_metering">>, version => <<"2.0.3">>,
%%      tenant_id => <<"tenant_acme">>, buffer_depth => 0,
%%      open_aggregation_keys => 0, circuit_state => <<"closed">>,
%%      counters => #{'aforo.metering.events.buffered' => 3,
%%                    'aforo.metering.events.flushed' => 3, ...}}
```

`events.buffered` counts broker events recorded; `events.flushed` counts usage events the ingestor accepted (one per customer, metric and window). `circuit_state => <<"closed">>` means delivery is not paused.

**b) In Aforo:** Open the tenant's usage/ingestion view and filter to `metricName = mqtt_broker.publish` for `productId = prod_mqtt_iot_telemetry`. You should see one event for `customerId = cust_acme` with `quantity = 3`, `mqttTopic = #` and `dataBytes` equal to the summed payload sizes.

If `buffer_depth` keeps climbing and `events.flushed` stays at 0, the ingestor isn't accepting the batch — go to Troubleshooting.

## Configuration reference

Every key, with defaults, is listed in the [README](README.md#configuration), commented in `priv/config.hocon` and typed in `priv/config_schema.avsc`.

How a change reaches the running plugin, and what EMQX 5.7, 5.8 and 5.9+ do with a change the plugin refuses, is in **Changing the config later** under Step 3.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Plugin won't start; log shows `aforo_metering refused to start` | `tenant_id`, `product_id` or `api_key` is not set (or still a placeholder), the config still uses the 2.0.0 `aforo_metering { }` wrapper, or the configuration names a client-chosen identity source without `unsafe_trust_client_identity`, uses `customer_resolver = "jwt"` (removed in 2.0.0), uses `http://` for a non-local host, or no CA certificates are available. | Fix what the logged reason names. For JWT, configure EMQX's JWT authenticator with a `client_attrs` claim and use `client_attrs`. |
| `events.unresolved` climbs, nothing in Aforo | Clients connect without the customer attribute (authentication doesn't set `client_attrs.aforo_customer_id`), or the http resolver answers "none". | Check the token / HTTP-auth response carries `client_attrs`. In the remote console, `aforo_metering_customer_resolver:lookup(<<"sensor-42">>).` shows what the plugin resolved. |
| `events.buffered` climbs, `events.flushed` stays 0 | Ingestor unreachable or rejecting the batch (bad `api_key`, wrong `ingestor_url`, network, TLS). | Check the EMQX log for `aforo_metering delivery paused` and `aforo_metering ingestor rejected batch`. Verify `api_key` and `ingestor_url` in the plugin config and that the URL is reachable from the node. |
| Log: `ingestor refused the API key` | 401/403 from the ingestor. Usage is kept and re-sent. | Fix the key; delivery resumes on the next attempt with nothing lost (until `max_buffer_size` is reached). |
| Log: `answered with a redirect, which is never followed` | `ingestor_url` points at a host that redirects. | Use the final URL (`https://api.aforo.ai/v1/ingest/batch`). |
| TLS errors (`unknown_ca`, `hostname_check_failed`) | The ingestor's certificate isn't trusted, or doesn't match the host. | For a private CA set `ca_cert_file`; make sure `ingestor_url` uses the certificate's host name. |
| Billed quantity looks ~60× too low | The billable unit uses COUNT. Each usage event is a window total. | Use SUM on quantity, or set `aggregation_window_seconds = 0` (one event per message). |
| `circuit_state => <<"open">>` in `health/0` | The last send ended in an outage. Sending pauses 5 s, doubling up to 5 min. | Fix the cause; `aforo_metering:flush_now().` forces one attempt now. |
| `events.dropped` is non-zero | Queue overflow during an outage, a rejected batch, `max_aggregation_keys` reached, or the shutdown deadline. | The log says which. Raise `max_buffer_size` / `max_aggregation_keys` if you need headroom — a memory trade-off. |
| Log: `aforo_metering could not read its plugin config` | EMQX could not hand the plugin its config (not installed through EMQX, or the config file is unreadable). | Reinstall through EMQX (Step 2) and set the config through the Dashboard or REST API. |
| Log: `aforo_metering rejected a config change` | The new config is invalid (reason logged), or it changes `tenant_id` / `product_id` while the plugin runs. | Fix the reason; for tenant/product, stop the plugin, change them, start it. |
| Log: `aforo_metering refused a config change that EMQX saved anyway`, or `aforo.metering.config.invalid` = 1 (EMQX 5.8) | 5.8 saved a config the plugin refused. The plugin still runs on its previous config, but its next start will fail. | Fix the keys the log names with another config change (the gauge returns to 0). |
| Log: `aforo_metering cannot change tenant_id / product_id while running` (EMQX 5.8) | 5.8 saved a new tenant/product; the plugin keeps the current ones. | Stop and start the plugin to switch, or change them back. |
| Plugin won't load on EMQX 4.x | The hooks are EMQX 5.x APIs. | Run on EMQX 5.x (5.7.0+ for `client_attrs`). |

## What this guide does NOT cover

- **Production hardening status.** Load testing, CI, GPG-signed releases, online upgrade (`code_change/3`), and a dashboard health endpoint are tracked in [`TODO.md`](TODO.md) — several are unbuilt. This guide gets you to a working PoC, not a hardened production rollout.
- **The metrics module internals.** `aforo_metering_metrics` wires counters through `emqx_metrics`, scrapeable at `/api/v5/prometheus/stats` — but configuring your Prometheus/Grafana stack is your monitoring stack's concern.
- **EMQX clustering specifics.** Each node aggregates and ships its own clients' traffic. Keys include the node name, so two nodes never collide; adding the totals across nodes is the ingestor's job.
- **A run inside a real EMQX broker.** 2.0.2 is tested on plain Erlang/OTP (EMQX headers from `emqx_plugin_helper`, a stand-in for EMQX's plugin-config store) and against the Aforo mock ingestor. EMQX's own install, schema check and callback dispatch have not been exercised.
