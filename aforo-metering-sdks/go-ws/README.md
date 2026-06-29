# ws-metering-go

Per-connection (and optionally per-frame) WebSocket metering for Go. Framework-agnostic — `gorilla/websocket`, `nhooyr.io/websocket`, `gobwas/ws`, or a raw `net/http` upgrade. You call `Open`, `RecordFrame`, and `Close`; the SDK aggregates per-connection counters and emits a connection-opened + connection-closed event pair to Aforo.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

Reach for this when you bill WebSocket usage by connection (with duration, frame count, and byte totals) and want one open/close event pair per connection — with a per-frame mode for the cases where every message is billable.

## Install

Intended public install once published:

```bash
go get github.com/aforoai/SDKs/aforo-metering-sdks/go-ws
```

**Not yet published — `go get github.com/aforoai/SDKs/aforo-metering-sdks/go-ws` resolves once this repo is public and the module is tagged** (`aforo-metering-sdks/go-ws/v1.0.0`). Until then, vendor it from source with a local `replace`:

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
		IngestorURL: "https://ingest.aforo.ai",
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

## Configuration

`Config`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `TenantID` | `string` | — (required) | Sent as the `X-Tenant-Id` header on every flush and embedded in idempotency keys. Set by you, never from a client header. |
| `ProductID` | `string` | — (required) | Recorded in event metadata + idempotency keys. |
| `APIKey` | `string` | — (required) | Sent as `Authorization: Bearer <APIKey>`. |
| `IngestorURL` | `string` | — (required) | Ingestor base; the SDK appends `/v1/ingest/events`. Use `https://ingest.aforo.ai`. |
| `PerFrameEvents` | `bool` | `false` | When true, each `RecordFrame` emits an immediate event **in addition** to the open/close pair. Off by default — open + close only. |
| `FlushCount` | `int` | `100` | Flush when the buffer reaches this many events. |
| `FlushInterval` | `time.Duration` | `3s` | Background flush cadence. |
| `HTTPClient` | `*http.Client` | `&http.Client{Timeout: 10s}` | Override the HTTP client used for flushing. |
| `OnError` | `func(error)` | no-op | Called on a marshal failure or a flush that exhausts its 3 retries (events dropped). |

`New` returns an error if `TenantID`, `ProductID`, `APIKey`, or `IngestorURL` is empty.

## Walk me through it

Step-by-step from install to "I can see the connection in Aforo" lives in [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **No automatic frame interception.** You call `RecordFrame` at your read/write sites — the SDK can't see your WebSocket library's traffic on its own.
- **Close-code → reason mapping is fixed.** Standard codes (1000–1011) map to a fixed reason set; codes ≥ 4000 all map to `IDLE_TIMEOUT`. There's no override hook.
- **No delivery guarantee on crash.** Events live in memory until flushed; a hard crash before a flush loses the buffer, and a connection whose `Close` never ran never ships its `CONNECTION_CLOSED` event. `Shutdown()` drains on graceful exit.
- **Customer id is yours to supply.** `Open` takes the id directly — decode it from your auth before calling.
