# ws-metering-go

Per-connection (and optionally per-frame) WebSocket metering for Go. Framework-agnostic — `gorilla/websocket`, `nhooyr.io/websocket`, `gobwas/ws`, or a raw `net/http` upgrade. You call `Open`, `RecordFrame`, and `Close`; the SDK aggregates per-connection counters and emits a connection-opened + connection-closed event pair to Aforo.

Record an outbound frame only after the write succeeds, so a frame the socket refused is not billed (the Node and Python SDKs, which wrap `send`, do this for you).

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

Reach for this when you bill WebSocket usage by connection (with duration, frame count, and byte totals) and want one open/close event pair per connection — with a per-frame mode for the cases where every message is billable.

## Install


```bash
go get github.com/aforoai/SDKs/aforo-metering-sdks/go-ws/v2
```

The import path ends in `/v2` (version 2 changed the public API; see the [changelog](CHANGELOG.md)). Releases are git tags `aforo-metering-sdks/go-ws/v2.X.Y` on github.com/aforoai/SDKs. Until the `v2.0.0` tag exists, build against a local checkout with a `replace`:

```bash
git clone https://github.com/aforoai/SDKs.git
```

```go
// go.mod (your service)
require github.com/aforoai/SDKs/aforo-metering-sdks/go-ws/v2 v2.0.0

replace github.com/aforoai/SDKs/aforo-metering-sdks/go-ws/v2 => ../SDKs/aforo-metering-sdks/go-ws
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

	wsmetering "github.com/aforoai/SDKs/aforo-metering-sdks/go-ws/v2"
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
	defer billing.Shutdown(context.Background()) // bounded by Config.ShutdownTimeout

	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		customerID := customerFromSession(r) // your authenticated Aforo customer id
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
			if err := conn.WriteMessage(mt, msg); err != nil {
				break // not written, so not billed
			}
			billing.RecordFrame(connID, "SERVER_TO_CLIENT", "TEXT", int64(len(msg)))
		}
	})
	log.Fatal(http.ListenAndServe(":8080", nil))
}
```

`Open` returns a connection id you must hold and pass to `RecordFrame` and `Close`. Pass the customer id your own authentication resolved; the SDK never reads it from the request. `Open` with an empty customer id returns `""`, tracks nothing and counts the event as `invalid`.

> ⚠ Pair every `Open` with a `Close` — `defer billing.Close(connID, code)` right after `Open`. The `CONNECTION_CLOSED` event carries duration, frame count and byte totals. As a safety net, a connection with no activity for `ConnectionIdleTimeout` (default 1 h) is closed by the SDK (close reason `ABNORMAL_CLOSURE`, metadata `closedBy: "sdk_idle_timeout"`), and `Shutdown` closes every connection still open (`GOING_AWAY`, `closedBy: "sdk_shutdown"`), so totals are not lost and the connection map cannot grow without bound.

`CONNECTION_OPENED` has its own frame type `OPEN` and metric `websocket_api.connection_opened` (before v2 it was sent as frame type `PING` with metric `websocket_api.message`). Make sure that metric exists in your Aforo catalog if you bill connections opened.

Product type: every event carries a top-level `productType` — `Config.ProductType` (default `"WEBSOCKET_API"`). `Open` accepts an optional trailing `wsmetering.EventOptions` to override it for that connection; the override applies to every event of the connection (open, frames, close). `OpenWithOptions`, `RecordFrameWithOptions` and `CloseWithOptions` take an `ExecutionStatus` for their own event. Example:

```go
connID := billing.Open(customerID, meta, wsmetering.EventOptions{ProductType: "AGENTIC_API"})
```

How events are sent: every `Record`/`Open`/`Close` call appends to a bounded queue (`MaxQueueSize`, default 10 000) and returns; it never starts a goroutine or makes a request. One background sender per `Billing` posts `{"events":[...]}` to `/v1/ingest/batch` in batches of up to `FlushCount` (default 500, at most 1000), with `X-API-Key` and `User-Agent: aforo-go-ws/2.0.0`. Network errors, timeouts, `408`, `429` and `5xx` are retried with full-jitter backoff; `Retry-After` is honoured in both forms (seconds or HTTP date) up to 60 s. Each request, including reading the response body, is cut off at `Timeout`. Redirects are never followed (the API key must not reach another host): a `3xx` is logged at ERROR with the target host and handled like an outage. When retries run out — or the ingestor answers `401`/`403` or `3xx` — the batch goes back to the front of the queue with the same idempotency keys and the sender pauses (a random wait up to 5 s, doubling to 5 min, at least 250 ms); nothing is dropped and the ingestor deduplicates the resend. Events a `2xx` names in `errors[]` with `retryable: true` are resent after the same backoff, at most `MaxRetries` times, then handled as an outage. `413` splits the batch; any other `4xx` drops it as `rejected` and reports it via `OnError`. `Shutdown(ctx)` keeps sending — and retrying an unreachable ingestor — until the earlier of `ctx`'s deadline and `ShutdownTimeout` (5 s) and reports the rest as `shutdown` (see [Dropped events](#dropped-events)).

## Configuration

`Config`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `TenantID` | `string` | — (required) | Sent as the `X-Tenant-Id` header on every flush and embedded in idempotency keys. Set by you, never from a client header. |
| `ProductID` | `string` | — (required) | Recorded in event metadata + idempotency keys. |
| `APIKey` | `string` | — (required) | Sent as `X-API-Key: <APIKey>`. |
| `IngestorURL` | `string` | — (required) | Ingestor base; the SDK appends `/v1/ingest/batch`. Use `https://api.aforo.ai`. |
| `ConnectionIdleTimeout` | `time.Duration` | `1h` | Close a connection with no `RecordFrame` activity for this long. Must not be negative (`New` returns an error); 0 means 1h. |
| `PerFrameEvents` | `bool` | `false` | When true, each `RecordFrame` emits an immediate event **in addition** to the open/close pair. Off by default — open + close only. |
| `ProductType` | `string` | `WEBSOCKET_API` | Top-level `productType` on every event (required by the ingestor). Trimmed + upper-cased; unknown values pass through. Overridable per event via `EventOptions`. |
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

`New` returns an error if `TenantID`, `ProductID`, `APIKey`, or `IngestorURL` is empty, or if `IngestorURL` is not `https://` (see `AllowInsecureHTTP`). `Config.String()` never prints the API key.

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
| `wsmetering.DropOverflow` (`overflow`) | The queue was full (for example during a long outage); the oldest event was evicted. |
| `wsmetering.DropShutdown` (`shutdown`) | Still queued when `Shutdown`'s deadline passed. `Shutdown` returns an error wrapping `ErrShutdownIncomplete`. |
| `wsmetering.DropClosed` (`closed`) | Recorded after `Shutdown`. |
| `wsmetering.DropRejected` (`rejected`) | The ingestor answered a non-retryable `4xx`, or refused individual events in a `2xx` partial-failure response. In the partial case only the events named by `errors[].index` are passed to `OnDrop`; failures the ingestor does not identify are counted but not attributed to an event. |
| `wsmetering.DropInvalid` (`invalid`) | The event failed client-side validation and was never buffered: a blank `customerId`, `customerId` over 64 characters or `productType` over 20 — `Open` returns `""` and the connection is not metered. The WARN log names the field, the limit and the value (throttled: first occurrence, then every 1000th); `OnError` is called too. |

A call with a blank customer id is not billed: it is dropped as `invalid`, counted in `DroppedCount()` and reported via `OnError`. An unknown `executionStatus` is not a drop either: the status is left off (or replaced by the derived one) and the event is sent.

```go
OnDrop: func(events []map[string]any, reason wsmetering.DropReason) {
	log.Printf("aforo: %d event(s) dropped: %s", len(events), reason)
},
```

Idempotency keys are minted once, when the event is recorded. Every retry and every resend after an outage carries the same key, so the ingestor deduplicates it. `DropRetryExhausted` (`retry_exhausted`) is kept for compatibility but is no longer reported: v2 keeps a failing batch queued instead of dropping it.

## What this doesn't cover

- **No automatic frame interception.** You call `RecordFrame` at your read/write sites — the SDK can't see your WebSocket library's traffic on its own.
- **Close-code → reason mapping is fixed.** Standard codes (1000–1011) map to a fixed reason set; codes ≥ 4000 all map to `IDLE_TIMEOUT`. There's no override hook.
- **No delivery guarantee on crash.** Events live in memory until sent; a hard crash loses the queue. `Shutdown(ctx)` sends what is left on graceful exit, bounded by `ShutdownTimeout`. The library installs no signal handler.
- **Customer id is yours to supply.** `Open` takes the id directly — decode it from your auth before calling.
