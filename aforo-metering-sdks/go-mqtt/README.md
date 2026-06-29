# mqtt-metering-go

Client-side MQTT metering for Go. Wrap your `paho.mqtt.golang` (or any other MQTT client) call sites to emit `PUBLISH`, `SUBSCRIBE`, `UNSUBSCRIBE`, `CONNECT`, `DISCONNECT` (and optionally `DELIVER`) events to Aforo — each carrying topic, QoS, retained flag, and payload size for tier-based billing.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

Reach for this when you bill MQTT usage from the client/device side and want per-event records keyed by topic/QoS/retained — with `DELIVER` (the high-volume inbound path) off by default so you opt into it deliberately.

> For broker-side metering on EMQ X 5.x, use the companion Erlang plugin at `aforo-emqx-plugin/` in this repo. This Go SDK is the client-side path.

## Install

Intended public install once published:

```bash
go get github.com/aforoai/SDKs/aforo-metering-sdks/go-mqtt
```

**Not yet published — `go get github.com/aforoai/SDKs/aforo-metering-sdks/go-mqtt` resolves once this repo is public and the module is tagged** (`aforo-metering-sdks/go-mqtt/v1.0.0`). Until then, vendor it from source with a local `replace`:

```bash
git clone https://github.com/aforoai/SDKs.git
```

```go
// go.mod (your service)
require github.com/aforoai/SDKs/aforo-metering-sdks/go-mqtt v1.0.0

replace github.com/aforoai/SDKs/aforo-metering-sdks/go-mqtt => ../SDKs/aforo-metering-sdks/go-mqtt
```

```bash
go mod tidy
```

Standard-library only — your MQTT client library (paho, etc.) is yours to choose; this SDK doesn't depend on one.

## Quickstart

With `paho.mqtt.golang`:

```go
package main

import (
	"log"
	"os"
	"time"

	mqttmetering "github.com/aforoai/SDKs/aforo-metering-sdks/go-mqtt"
	mqtt "github.com/eclipse/paho.mqtt.golang"
)

func main() {
	billing, err := mqttmetering.New(mqttmetering.Config{
		TenantID:    "tenant_acme",
		ProductID:   "prod_mqtt_iot_telemetry",
		APIKey:      os.Getenv("AFORO_API_KEY"),
		IngestorURL: "https://ingest.aforo.ai",
	})
	if err != nil {
		log.Fatal(err)
	}
	defer billing.Shutdown()

	customerID, clientID := "cust_acme_001", "device-001"

	opts := mqtt.NewClientOptions().
		AddBroker("ssl://broker.example.com:8883").
		SetClientID(clientID).
		SetOnConnectHandler(func(c mqtt.Client) {
			billing.RecordConnect(customerID, clientID)
		}).
		SetConnectionLostHandler(func(c mqtt.Client, err error) {
			billing.RecordDisconnect(customerID, clientID)
		})

	client := mqtt.NewClient(opts)
	if t := client.Connect(); t.Wait() && t.Error() != nil {
		log.Fatal(t.Error())
	}

	client.Subscribe("sensors/+/temperature", 1, nil)
	billing.RecordSubscribe(customerID, clientID, "sensors/+/temperature", 1)

	payload := []byte(`{"online": true}`)
	client.Publish("devices/001/status", 0, false, payload)
	billing.RecordPublish(customerID, clientID, "devices/001/status", 0, false, int64(len(payload)))

	time.Sleep(time.Hour)
}
```

Each `Record*` call buffers one event; an empty `customerID` records nothing (the event builder returns nil and the buffer skips it).

> ⚠ The SDK does not hook the MQTT client — you call `Record*` at the same sites where you call the client's `Connect`/`Subscribe`/`Publish`. If you skip a call site, that traffic isn't metered.

## Configuration

`Config`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `TenantID` | `string` | — (required) | Sent as the `X-Tenant-Id` header on every flush and embedded in idempotency keys. Set by you, never from a client header. |
| `ProductID` | `string` | — (required) | Recorded in event metadata + idempotency keys. |
| `APIKey` | `string` | — (required) | Sent as `Authorization: Bearer <APIKey>`. |
| `IngestorURL` | `string` | — (required) | Ingestor base; the SDK appends `/v1/ingest/events`. Use `https://ingest.aforo.ai`. |
| `EmitDeliverEvents` | `bool` | `false` | When true, `RecordDeliver` emits events. Off by default — inbound delivery is high-volume. |
| `FlushCount` | `int` | `200` | Flush when the buffer reaches this many events (highest of the SDKs — MQTT telemetry is the highest-volume). |
| `FlushInterval` | `time.Duration` | `2s` | Background flush cadence. |
| `HTTPClient` | `*http.Client` | `&http.Client{Timeout: 10s}` | Override the HTTP client used for flushing. |
| `OnError` | `func(error)` | no-op | Called on a marshal failure or a flush that exhausts its 3 retries (events dropped). |

`New` returns an error if `TenantID`, `ProductID`, `APIKey`, or `IngestorURL` is empty.

Event methods:

| Go call | Event type | Notes |
|---|---|---|
| `RecordPublish(customerID, clientID, topic, qos, retained, payloadBytes)` | `PUBLISH` | |
| `RecordDeliver(customerID, clientID, topic, qos, retained, payloadBytes)` | `DELIVER` | No-op unless `EmitDeliverEvents: true`. |
| `RecordSubscribe(customerID, clientID, topicFilter, qos)` | `SUBSCRIBE` | |
| `RecordUnsubscribe(customerID, clientID, topicFilter)` | `UNSUBSCRIBE` | |
| `RecordConnect(customerID, clientID)` | `CONNECT` | |
| `RecordDisconnect(customerID, clientID)` | `DISCONNECT` | |

Every event carries `mqttQos` (0/1/2) and `mqttRetained`, so descriptor filter conditions can tier on them (e.g. charge only QoS ≥ 1, premium for retained).

## Walk me through it

Step-by-step from install to "I can see the publish in Aforo" lives in [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **No automatic interception.** You call `Record*` at your MQTT call sites — the SDK can't observe the client's traffic on its own.
- **Broker-side metering.** For EMQ X 5.x broker-level metering, use the companion Erlang plugin (`aforo-emqx-plugin/`). This SDK is client-side.
- **`DELIVER` is opt-in.** Inbound delivery is the highest-volume path; it's silent unless you set `EmitDeliverEvents: true`.
- **No delivery guarantee on crash.** Events live in memory until flushed; a hard crash before a flush loses the buffer. `Shutdown()` drains on graceful exit.
