# mqtt-metering-go

Client-side MQTT metering for Go. Wrap your `paho.mqtt.golang` (or any other MQTT client) call sites to emit `PUBLISH`, `SUBSCRIBE`, `UNSUBSCRIBE`, `CONNECT`, `DISCONNECT` (and optionally `DELIVER`) events to Aforo — each carrying topic, QoS, retained flag, and payload size for tier-based billing.

**Version:** 1.2.2 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

Reach for this when you bill MQTT usage from the client/device side and want per-event records keyed by topic/QoS/retained — with `DELIVER` (the high-volume inbound path) off by default so you opt into it deliberately.

> For broker-side metering on EMQ X 5.x, use the companion Erlang plugin at `aforo-emqx-plugin/` in this repo. This Go SDK is the client-side path.

## Install


```bash
go get github.com/aforoai/SDKs/aforo-metering-sdks/go-mqtt
```

Releases are git tags of the form `aforo-metering-sdks/go-mqtt/vX.Y.Z` on [github.com/aforoai/SDKs](https://github.com/aforoai/SDKs) (this version: `aforo-metering-sdks/go-mqtt/v1.2.2`). Use `v1.2.2` or later: `v1.0.0` was tagged from an older copy of this code and lacks the fixes listed in the changelog. Until the `v1.2.2` tag exists, `go get github.com/aforoai/SDKs/aforo-metering-sdks/go-mqtt@main` resolves to a pseudo-version of the default branch. To build against a local checkout instead, use a `replace`:

```bash
git clone https://github.com/aforoai/SDKs.git
```

```go
// go.mod (your service)
require github.com/aforoai/SDKs/aforo-metering-sdks/go-mqtt v1.2.2

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
		IngestorURL: "https://api.aforo.ai",
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

Product type: every event carries a top-level `productType` — `Config.ProductType` (default `"MQTT_BROKER"`). Every `Record*` method accepts optional trailing `mqttmetering.EventOptions` to override it; the same options carry `ExecutionStatus`, and each method has a `Record*WithOptions` single-options form. Example:

```go
billing.RecordPublish(customerID, clientID, topic, qos, retained, n,
	mqttmetering.EventOptions{ProductType: "AGENTIC_API"})
```

Delivery: `POST /v1/ingest/batch` with `{"events":[...]}`, at most 1000 events per request, `X-API-Key` header. Transport errors, `408`, `429` (honouring `Retry-After`) and `5xx` are retried with the same body; any other `4xx` is not retried: the batch is dropped with reason `rejected` and reported via `OnError` (see [Dropped events](#dropped-events)).

## Configuration

`Config`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `TenantID` | `string` | — (required) | Sent as the `X-Tenant-Id` header on every flush and embedded in idempotency keys. Set by you, never from a client header. |
| `ProductID` | `string` | — (required) | Recorded in event metadata + idempotency keys. |
| `APIKey` | `string` | — (required) | Sent as `X-API-Key: <APIKey>`. |
| `IngestorURL` | `string` | — (required) | Ingestor base; the SDK appends `/v1/ingest/batch`. Use `https://api.aforo.ai`. |
| `EmitDeliverEvents` | `bool` | `false` | When true, `RecordDeliver` emits events. Off by default — inbound delivery is high-volume. |
| `ProductType` | `string` | `MQTT_BROKER` | Top-level `productType` on every event (required by the ingestor). Trimmed + upper-cased; unknown values pass through. Overridable per event via `EventOptions`. |
| `FlushCount` | `int` | `200` | Flush when the buffer reaches this many events (highest of the SDKs — MQTT telemetry is the highest-volume). |
| `FlushInterval` | `time.Duration` | `2s` | Background flush cadence. |
| `HTTPClient` | `*http.Client` | `&http.Client{Timeout: 10s}` | Override the HTTP client used for flushing. |
| `OnError` | `func(error)` | no-op | Called on a marshal failure, a flush that exhausts its 3 retries, a non-retryable `4xx` (dropped without retry), or a `2xx` whose body reports `failed > 0` — messages include the ingestor's `errors[].message`. |
| `OnDrop` | `func([]map[string]any, DropReason)` | `nil` | Opt-in hook called with events the SDK drops (`retry_exhausted`, `rejected`, `invalid`). See [Dropped events](#dropped-events). |

`New` returns an error if `TenantID`, `ProductID`, `APIKey`, or `IngestorURL` is empty.

Event methods:

| Go call | Event type | Notes |
|---|---|---|
| `RecordPublish(customerID, clientID, topic, qos, retained, payloadBytes)` | `PUBLISH` | Dropped (reported via `OnError`) if `topic` is empty. |
| `RecordDeliver(customerID, clientID, topic, qos, retained, payloadBytes)` | `DELIVER` | No-op unless `EmitDeliverEvents: true`. |
| `RecordSubscribe(customerID, clientID, topicFilter, qos)` | `SUBSCRIBE` | |
| `RecordUnsubscribe(customerID, clientID, topicFilter)` | `UNSUBSCRIBE` | |
| `RecordConnect(customerID, clientID)` | `CONNECT` | `mqttTopic` is set to `$SYS/clients/<clientID>/connected` (the ingestor requires a topic). |
| `RecordDisconnect(customerID, clientID)` | `DISCONNECT` | `mqttTopic` is set to `$SYS/clients/<clientID>/disconnected`. |

Every event carries `mqttQos` (0/1/2) and `mqttRetained`, so descriptor filter conditions can tier on them (e.g. charge only QoS ≥ 1, premium for retained).

## Walk me through it

Step-by-step from install to "I can see the publish in Aforo" lives in [USER_GUIDE.md](USER_GUIDE.md).

## Execution status (outcome-based pricing)

OUTCOME_BASED rate plans weight each event by its `executionStatus`. The SDK doesn't derive one for MQTT events, so it's only sent when you pass it. Every `Record*` method has a `Record*WithOptions` variant:

```go
token := client.Publish(topic, qos, retained, payload)
status := "SUCCESS"
if token.Wait() && token.Error() != nil {
	status = "ERROR"
}
billing.RecordPublishWithOptions(customerID, clientID, topic, int(qos), retained, int64(len(payload)),
	mqttmetering.EventOptions{ExecutionStatus: status})
```

Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. The SDK trims and upper-cases the value; a blank value is left out of the event. Any other value is WARN-logged and left off the event; the event is still sent.

## Dropped events

An event the SDK cannot deliver is never lost silently. `billing.DroppedCount()` returns the running total, each drop is WARN-logged, and the opt-in `Config.OnDrop(events, reason)` hook receives the events (with their idempotency keys, so re-submitting them later is dedup-safe).

| `DropReason` | When |
|---|---|
| `mqttmetering.DropRetryExhausted` (`retry_exhausted`) | A batch failed all 3 attempts (transport error, `408`, `429`, `5xx`). |
| `mqttmetering.DropRejected` (`rejected`) | The ingestor answered a non-retryable `4xx`, or refused individual events in a `2xx` partial-failure response. In the partial case only the events named by `errors[].index` are passed to `OnDrop`; failures the ingestor does not identify are counted but not attributed to an event. |
| `mqttmetering.DropInvalid` (`invalid`) | The event failed client-side validation and was never buffered: a blank or whitespace topic on a publish/deliver/subscribe/unsubscribe event, `customerId` over 64 characters or `productType` over 20. A topic over 500 or a client id over 128 is not dropped — both come from the MQTT client, so they are truncated to the limit without splitting a character, the event is sent, and a WARN is logged once per label. The invalid-drop WARN log names the field, the limit and the value (throttled: first occurrence, then every 1000th); `OnError` is called too. |

A call with no customer id is not metered and is not a drop. An unknown `executionStatus` is not a drop either: the status is left off (or replaced by the derived one) and the event is sent.

```go
OnDrop: func(events []map[string]any, reason mqttmetering.DropReason) {
	log.Printf("aforo: %d event(s) dropped: %s", len(events), reason)
},
```

Idempotency keys are minted once, when the event is recorded. Every retry re-sends the same body, so a retried batch is deduplicated by the ingestor.

## What this doesn't cover

- **No automatic interception.** You call `Record*` at your MQTT call sites — the SDK can't observe the client's traffic on its own.
- **Broker-side metering.** For EMQ X 5.x broker-level metering, use the companion Erlang plugin (`aforo-emqx-plugin/`). This SDK is client-side.
- **`DELIVER` is opt-in.** Inbound delivery is the highest-volume path; it's silent unless you set `EmitDeliverEvents: true`.
- **No delivery guarantee on crash.** Events live in memory until flushed; a hard crash before a flush loses the buffer. `Shutdown()` drains on graceful exit.
