# aforo_metering — User Guide

**Version:** 2.0.0 (EXPERIMENTAL) · **Updated:** 2026-10-27 · **Audience:** platform/infra engineers running an EMQX 5.x broker who need per-tenant MQTT metering for Aforo billing.

## What you'll build

An EMQX 5.x node with the `aforo_metering` plugin installed and started, reporting connect/publish/subscribe traffic to Aforo's ingestor. By the end you'll have published MQTT messages and confirmed the matching `mqtt_broker.publish` usage event reached Aforo.

## Prerequisites

- **EMQX 5.7.0 or later** for the default `client_attrs` resolver (earlier 5.x releases don't set client attributes from authentication). The plugin uses EMQX 5.x hook APIs — it will not load on 4.x.
- **Erlang/OTP 25+ and rebar3**, matching the OTP version your EMQX release uses, plus an EMQX source checkout or build for its headers.
- An **Aforo API key**, **tenant ID**, and **product ID** for an MQTT-broker product. The three values you need: `ingestor_url`, `api_key`, `tenant_id` (`product_id` rides along in event metadata).
- **EMQX authentication that identifies the customer** — JWT or HTTP authentication setting a `client_attrs` attribute (Step 4). The plugin will not bill a value the client chooses unless you opt in by name.
- **Billable units with SUM aggregation** on the `mqtt_broker.*` metrics you price: each usage event carries a window's message count as `quantity`.

## Step 1 — Build the release tarball

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-emqx-plugin
ERL_LIBS=/path/to/emqx/_build/emqx/lib rebar3 compile   # EMQX headers must be on the path
rebar3 tar
```

This emits `_build/default/rel/aforo_metering/aforo_metering-2.0.0.tar.gz`. The tarball version and the plugin `vsn` are both `2.0.0`.

## Step 2 — Configure before you package (recommended)

The config file `priv/emqx_plugins/aforo_metering.hocon` is copied into the release by the `overlay` in `rebar.config`. Edit it **before** `rebar3 tar` so the tarball ships with your values, or edit `etc/plugins/aforo_metering.hocon` on the node afterward and restart the plugin.

```hocon
aforo_metering {
  tenant_id    = "tenant_acme"
  product_id   = "prod_mqtt_iot_telemetry"
  api_key      = "${AFORO_API_KEY}"
  ingestor_url = "https://api.aforo.ai/v1/ingest/batch"

  customer_resolver             = "client_attrs"
  customer_resolver_client_attr = "aforo_customer_id"

  aggregation_window_seconds = 60
  flush_count                = 500
  flush_interval_ms          = 3000
  emit_deliver               = false
}
```

The plugin checks the configuration at start and refuses to load on a client-chosen identity source without `unsafe_trust_client_identity = true`, on an `http://` URL to a non-local host, or when no CA certificates are available. Each reason is logged as `aforo_metering refused to start: invalid configuration`.

> ⚠ Keep `api_key` out of the file. Use `${AFORO_API_KEY}` and set the env var on the EMQX node — the HOCON `${VAR}` substitution reads the broker process environment, so it must be exported in the EMQX node's environment, not just your shell.

## Step 3 — Install and start

```bash
# Dashboard: Plugins → Install From File → upload the tarball → Start.
# Or via CLI on the node:
emqx ctl plugins install aforo_metering-2.0.0.tar.gz
emqx ctl plugins start aforo_metering
emqx ctl plugins list      # confirm aforo_metering shows running, vsn 2.0.0
```

On load the plugin logs a structured line with the live config — grep the EMQX log for `aforo_metering plugin loaded` to confirm `tenant_id`, `product_id`, `customer_resolver` and `aggregation_window_ms` are what you set:

```bash
grep "aforo_metering plugin loaded" /path/to/emqx/log/emqx.log
```

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
%% => #{plugin => <<"aforo_metering">>, version => <<"2.0.0">>,
%%      tenant_id => <<"tenant_acme">>, buffer_depth => 0,
%%      open_aggregation_keys => 0, circuit_state => <<"closed">>,
%%      counters => #{'aforo.metering.events.buffered' => 3,
%%                    'aforo.metering.events.flushed' => 3, ...}}
```

`events.buffered` counts broker events recorded; `events.flushed` counts usage events the ingestor accepted (one per customer, metric and window). `circuit_state => <<"closed">>` means delivery is not paused.

**b) In Aforo:** Open the tenant's usage/ingestion view and filter to `metricName = mqtt_broker.publish` for `productId = prod_mqtt_iot_telemetry`. You should see one event for `customerId = cust_acme` with `quantity = 3`, `mqttTopic = #` and `dataBytes` equal to the summed payload sizes.

If `buffer_depth` keeps climbing and `events.flushed` stays at 0, the ingestor isn't accepting the batch — go to Troubleshooting.

## Configuration reference

Every key, with defaults, is listed in the [README](README.md#configuration) and commented in `priv/emqx_plugins/aforo_metering.hocon`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Plugin won't start; log shows `aforo_metering refused to start` | The configuration names a client-chosen identity source without `unsafe_trust_client_identity`, uses `customer_resolver = "jwt"` (removed in 2.0.0), uses `http://` for a non-local host, or no CA certificates are available. | Fix what the logged reason names. For JWT, configure EMQX's JWT authenticator with a `client_attrs` claim and use `client_attrs`. |
| `events.unresolved` climbs, nothing in Aforo | Clients connect without the customer attribute (authentication doesn't set `client_attrs.aforo_customer_id`), or the http resolver answers "none". | Check the token / HTTP-auth response carries `client_attrs`. In the remote console, `aforo_metering_customer_resolver:lookup(<<"sensor-42">>).` shows what the plugin resolved. |
| `events.buffered` climbs, `events.flushed` stays 0 | Ingestor unreachable or rejecting the batch (bad `api_key`, wrong `ingestor_url`, network, TLS). | Check the EMQX log for `aforo_metering delivery paused` and `aforo_metering ingestor rejected batch`. Verify `${AFORO_API_KEY}` is exported on the node and the URL is reachable. |
| Log: `ingestor refused the API key` | 401/403 from the ingestor. Usage is kept and re-sent. | Fix the key; delivery resumes on the next attempt with nothing lost (until `max_buffer_size` is reached). |
| Log: `answered with a redirect, which is never followed` | `ingestor_url` points at a host that redirects. | Use the final URL (`https://api.aforo.ai/v1/ingest/batch`). |
| TLS errors (`unknown_ca`, `hostname_check_failed`) | The ingestor's certificate isn't trusted, or doesn't match the host. | For a private CA set `ca_cert_file`; make sure `ingestor_url` uses the certificate's host name. |
| Billed quantity looks ~60× too low | The billable unit uses COUNT. Each usage event is a window total. | Use SUM on quantity, or set `aggregation_window_seconds = 0` (one event per message). |
| `circuit_state => <<"open">>` in `health/0` | The last send ended in an outage. Sending pauses 5 s, doubling up to 5 min. | Fix the cause; `aforo_metering:flush_now().` forces one attempt now. |
| `events.dropped` is non-zero | Queue overflow during an outage, a rejected batch, `max_aggregation_keys` reached, or the shutdown deadline. | The log says which. Raise `max_buffer_size` / `max_aggregation_keys` if you need headroom — a memory trade-off. |
| `${AFORO_API_KEY}` shows up literally / 401 from ingestor | The env var wasn't set in the **EMQX node's** environment when HOCON resolved it. | Export `AFORO_API_KEY` for the broker process (systemd unit, container env) and restart the plugin. |
| Plugin won't load on EMQX 4.x | The hooks are EMQX 5.x APIs. | Run on EMQX 5.x (5.7.0+ for `client_attrs`). |

## What this guide does NOT cover

- **Production hardening status.** Load testing, CI, GPG-signed releases, online upgrade (`code_change/3`), and a dashboard health endpoint are tracked in [`TODO.md`](TODO.md) — several are unbuilt. This guide gets you to a working PoC, not a hardened production rollout.
- **The metrics module internals.** `aforo_metering_metrics` wires counters through `emqx_metrics`, scrapeable at `/api/v5/prometheus/stats` — but configuring your Prometheus/Grafana stack is your monitoring stack's concern.
- **EMQX clustering specifics.** Each node aggregates and ships its own clients' traffic. Keys include the node name, so two nodes never collide; adding the totals across nodes is the ingestor's job.
- **A run inside a real EMQX broker.** 2.0.0 is tested on plain Erlang/OTP with stand-ins for the EMQX headers and against the Aforo mock ingestor.
