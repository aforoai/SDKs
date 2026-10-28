# mqtt-metering-go — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** Go engineers metering MQTT usage from the client/device side.

## What you'll build

A Go MQTT client that emits one Aforo billing event per MQTT action — `CONNECT`, `SUBSCRIBE`, `PUBLISH`, `UNSUBSCRIBE`, `DISCONNECT`, and optionally `DELIVER` — each tagged with topic, QoS, retained flag, and payload size. By the end you'll have sent a real publish event and confirmed it landed in Aforo.

## Prerequisites

- Go 1.21+ (the module declares `go 1.21`).
- An MQTT client library (e.g. `github.com/eclipse/paho.mqtt.golang`).
- An Aforo API key (`AFORO_API_KEY`), a `tenant_id`, and a `product_id`. All three are SDK config — never read from a client header.
- A customer id and a client id per device/session — you pass both to the `Record*` methods.
- Ingestor base URL — `https://api.aforo.ai`.

## Step 1 — Add the module

The import path ends in `/v2` (version 2 changed the public API; see the [changelog](CHANGELOG.md)). Releases are git tags `aforo-metering-sdks/go-mqtt/v2.X.Y` on github.com/aforoai/SDKs. Until the `v2.0.0` tag exists, build against a local checkout with a `replace`:

```bash
git clone https://github.com/aforoai/SDKs.git
```

```go
// go.mod (your service)
require github.com/aforoai/SDKs/aforo-metering-sdks/go-mqtt/v2 v2.0.0

replace github.com/aforoai/SDKs/aforo-metering-sdks/go-mqtt/v2 => ../SDKs/aforo-metering-sdks/go-mqtt
```

```bash
go mod tidy
```

> ⚠ Fix the `replace` path to your clone location. The SDK pulls no third-party deps; only your MQTT client library is fetched.

## Step 2 — Construct the Billing client

```go
import (
	"log"
	"os"

	mqttmetering "github.com/aforoai/SDKs/aforo-metering-sdks/go-mqtt/v2"
)

billing, err := mqttmetering.New(mqttmetering.Config{
	TenantID:    "tenant_acme",
	ProductID:   "prod_mqtt_iot_telemetry",
	APIKey:      os.Getenv("AFORO_API_KEY"),
	IngestorURL: "https://api.aforo.ai",
})
if err != nil {
	log.Fatal(err) // returned when any required field is empty
}
defer billing.Shutdown(context.Background()) // bounded by Config.ShutdownTimeout
```

> ⚠ `Shutdown(ctx)` sends what is queued, bounded by the earlier of `ctx`'s deadline and `ShutdownTimeout` (5 s). Events still queued then go to `OnDrop` with reason `shutdown` and `Shutdown` returns an error wrapping `ErrShutdownIncomplete`. Call it from your shutdown path; the library installs no signal handler.

## Step 3 — Record connection lifecycle

Hook the MQTT client's connect/disconnect callbacks:

```go
opts := mqtt.NewClientOptions().
	AddBroker("ssl://broker.example.com:8883").
	SetClientID("device-001").
	SetOnConnectHandler(func(c mqtt.Client) {
		billing.RecordConnect("cust_acme_001", "device-001")
	}).
	SetConnectionLostHandler(func(c mqtt.Client, err error) {
		billing.RecordDisconnect("cust_acme_001", "device-001")
	})
```

## Step 4 — Record subscribe / publish at the call sites

Call the `Record*` method right next to the matching MQTT client call:

```go
client.Subscribe("sensors/+/temperature", 1, nil)
billing.RecordSubscribe("cust_acme_001", "device-001", "sensors/+/temperature", 1)

payload := []byte(`{"online": true}`)
client.Publish("devices/001/status", 0, false, payload)
billing.RecordPublish("cust_acme_001", "device-001", "devices/001/status", 0, false, int64(len(payload)))
```

> ⚠ The SDK is not wired into the MQTT client — each metered action is a `Record*` call you place yourself. A `Publish` without a paired `RecordPublish` is invisible to billing. An empty `customerID` records nothing.

## Step 5 — Decide on DELIVER (inbound) events

Inbound delivery is the highest-volume path, so `RecordDeliver` is a no-op unless you opt in:

```go
billing, _ := mqttmetering.New(mqttmetering.Config{
	TenantID:          "tenant_acme",
	ProductID:         "prod_mqtt_iot_telemetry",
	APIKey:            os.Getenv("AFORO_API_KEY"),
	IngestorURL:       "https://api.aforo.ai",
	EmitDeliverEvents: true, // now RecordDeliver emits
})

// in your message handler:
billing.RecordDeliver(customerID, clientID, msg.Topic(), int(msg.Qos()), msg.Retained(), int64(len(msg.Payload())))
```

Leave it `false` unless you genuinely bill inbound delivery — it can multiply your event volume.

## Step 6 — Verify it landed

The sender runs every `FlushInterval` (5s) or when `FlushCount` (500) events are queued. Publish once, then call `billing.Flush(ctx)` (or `Shutdown(ctx)`), then check Aforo:

- In the console, open the customer and look for recent `mqtt_broker.publish` (and `.subscribe`, `.connect`, etc.) events.
- Or query the ingestion API for that tenant + those metrics.

The metric name is `mqtt_broker.<lowercased event type>` (e.g. `mqtt_broker.publish`). The wire call the SDK makes:

```
POST https://api.aforo.ai/v1/ingest/batch
X-API-Key: <AFORO_API_KEY>
X-Tenant-Id: tenant_acme
Content-Type: application/json

{"events":[{"customerId":"cust_acme_001","metricName":"mqtt_broker.publish","quantity":1,"occurredAt":"…","idempotencyKey":"mqtt:…","productType":"MQTT_BROKER","mqttTopic":"devices/001/status","mqttQos":0,"mqttRetained":false,"mqttEventType":"PUBLISH","mqttClientId":"device-001","dataBytes":16,"metadata":{"sdkVersion":"1.0.0","productId":"prod_mqtt_iot_telemetry"}}]}
```

> ⚠ Drops are WARN-logged through the standard `log` package and counted in `DroppedCount()`; the reason for a failed flush is only reported to `OnError`. If nothing lands, set `OnError: func(err error){ log.Println("aforo:", err) }` to surface marshal failures, retry-exhausted drops and ingestor rejections (including `errors[].message`).

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `TenantID` | `string` | — (required) | `X-Tenant-Id` header + idempotency-key component. |
| `ProductID` | `string` | — (required) | Event metadata + idempotency-key component. |
| `APIKey` | `string` | — (required) | `X-API-Key: <APIKey>`. |
| `IngestorURL` | `string` | — (required) | Base; `/v1/ingest/batch` is appended. |
| `EmitDeliverEvents` | `bool` | `false` | Whether `RecordDeliver` emits. |
| `ProductType` | `string` | `MQTT_BROKER` | Top-level `productType` on every event; per-event override via `EventOptions`. |
| `AllowInsecureHTTP` | `bool` | `false` | `IngestorURL` must be `https://`; plain `http://` is accepted only for `localhost`, `127.0.0.1`, `::1`, or with this set. |
| `FlushCount` | `int` | `500` | Events per request (max 1000); reaching it wakes the sender. |
| `FlushInterval` | `time.Duration` | `5s` | The sender also runs on this interval. |
| `MaxQueueSize` | `int` | `10000` | Queue capacity. When full the **oldest** event is dropped (`overflow`). |
| `MaxRetries` | `int` | `3` | Retries per batch; a negative value disables retries. |
| `RetryBase` | `time.Duration` | `500ms` | Full-jitter backoff base (each wait is random up to `min(30s, RetryBase × 2^attempt)`). |
| `Timeout` | `time.Duration` | `10s` | Total deadline per HTTP request. |
| `ShutdownTimeout` | `time.Duration` | `5s` | How long `Shutdown` keeps sending. |
| `HTTPClient` | `*http.Client` | one pooled client | Use your own client for every request; you keep ownership. |
| `OnError` | `func(error)` | no-op | Called when the ingestor rejects a batch or events (messages include its `errors[].message`), when it becomes unreachable (once per outage), when `Shutdown` leaves events unsent, for an event recorded after `Shutdown`, and when an event is invalid. Sending problems arrive as `*TransportError`: use `errors.As` and branch on `Kind` (`KindOutage`, `KindAuth`, `KindRejected`, `KindShutdown`, `KindClosed`); `Events` holds the events concerned. Invalid events arrive as a plain error. Runs on the background sender; it may call `Flush` or `Shutdown`. Never carries the API key. |
| `OnAccepted` | `func(body json.RawMessage, events []map[string]any)` | nil | Called after every `2xx` with the response's `data` object (envelope removed — for example `killedSessionIds`) and the events of that request. Same goroutine rules as `OnError`; panics are recovered. |
| `OnDrop` | `func([]map[string]any, DropReason)` | `nil` | Opt-in hook called with events the SDK gives up on (`overflow`, `rejected`, `invalid`, `shutdown`, `closed`). See [Dropped events](#dropped-events). |

Tier filtering: every event carries `mqttQos` (0/1/2) and `mqttRetained`, so Aforo descriptor filter conditions can charge selectively (e.g. `mqtt_qos in ['1','2']`, or premium for `mqtt_retained == true`).

## Dropped events

An event the SDK cannot deliver is never lost silently. `billing.DroppedCount()` returns the running total, each drop is WARN-logged, and the opt-in `Config.OnDrop(events, reason)` hook receives the events (with their idempotency keys, so re-submitting them later is dedup-safe).

| `DropReason` | When |
|---|---|
| `mqttmetering.DropOverflow` (`overflow`) | The queue was full (for example during a long outage); the oldest event was evicted. |
| `mqttmetering.DropShutdown` (`shutdown`) | Still queued when `Shutdown`'s deadline passed. `Shutdown` returns an error wrapping `ErrShutdownIncomplete`. |
| `mqttmetering.DropClosed` (`closed`) | Recorded after `Shutdown`. |
| `mqttmetering.DropRejected` (`rejected`) | The ingestor answered a non-retryable `4xx`, or refused individual events in a `2xx` partial-failure response. In the partial case only the events named by `errors[].index` are passed to `OnDrop`; failures the ingestor does not identify are counted but not attributed to an event. |
| `mqttmetering.DropInvalid` (`invalid`) | The event failed client-side validation and was never buffered: a blank or whitespace topic on a publish/deliver/subscribe/unsubscribe event, `customerId` over 64 characters or `productType` over 20. A topic over 500 or a client id over 128 is not dropped — both come from the MQTT client, so they are truncated to the limit without splitting a character, the event is sent, and a WARN is logged once per label. The invalid-drop WARN log names the field, the limit and the value (throttled: first occurrence, then every 1000th); `OnError` is called too. |

A call with a blank customer id is not billed: it is dropped as `invalid`, counted in `DroppedCount()` and reported via `OnError`. An unknown `executionStatus` is not a drop either: the status is left off (or replaced by the derived one) and the event is sent.

```go
OnDrop: func(events []map[string]any, reason mqttmetering.DropReason) {
	log.Printf("aforo: %d event(s) dropped: %s", len(events), reason)
},
```

Idempotency keys are minted once, when the event is recorded. Every retry and every resend after an outage carries the same key, so the ingestor deduplicates it. `DropRetryExhausted` (`retry_exhausted`) is kept for compatibility but is no longer reported: v2 keeps a failing batch queued instead of dropping it.

## Execution status

See [Execution status (outcome-based pricing)](README.md#execution-status-outcome-based-pricing) in the README for the values, how the status is derived and how to set your own.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `New` returns an error | A required field is empty | Set `TenantID`, `ProductID`, `APIKey`, `IngestorURL`. |
| Publishes/subscribes not metered | No matching `Record*` call at that site | Add the `Record*` call next to each MQTT client call you bill. |
| Inbound traffic missing | `EmitDeliverEvents` is `false` (default) | Set `EmitDeliverEvents: true` and call `RecordDeliver` in your message handler. |
| Nothing records for a session | Empty `customerID` passed to `Record*` | Resolve and pass a non-empty customer id; an empty id is not billed and is counted as `invalid`. |
| `OnError` reports "ingestor unavailable" | The ingestor is unreachable or answered `401`/`403` | Nothing is lost while the queue has room; verify `APIKey` and network access to `IngestorURL`. Events beyond `MaxQueueSize` are dropped as `overflow`. |
| `Shutdown` returns `ErrShutdownIncomplete` | The ingestor was slow or down at exit | Raise `ShutdownTimeout`, or persist what `OnDrop` receives with reason `shutdown`. |

## What this guide does NOT cover

- **Modeling MQTT billing in Aforo.** Mapping `mqtt_broker.*` metrics (and `mqttQos` / `mqttRetained` filters) to a rate plan is done in the Aforo console.
- **Broker-side metering.** Use the EMQ X Erlang plugin (`aforo-emqx-plugin/`) for broker-level counting. This SDK meters from the client.
- **Automatic call-site instrumentation.** You place every `Record*` call; the SDK doesn't intercept the MQTT client.
