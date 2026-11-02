# mqtt-metering-go

Client-side MQTT metering for Go. Wrap your `paho.mqtt.golang` (or any other MQTT client) call sites to emit `PUBLISH`, `SUBSCRIBE`, `UNSUBSCRIBE`, `CONNECT`, `DISCONNECT` (and optionally `DELIVER`) events to Aforo — each carrying topic, QoS, retained flag, and payload size for tier-based billing.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

Reach for this when you bill MQTT usage from the client/device side and want per-event records keyed by topic/QoS/retained — with `DELIVER` (the high-volume inbound path) off by default so you opt into it deliberately.

> For broker-side metering on EMQ X 5.x, use the companion Erlang plugin at `aforo-emqx-plugin/` in this repo. This Go SDK is the client-side path.

## Install


```bash
go get github.com/aforoai/SDKs/aforo-metering-sdks/go-mqtt/v2
```

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

Standard-library only — your MQTT client library (paho, etc.) is yours to choose; this SDK doesn't depend on one.

## Quickstart

With `paho.mqtt.golang`:

```go
package main

import (
	"log"
	"os"
	"time"

	mqttmetering "github.com/aforoai/SDKs/aforo-metering-sdks/go-mqtt/v2"
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
	defer billing.Shutdown(context.Background()) // bounded by Config.ShutdownTimeout

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

Each `Record*` call queues one event. Pass the customer id your own authentication resolved; the SDK never derives it from the MQTT username or client id. An empty `customerID` queues nothing and is counted as `invalid`.

> ⚠ The SDK does not hook the MQTT client — you call `Record*` at the same sites where you call the client's `Connect`/`Subscribe`/`Publish`. If you skip a call site, that traffic isn't metered.

Product type: every event carries a top-level `productType` — `Config.ProductType` (default `"MQTT_BROKER"`). Every `Record*` method accepts optional trailing `mqttmetering.EventOptions` to override it; the same options carry `ExecutionStatus`, and each method has a `Record*WithOptions` single-options form. Example:

```go
billing.RecordPublish(customerID, clientID, topic, qos, retained, n,
	mqttmetering.EventOptions{ProductType: "AGENTIC_API"})
```

How events are sent: every `Record`/`Open`/`Close` call appends to a bounded queue (`MaxQueueSize`, default 10 000) and returns; it never starts a goroutine or makes a request. One background sender per `Billing` posts `{"events":[...]}` to `/v1/ingest/batch` in batches of up to `FlushCount` (default 500, at most 1000), with `X-API-Key` and `User-Agent: aforo-go-mqtt/2.0.0`. Network errors, timeouts, `408`, `429` and `5xx` are retried with full-jitter backoff; `Retry-After` is honoured in both forms (seconds or HTTP date) up to 60 s. Each request, including reading the response body, is cut off at `Timeout`. Redirects are never followed (the API key must not reach another host): a `3xx` is logged at ERROR with the target host and handled like an outage. When retries run out — or the ingestor answers `401`/`403` or `3xx` — the batch goes back to the front of the queue with the same idempotency keys and the sender pauses (a random wait up to 5 s, doubling to 5 min, at least 250 ms); nothing is dropped and the ingestor deduplicates the resend. Events a `2xx` names in `errors[]` with `retryable: true` are resent after the same backoff, at most `MaxRetries` times, then handled as an outage. `413` splits the batch; any other `4xx` drops it as `rejected` and reports it via `OnError`. `Shutdown(ctx)` keeps sending — and retrying an unreachable ingestor — until the earlier of `ctx`'s deadline and `ShutdownTimeout` (5 s) and reports the rest as `shutdown` (see [Dropped events](#dropped-events)).

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

## What this doesn't cover

- **No automatic interception.** You call `Record*` at your MQTT call sites — the SDK can't observe the client's traffic on its own.
- **Broker-side metering.** For EMQ X 5.x broker-level metering, use the companion Erlang plugin (`aforo-emqx-plugin/`). This SDK is client-side.
- **`DELIVER` is opt-in.** Inbound delivery is the highest-volume path; it's silent unless you set `EmitDeliverEvents: true`.
- **No delivery guarantee on crash.** Events live in memory until sent; a hard crash loses the queue. `Shutdown(ctx)` sends what is left on graceful exit, bounded by `ShutdownTimeout`. The library installs no signal handler.
