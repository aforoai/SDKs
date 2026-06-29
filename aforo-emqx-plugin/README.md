# Aforo MQTT Metering Plugin for EMQ X

Server-side (broker-level) MQTT metering for EMQ X 5.x. Hooks into the broker's PUBLISH, SUBSCRIBE, UNSUBSCRIBE, CONNECT and DISCONNECT events, batches them in an ETS buffer, and ships to Aforo's usage ingestor in batches.

## Why broker-level?

MQTT is often the only pub/sub layer a customer has — a dedicated client SDK (`@aforo/mqtt-metering` client mode) only sees what that one client does. For accurate **per-tenant multi-device billing** (the norm for IoT), the broker is the authoritative source.

EMQ X supports this via a native Erlang hook plugin. This is the production path; `@aforo/mqtt-metering` broker mode (Aedes) is for dev/small-scale.

## Files

| File | Purpose |
|------|---------|
| `src/aforo_metering.erl` | Main plugin module — registers hooks, buffers events, flushes to ingestor |
| `src/aforo_metering_app.erl` | OTP application entry point |
| `src/aforo_metering_sup.erl` | Supervisor skeleton |
| `priv/emqx_plugins/aforo_metering.hocon` | Default plugin config (edit before build) |
| `rebar.config` | Build manifest (rebar3 compatible) |
| `aforo_metering.app.src` | OTP app resource file |

## Build

```bash
cd emqx-plugin-aforo-metering
rebar3 compile
rebar3 tar
# Outputs: _build/default/rel/aforo_metering/aforo_metering-1.0.0.tar.gz
```

## Test

```bash
cd emqx-plugin-aforo-metering
rebar3 eunit
# Or run only the buffer race-fix tests:
rebar3 eunit --module aforo_metering_buffer_tests
```

`test/aforo_metering_buffer_tests.erl` locks down the race-free
`swap_and_drain/0` invariants introduced in commit `dbb4b3f` (the
late-writer-into-old-table case is the critical one — see the doc
comment on the test for the bug it guards against). Run before
shipping any change to `aforo_metering_buffer.erl`.

## Install

```bash
# Upload to EMQ X dashboard → Plugins → Install From File
#   OR via CLI:
emqx ctl plugins install aforo_metering-1.0.0.tar.gz
emqx ctl plugins start aforo_metering
```

## Configuration

Edit `priv/emqx_plugins/aforo_metering.hocon` before building, or set at runtime via the EMQ X dashboard:

```hocon
aforo_metering {
  tenant_id         = "tenant_acme"
  product_id        = "prod_mqtt_iot_telemetry"
  api_key           = "${AFORO_API_KEY}"
  ingestor_url      = "https://ingestor.aforo.ai/v1/ingest/events"
  flush_count       = 500
  flush_interval_ms = 3000
  emit_deliver      = false
  exclude_topics    = ["$SYS/#", "$share/#"]
}
```

## Hooks registered

| EMQ X hook | Aforo event | Notes |
|------------|-------------|-------|
| `client.connected` | `mqtt_broker.connect` | |
| `client.disconnected` | `mqtt_broker.disconnect` | Carries disconnect reason |
| `message.publish` | `mqtt_broker.publish` | Payload size as dataBytes |
| `message.delivered` | `mqtt_broker.deliver` | Only when `emit_deliver = true` — 1 event per recipient |
| `session.subscribed` | `mqtt_broker.subscribe` | One event per topic filter |
| `session.unsubscribed` | `mqtt_broker.unsubscribe` | |

## Customer-ID resolution

By default the plugin reads the MQTT username as the customer ID. To change this, edit `aforo_customer_id/2` in `aforo_metering.erl`:

```erlang
%% Example: extract customer ID from client ID prefix "cust_<id>_<device>"
aforo_customer_id(ClientInfo, _ConnInfo) ->
    case maps:get(clientid, ClientInfo, undefined) of
        <<"cust_", Rest/binary>> ->
            [CustomerId | _] = binary:split(Rest, <<"_">>),
            CustomerId;
        _ -> undefined
    end.
```

Clients with no resolvable customer ID are not metered.

## Status

**Scaffold — ready for integration work.** The Erlang hook module in `src/aforo_metering.erl` is the minimal viable implementation covering all 5 hook types with buffered flushing. Production hardening (ETS retention policy, backpressure under flush failure, prometheus metrics) is documented in `TODO.md`.

## License

MIT
