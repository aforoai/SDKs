# ws-metering-go — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** Go engineers metering a WebSocket server, with any WebSocket library.

## What you'll build

A WebSocket server that emits one Aforo `CONNECTION_OPENED` event when a connection opens and one `CONNECTION_CLOSED` event when it closes — the close event carrying duration, total frame count, and total bytes aggregated from your `RecordFrame` calls. Optionally, a per-frame event mode. By the end you'll have a real connection's open/close pair confirmed in Aforo.

## Prerequisites

- Go 1.21+ (the module declares `go 1.21`).
- A WebSocket library of your choice (gorilla/websocket, nhooyr.io/websocket, gobwas/ws, or a raw `net/http` upgrade).
- An Aforo API key (`AFORO_API_KEY`), a `tenant_id`, and a `product_id`. All three are SDK config — never read from a client header.
- A customer id per connection — you pass it to `Open`. Decode it from your auth (header, token, query).
- Ingestor base URL — `https://api.aforo.ai`.

## Step 1 — Add the module

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

> ⚠ Fix the `replace` path to your clone location. The SDK pulls no third-party deps; your WebSocket library is the only thing `go mod tidy` fetches.

## Step 2 — Construct the Billing client

```go
import (
	"log"
	"os"

	wsmetering "github.com/aforoai/SDKs/aforo-metering-sdks/go-ws/v2"
)

billing, err := wsmetering.New(wsmetering.Config{
	TenantID:    "tenant_acme",
	ProductID:   "prod_ws_market_feed",
	APIKey:      os.Getenv("AFORO_API_KEY"),
	IngestorURL: "https://api.aforo.ai",
})
if err != nil {
	log.Fatal(err) // returned when any required field is empty
}
defer billing.Shutdown(context.Background()) // bounded by Config.ShutdownTimeout
```

> ⚠ `Shutdown(ctx)` sends what is queued, bounded by the earlier of `ctx`'s deadline and `ShutdownTimeout` (5 s). Events still queued then go to `OnDrop` with reason `shutdown` and `Shutdown` returns an error wrapping `ErrShutdownIncomplete`. Call it from your shutdown path; the library installs no signal handler. It also closes every connection still open.

## Step 3 — Open a tracked connection

After upgrading, resolve the customer id and call `Open`. Hold the returned `connID`:

```go
connID := billing.Open(customerID, map[string]any{"path": r.URL.Path})
defer billing.Close(connID, websocket.CloseNormalClosure)
```

`Open` immediately queues a `CONNECTION_OPENED` event (`metricName` `websocket_api.connection_opened`, frame type `OPEN`). Pass the customer id your own authentication resolved. An empty `customerID` returns `""`, tracks nothing and is counted as `invalid` — guard for it before upgrading.

> ⚠ `defer billing.Close(connID, code)` directly under `Open`. The aggregated `CONNECTION_CLOSED` event — the one with duration + frame + byte totals — only fires from `Close`. Miss it and the connection's usage never ships and its state stays in the in-memory map.

## Step 4 — Count frames

Call `RecordFrame` at each read and write site you bill:

```go
billing.RecordFrame(connID, "CLIENT_TO_SERVER", "TEXT", int64(len(msg)))
// ... handle / echo ...
billing.RecordFrame(connID, "SERVER_TO_CLIENT", "TEXT", int64(len(msg)))
```

`RecordFrame(connID, direction, frameType, bytes)` increments the connection's frame and byte counters. By default it does **not** emit a per-frame event — those counters surface in the `CONNECTION_CLOSED` event. A `connID` not currently open is a no-op.

To emit one event per frame (high-volume — only when every message is billable), set `PerFrameEvents: true` on the config; each `RecordFrame` then also buffers an immediate event.

## Step 5 — Close and map the reason

```go
billing.Close(connID, websocket.CloseNormalClosure) // 1000
```

`Close(connID, closeCode)` removes the tracked connection and emits `CONNECTION_CLOSED` (`metricName` `websocket_api.connection_closed`) with duration, `messageCount` = total frames, `dataBytes` = total bytes, and a `wsCloseReason` mapped from the code. Calling `Close` on an already-closed (or unknown) `connID` is a no-op, so a `defer` plus an explicit `Close` won't double-emit.

Close-code mapping: `1000` → `NORMAL_CLOSURE`, `1001` → `GOING_AWAY`, `1002`/`1007` → `PROTOCOL_ERROR`, `1003` → `UNSUPPORTED_DATA`, `1006` → `ABNORMAL_CLOSURE`, `1008` → `POLICY_VIOLATION`, `1009` → `MESSAGE_TOO_BIG`, `1011` → `INTERNAL_ERROR`, anything `≥ 4000` → `IDLE_TIMEOUT`, everything else → `NORMAL_CLOSURE`.

## Step 6 — Verify it landed

The sender runs every `FlushInterval` (5s) or when `FlushCount` (500) events are queued. Open and close one connection, then call `billing.Flush(ctx)` (or `Shutdown(ctx)`), then check Aforo:

- In the console, open the customer and look for recent `websocket_api.connection_opened` (open) and `websocket_api.connection_closed` (close) events.
- Or query the ingestion API for that tenant + those metrics.

The wire call the SDK makes:

```
POST https://api.aforo.ai/v1/ingest/batch
X-API-Key: <AFORO_API_KEY>
X-Tenant-Id: tenant_acme
Content-Type: application/json

{"events":[{"customerId":"…","metricName":"websocket_api.connection_closed","quantity":1,"occurredAt":"…","idempotencyKey":"ws:…","productType":"WEBSOCKET_API","wsConnectionId":"ws_…","wsDirection":"SERVER_TO_CLIENT","wsFrameType":"CLOSE","messageCount":42,"dataBytes":8192,"executionDurationMs":15300,"wsCloseReason":"NORMAL_CLOSURE","metadata":{"path":"/ws","event":"CONNECTION_CLOSED","frames":42,"bytes":8192,"closeCode":1000,"sdkVersion":"1.0.0","productId":"prod_ws_market_feed"}}]}
```

> ⚠ Drops are WARN-logged through the standard `log` package and counted in `DroppedCount()`; the reason for a failed flush is only reported to `OnError`. If nothing lands, set `OnError: func(err error){ log.Println("aforo:", err) }` to surface marshal failures, retry-exhausted drops and ingestor rejections (including `errors[].message`).

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `TenantID` | `string` | — (required) | `X-Tenant-Id` header + idempotency-key component. |
| `ProductID` | `string` | — (required) | Event metadata + idempotency-key component. |
| `APIKey` | `string` | — (required) | `X-API-Key: <APIKey>`. |
| `IngestorURL` | `string` | — (required) | Base; `/v1/ingest/batch` is appended. |
| `PerFrameEvents` | `bool` | `false` | Per-frame event emission in addition to open/close. |
| `ProductType` | `string` | `WEBSOCKET_API` | Top-level `productType` on every event; per-event override via `EventOptions`. |
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

## Dropped events

An event the SDK cannot deliver is never lost silently. `billing.DroppedCount()` returns the running total, each drop is WARN-logged, and the opt-in `Config.OnDrop(events, reason)` hook receives the events (with their idempotency keys, so re-submitting them later is dedup-safe).

| `DropReason` | When |
|---|---|
| `wsmetering.DropOverflow` (`overflow`) | The queue was full (for example during a long outage); the oldest event was evicted. |
| `wsmetering.DropShutdown` (`shutdown`) | Still queued when `Shutdown`'s deadline passed. `Shutdown` returns an error wrapping `ErrShutdownIncomplete`. |
| `wsmetering.DropClosed` (`closed`) | Recorded after `Shutdown`. |
| `wsmetering.DropRejected` (`rejected`) | The ingestor answered a non-retryable `4xx`, or refused individual events in a `2xx` partial-failure response. In the partial case only the events named by `errors[].index` are passed to `OnDrop`; failures the ingestor does not identify are counted but not attributed to an event. |
| `wsmetering.DropInvalid` (`invalid`) | The event failed client-side validation and was never buffered: `customerId` over 64 characters or `productType` over 20 — `Open` returns `""` and the connection is not metered. The WARN log names the field, the limit and the value (throttled: first occurrence, then every 1000th); `OnError` is called too. |

A call with a blank customer id is not billed: it is dropped as `invalid`, counted in `DroppedCount()` and reported via `OnError`. An unknown `executionStatus` is not a drop either: the status is left off (or replaced by the derived one) and the event is sent.

```go
OnDrop: func(events []map[string]any, reason wsmetering.DropReason) {
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
| `Open` returns `""` | Empty `customerID` | Resolve the customer id (from auth) before `Open`; nothing is tracked for an empty id. |
| No `CONNECTION_CLOSED` event | `Close` never ran for that `connID` | `defer billing.Close(connID, code)` right after `Open`; the close event carries the totals. |
| Frame/byte totals are zero | `RecordFrame` calls used a stale or wrong `connID` | Pass the exact `connID` `Open` returned; an unknown id is a silent no-op. |
| Event volume too high | `PerFrameEvents: true` on a chatty feed | Turn it off (default) to emit only open + close with aggregated counters. |
| `OnError` reports "ingestor unavailable" | The ingestor is unreachable or answered `401`/`403` | Nothing is lost while the queue has room; verify `APIKey` and network access to `IngestorURL`. Events beyond `MaxQueueSize` are dropped as `overflow`. |

## What this guide does NOT cover

- **Modeling WebSocket billing in Aforo.** Mapping `websocket_api.connection_opened` / `websocket_api.message` / `websocket_api.connection_closed` (and fields like `dataBytes` / `messageCount`) to a rate plan is done in the Aforo console.
- **Automatic traffic capture.** You instrument your read/write sites with `RecordFrame`; the SDK doesn't hook your WebSocket library.
- **GraphQL subscriptions over WebSocket as operations.** This meters raw WebSocket connections/frames; per-GraphQL-operation billing is the `go-graphql` SDK over HTTP.
