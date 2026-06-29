# ws-metering-go — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Go engineers metering a WebSocket server, with any WebSocket library.

## What you'll build

A WebSocket server that emits one Aforo `CONNECTION_OPENED` event when a connection opens and one `CONNECTION_CLOSED` event when it closes — the close event carrying duration, total frame count, and total bytes aggregated from your `RecordFrame` calls. Optionally, a per-frame event mode. By the end you'll have a real connection's open/close pair confirmed in Aforo.

## Prerequisites

- Go 1.21+ (the module declares `go 1.21`).
- A WebSocket library of your choice (gorilla/websocket, nhooyr.io/websocket, gobwas/ws, or a raw `net/http` upgrade).
- An Aforo API key (`AFORO_API_KEY`), a `tenant_id`, and a `product_id`. All three are SDK config — never read from a client header.
- A customer id per connection — you pass it to `Open`. Decode it from your auth (header, token, query).
- Ingestor base URL — `https://ingest.aforo.ai`.

## Step 1 — Add the module from source

`go get github.com/aforoai/SDKs/aforo-metering-sdks/go-ws` does not resolve yet (proxy not live). Clone and `replace`:

```bash
git clone https://github.com/aforoai/SDKs.git
```

```go
// go.mod (your service)
require github.com/aforoai/SDKs/aforo-metering-sdks/go-ws v1.0.0

replace github.com/aforoai/SDKs/aforo-metering-sdks/go-ws => ../SDKs/aforo-metering-sdks/go-ws
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

	wsmetering "github.com/aforoai/SDKs/aforo-metering-sdks/go-ws"
)

billing, err := wsmetering.New(wsmetering.Config{
	TenantID:    "tenant_acme",
	ProductID:   "prod_ws_market_feed",
	APIKey:      os.Getenv("AFORO_API_KEY"),
	IngestorURL: "https://ingest.aforo.ai",
})
if err != nil {
	log.Fatal(err) // returned when any required field is empty
}
defer billing.Shutdown()
```

> ⚠ `Shutdown()` flushes the buffer and waits for the flush loop. Skip it and pending events die with the process.

## Step 3 — Open a tracked connection

After upgrading, resolve the customer id and call `Open`. Hold the returned `connID`:

```go
connID := billing.Open(customerID, map[string]any{"path": r.URL.Path})
defer billing.Close(connID, websocket.CloseNormalClosure)
```

`Open` immediately buffers a `CONNECTION_OPENED` event (`metricName` `websocket_api.message`, frame type `PING`). An empty `customerID` returns `""` and tracks nothing — guard for it before upgrading.

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

The buffer flushes every `FlushInterval` (3s) or when it reaches `FlushCount` (100). Open and close one connection, wait ~4 seconds (or `Shutdown()` to force a drain), then check Aforo:

- In the console, open the customer and look for recent `websocket_api.message` (open) and `websocket_api.connection_closed` (close) events.
- Or query the ingestion API for that tenant + those metrics.

The wire call the SDK makes:

```
POST https://ingest.aforo.ai/v1/ingest/events
Authorization: Bearer <AFORO_API_KEY>
X-Tenant-Id: tenant_acme
Content-Type: application/json

{"events":[{"customerId":"…","metricName":"websocket_api.connection_closed","quantity":1,"occurredAt":"…","idempotencyKey":"ws:…","productType":"WEBSOCKET_API","wsConnectionId":"ws_…","wsDirection":"SERVER_TO_CLIENT","wsFrameType":"CLOSE","messageCount":42,"dataBytes":8192,"durationMs":15300,"wsCloseReason":"NORMAL_CLOSURE","metadata":{"path":"/ws","event":"CONNECTION_CLOSED","frames":42,"bytes":8192,"closeCode":1000,"sdkVersion":"1.0.0","productId":"prod_ws_market_feed"}}]}
```

> ⚠ Flush failures are silent unless you set `OnError`. If nothing lands, set `OnError: func(err error){ log.Println("aforo:", err) }` to surface marshal failures and retry-exhausted drops.

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `TenantID` | `string` | — (required) | `X-Tenant-Id` header + idempotency-key component. |
| `ProductID` | `string` | — (required) | Event metadata + idempotency-key component. |
| `APIKey` | `string` | — (required) | `Authorization: Bearer <APIKey>`. |
| `IngestorURL` | `string` | — (required) | Base; `/v1/ingest/events` is appended. |
| `PerFrameEvents` | `bool` | `false` | Per-frame event emission in addition to open/close. |
| `FlushCount` | `int` | `100` | Buffer-size flush threshold. |
| `FlushInterval` | `time.Duration` | `3s` | Background flush cadence. |
| `HTTPClient` | `*http.Client` | `&http.Client{Timeout: 10s}` | HTTP client override. |
| `OnError` | `func(error)` | no-op | Marshal failures + retry-exhausted drops. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `New` returns an error | A required field is empty | Set `TenantID`, `ProductID`, `APIKey`, `IngestorURL`. |
| `Open` returns `""` | Empty `customerID` | Resolve the customer id (from auth) before `Open`; nothing is tracked for an empty id. |
| No `CONNECTION_CLOSED` event | `Close` never ran for that `connID` | `defer billing.Close(connID, code)` right after `Open`; the close event carries the totals. |
| Frame/byte totals are zero | `RecordFrame` calls used a stale or wrong `connID` | Pass the exact `connID` `Open` returned; an unknown id is a silent no-op. |
| Event volume too high | `PerFrameEvents: true` on a chatty feed | Turn it off (default) to emit only open + close with aggregated counters. |
| Events drop with no log | Flush exhausted 3 retries and `OnError` is unset | Set `OnError`; verify `APIKey`, `IngestorURL`, and that the tenant owns the metric. |

## What this guide does NOT cover

- **Modeling WebSocket billing in Aforo.** Mapping `websocket_api.message` / `websocket_api.connection_closed` (and fields like `dataBytes` / `messageCount`) to a rate plan is done in the Aforo console.
- **Automatic traffic capture.** You instrument your read/write sites with `RecordFrame`; the SDK doesn't hook your WebSocket library.
- **GraphQL subscriptions over WebSocket as operations.** This meters raw WebSocket connections/frames; per-GraphQL-operation billing is the `go-graphql` SDK over HTTP.
