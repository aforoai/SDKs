# ws-metering-go

Per-connection (and optionally per-frame) WebSocket metering for Go. Framework-agnostic — `gorilla/websocket`, `nhooyr.io/websocket`, `gobwas/ws`, or a raw `net/http` upgrade. You call `Open`, `RecordFrame`, and `Close`; the SDK aggregates per-connection counters and emits a connection-opened + connection-closed event pair to Aforo.

**Version:** 1.2.1 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

Reach for this when you bill WebSocket usage by connection (with duration, frame count, and byte totals) and want one open/close event pair per connection — with a per-frame mode for the cases where every message is billable.

## Install


```bash
go get github.com/aforoai/SDKs/aforo-metering-sdks/go-ws
```

Releases are git tags of the form `aforo-metering-sdks/go-ws/vX.Y.Z` on [github.com/aforoai/SDKs](https://github.com/aforoai/SDKs) (this version: `aforo-metering-sdks/go-ws/v1.2.1`). Use `v1.2.1` or later: `v1.0.0` was tagged from an older copy of this code and lacks the fixes listed in the changelog. Until the `v1.2.1` tag exists, `go get github.com/aforoai/SDKs/aforo-metering-sdks/go-ws@main` resolves to a pseudo-version of the default branch. To build against a local checkout instead, use a `replace`:

```bash
git clone https://github.com/aforoai/SDKs.git
```

```go
// go.mod (your service)
require github.com/aforoai/SDKs/aforo-metering-sdks/go-ws v1.2.1

replace github.com/aforoai/SDKs/aforo-metering-sdks/go-ws => ../SDKs/aforo-metering-sdks/go-ws
```

```bash
go mod tidy
```

Standard-library only — your WebSocket library (gorilla, nhooyr, etc.) is yours to choose; this SDK doesn't depend on one.

## Quickstart

With `gorilla/websocket`:

```go
package main

import (
	"log"
	"net/http"
	"os"

	wsmetering "github.com/aforoai/SDKs/aforo-metering-sdks/go-ws"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{}

func main() {
	billing, err := wsmetering.New(wsmetering.Config{
		TenantID:    "tenant_acme",
		ProductID:   "prod_ws_market_feed",
		APIKey:      os.Getenv("AFORO_API_KEY"),
		IngestorURL: "https://api.aforo.ai",
	})
	if err != nil {
		log.Fatal(err)
	}
	defer billing.Shutdown()

	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		customerID := r.Header.Get("X-Customer-Id")
		if customerID == "" {
			http.Error(w, "missing customer id", http.StatusUnauthorized)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		connID := billing.Open(customerID, map[string]any{"path": r.URL.Path})
		defer billing.Close(connID, websocket.CloseNormalClosure)

		for {
			mt, msg, err := conn.ReadMessage()
			if err != nil {
				break
			}
			billing.RecordFrame(connID, "CLIENT_TO_SERVER", "TEXT", int64(len(msg)))
			conn.WriteMessage(mt, msg)
			billing.RecordFrame(connID, "SERVER_TO_CLIENT", "TEXT", int64(len(msg)))
		}
	})
	log.Fatal(http.ListenAndServe(":8080", nil))
}
```

`Open` returns a connection id you must hold and pass to `RecordFrame` and `Close`. `Open` with an empty customer id returns `""` and tracks nothing.

> ⚠ Pair every `Open` with a `Close` — `defer billing.Close(connID, code)` right after `Open`. The `CONNECTION_CLOSED` event (carrying duration, frame count, and byte totals) is only emitted by `Close`; if the goroutine returns without it, that connection's totals never ship and the entry leaks in the in-memory map.

Product type: every event carries a top-level `productType` — `Config.ProductType` (default `"WEBSOCKET_API"`). `Open` accepts an optional trailing `wsmetering.EventOptions` to override it for that connection; the override applies to every event of the connection (open, frames, close). `OpenWithOptions`, `RecordFrameWithOptions` and `CloseWithOptions` take an `ExecutionStatus` for their own event. Example:

```go
connID := billing.Open(customerID, meta, wsmetering.EventOptions{ProductType: "AGENTIC_API"})
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
| `PerFrameEvents` | `bool` | `false` | When true, each `RecordFrame` emits an immediate event **in addition** to the open/close pair. Off by default — open + close only. |
| `ProductType` | `string` | `WEBSOCKET_API` | Top-level `productType` on every event (required by the ingestor). Trimmed + upper-cased; unknown values pass through. Overridable per event via `EventOptions`. |
| `FlushCount` | `int` | `100` | Flush when the buffer reaches this many events. |
| `FlushInterval` | `time.Duration` | `3s` | Background flush cadence. |
| `HTTPClient` | `*http.Client` | `&http.Client{Timeout: 10s}` | Override the HTTP client used for flushing. |
| `OnError` | `func(error)` | no-op | Called on a marshal failure, a flush that exhausts its 3 retries, a non-retryable `4xx` (dropped without retry), or a `2xx` whose body reports `failed > 0` — messages include the ingestor's `errors[].message`. |
| `OnDrop` | `func([]map[string]any, DropReason)` | `nil` | Opt-in hook called with events the SDK drops (`retry_exhausted`, `rejected`, `invalid`). See [Dropped events](#dropped-events). |

`New` returns an error if `TenantID`, `ProductID`, `APIKey`, or `IngestorURL` is empty.

## Walk me through it

Step-by-step from install to "I can see the connection in Aforo" lives in [USER_GUIDE.md](USER_GUIDE.md).

## Execution status (outcome-based pricing)

OUTCOME_BASED rate plans weight each event by its `executionStatus`. The SDK doesn't derive one for WebSocket events — a close code isn't a per-request outcome — so it's only sent when you pass it:

```go
connID := billing.OpenWithOptions(customerID, meta, wsmetering.EventOptions{ExecutionStatus: "SUCCESS"})
billing.RecordFrameWithOptions(connID, "CLIENT_TO_SERVER", "TEXT", n, wsmetering.EventOptions{ExecutionStatus: "PARTIAL"})
billing.CloseWithOptions(connID, 1011, wsmetering.EventOptions{ExecutionStatus: "ERROR"})
```

`RecordFrameWithOptions` only emits an event when `PerFrameEvents` is on. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. The SDK trims and upper-cases the value; a blank value is left out of the event. Any other value is WARN-logged and left off the event; the event is still sent.

## Dropped events

An event the SDK cannot deliver is never lost silently. `billing.DroppedCount()` returns the running total, each drop is WARN-logged, and the opt-in `Config.OnDrop(events, reason)` hook receives the events (with their idempotency keys, so re-submitting them later is dedup-safe).

| `DropReason` | When |
|---|---|
| `wsmetering.DropRetryExhausted` (`retry_exhausted`) | A batch failed all 3 attempts (transport error, `408`, `429`, `5xx`). |
| `wsmetering.DropRejected` (`rejected`) | The ingestor answered a non-retryable `4xx`, or refused individual events in a `2xx` partial-failure response. In the partial case only the events named by `errors[].index` are passed to `OnDrop`; failures the ingestor does not identify are counted but not attributed to an event. |
| `wsmetering.DropInvalid` (`invalid`) | The event failed client-side validation and was never buffered: `customerId` over 64 characters or `productType` over 20 — `Open` returns `""` and the connection is not metered. The WARN log names the field, the limit and the value (throttled: first occurrence, then every 1000th); `OnError` is called too. |

A call with no customer id is not metered and is not a drop. An unknown `executionStatus` is not a drop either: the status is left off (or replaced by the derived one) and the event is sent.

```go
OnDrop: func(events []map[string]any, reason wsmetering.DropReason) {
	log.Printf("aforo: %d event(s) dropped: %s", len(events), reason)
},
```

Idempotency keys are minted once, when the event is recorded. Every retry re-sends the same body, so a retried batch is deduplicated by the ingestor.

## What this doesn't cover

- **No automatic frame interception.** You call `RecordFrame` at your read/write sites — the SDK can't see your WebSocket library's traffic on its own.
- **Close-code → reason mapping is fixed.** Standard codes (1000–1011) map to a fixed reason set; codes ≥ 4000 all map to `IDLE_TIMEOUT`. There's no override hook.
- **No delivery guarantee on crash.** Events live in memory until flushed; a hard crash before a flush loses the buffer, and a connection whose `Close` never ran never ships its `CONNECTION_CLOSED` event. `Shutdown()` drains on graceful exit.
- **Customer id is yours to supply.** `Open` takes the id directly — decode it from your auth before calling.
