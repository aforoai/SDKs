# mqtt-metering-go — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Go engineers metering MQTT usage from the client/device side.

## What you'll build

A Go MQTT client that emits one Aforo billing event per MQTT action — `CONNECT`, `SUBSCRIBE`, `PUBLISH`, `UNSUBSCRIBE`, `DISCONNECT`, and optionally `DELIVER` — each tagged with topic, QoS, retained flag, and payload size. By the end you'll have sent a real publish event and confirmed it landed in Aforo.

## Prerequisites

- Go 1.21+ (the module declares `go 1.21`).
- An MQTT client library (e.g. `github.com/eclipse/paho.mqtt.golang`).
- An Aforo API key (`AFORO_API_KEY`), a `tenant_id`, and a `product_id`. All three are SDK config — never read from a client header.
- A customer id and a client id per device/session — you pass both to the `Record*` methods.
- Ingestor base URL — `https://ingest.aforo.ai`.

## Step 1 — Add the module from source

`go get github.com/aforo/mqtt-metering-go` does not resolve yet (proxy not live). Clone and `replace`:

```bash
git clone https://github.com/aforoai/SDKs.git
```

```go
// go.mod (your service)
require github.com/aforo/mqtt-metering-go v1.0.0

replace github.com/aforo/mqtt-metering-go => ../SDKs/aforo-metering-sdks/go-mqtt
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

	mqttmetering "github.com/aforo/mqtt-metering-go"
)

billing, err := mqttmetering.New(mqttmetering.Config{
	TenantID:    "tenant_acme",
	ProductID:   "prod_mqtt_iot_telemetry",
	APIKey:      os.Getenv("AFORO_API_KEY"),
	IngestorURL: "https://ingest.aforo.ai",
})
if err != nil {
	log.Fatal(err) // returned when any required field is empty
}
defer billing.Shutdown()
```

> ⚠ `Shutdown()` flushes the buffer and waits for the flush loop. With the aggressive defaults (200 events / 2s) for high-volume telemetry, an un-flushed buffer at exit can hold a lot — always `Shutdown()` on graceful exit.

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
	IngestorURL:       "https://ingest.aforo.ai",
	EmitDeliverEvents: true, // now RecordDeliver emits
})

// in your message handler:
billing.RecordDeliver(customerID, clientID, msg.Topic(), int(msg.Qos()), msg.Retained(), int64(len(msg.Payload())))
```

Leave it `false` unless you genuinely bill inbound delivery — it can multiply your event volume.

## Step 6 — Verify it landed

The buffer flushes every `FlushInterval` (2s) or when it reaches `FlushCount` (200). Publish once, wait ~3 seconds (or `Shutdown()` to force a drain), then check Aforo:

- In the console, open the customer and look for recent `mqtt_broker.publish` (and `.subscribe`, `.connect`, etc.) events.
- Or query the ingestion API for that tenant + those metrics.

The metric name is `mqtt_broker.<lowercased event type>` (e.g. `mqtt_broker.publish`). The wire call the SDK makes:

```
POST https://ingest.aforo.ai/v1/ingest/events
Authorization: Bearer <AFORO_API_KEY>
X-Tenant-Id: tenant_acme
Content-Type: application/json

{"events":[{"customerId":"cust_acme_001","metricName":"mqtt_broker.publish","quantity":1,"occurredAt":"…","idempotencyKey":"mqtt:…","productType":"MQTT_BROKER","mqttTopic":"devices/001/status","mqttQos":0,"mqttRetained":false,"mqttEventType":"PUBLISH","mqttClientId":"device-001","dataBytes":16,"metadata":{"sdkVersion":"1.0.0","productId":"prod_mqtt_iot_telemetry"}}]}
```

> ⚠ Flush failures are silent unless you set `OnError`. If nothing lands, set `OnError: func(err error){ log.Println("aforo:", err) }` to surface marshal failures and retry-exhausted drops.

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `TenantID` | `string` | — (required) | `X-Tenant-Id` header + idempotency-key component. |
| `ProductID` | `string` | — (required) | Event metadata + idempotency-key component. |
| `APIKey` | `string` | — (required) | `Authorization: Bearer <APIKey>`. |
| `IngestorURL` | `string` | — (required) | Base; `/v1/ingest/events` is appended. |
| `EmitDeliverEvents` | `bool` | `false` | Whether `RecordDeliver` emits. |
| `FlushCount` | `int` | `200` | Buffer-size flush threshold. |
| `FlushInterval` | `time.Duration` | `2s` | Background flush cadence. |
| `HTTPClient` | `*http.Client` | `&http.Client{Timeout: 10s}` | HTTP client override. |
| `OnError` | `func(error)` | no-op | Marshal failures + retry-exhausted drops. |

Tier filtering: every event carries `mqttQos` (0/1/2) and `mqttRetained`, so Aforo descriptor filter conditions can charge selectively (e.g. `mqtt_qos in ['1','2']`, or premium for `mqtt_retained == true`).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `New` returns an error | A required field is empty | Set `TenantID`, `ProductID`, `APIKey`, `IngestorURL`. |
| Publishes/subscribes not metered | No matching `Record*` call at that site | Add the `Record*` call next to each MQTT client call you bill. |
| Inbound traffic missing | `EmitDeliverEvents` is `false` (default) | Set `EmitDeliverEvents: true` and call `RecordDeliver` in your message handler. |
| Nothing records for a session | Empty `customerID` passed to `Record*` | Resolve and pass a non-empty customer id; an empty id is silently skipped. |
| Events drop with no log | Flush exhausted 3 retries and `OnError` is unset | Set `OnError`; verify `APIKey`, `IngestorURL`, and that the tenant owns the metric. |
| Large gaps at shutdown | Process exited before a flush with a full-ish buffer | Always `defer billing.Shutdown()`; consider lowering `FlushCount`/`FlushInterval`. |

## What this guide does NOT cover

- **Modeling MQTT billing in Aforo.** Mapping `mqtt_broker.*` metrics (and `mqttQos` / `mqttRetained` filters) to a rate plan is done in the Aforo console.
- **Broker-side metering.** Use the EMQ X Erlang plugin (`aforo-emqx-plugin/`) for broker-level counting. This SDK meters from the client.
- **Automatic call-site instrumentation.** You place every `Record*` call; the SDK doesn't intercept the MQTT client.
