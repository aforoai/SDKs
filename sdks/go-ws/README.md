# wsmetering — Aforo WebSocket Metering SDK for Go

Per-connection (and optionally per-frame) WebSocket billing. Framework-agnostic — works with `gorilla/websocket`, `nhooyr.io/websocket`, `gobwas/ws`, `net/http` upgrade, or any other WebSocket library.

## Install

```bash
go get github.com/aforo/ws-metering-go
```

Zero runtime deps.

## Usage — gorilla/websocket

```go
package main

import (
    "log"
    "net/http"
    "os"

    wsmetering "github.com/aforo/ws-metering-go"
    "github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{}

func main() {
    billing, _ := wsmetering.New(wsmetering.Config{
        TenantID:    "tenant_acme",
        ProductID:   "prod_ws_market_feed",
        APIKey:      os.Getenv("AFORO_API_KEY"),
        IngestorURL: "https://ingestor.aforo.ai",
    })
    defer billing.Shutdown()

    http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
        customerID := r.Header.Get("X-Customer-Id")
        if customerID == "" {
            http.Error(w, "missing customer id", 401)
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

## Billing strategy

Default mode emits **one** `CONNECTION_OPENED` event on `Open()` and **one** `CONNECTION_CLOSED` event on `Close()`, with aggregated counters from all `RecordFrame()` calls in between.

For per-frame billing, set `PerFrameEvents: true` on the config — each `RecordFrame()` call then emits an immediate event in addition to the open/close pair.

## Close-code mapping

Standard WebSocket close codes (1000-1011) map to descriptor enum (`NORMAL_CLOSURE`, `GOING_AWAY`, `PROTOCOL_ERROR`, `UNSUPPORTED_DATA`, `ABNORMAL_CLOSURE`, `POLICY_VIOLATION`, `MESSAGE_TOO_BIG`, `INTERNAL_ERROR`). Codes ≥ 4000 → `IDLE_TIMEOUT`.

## Batching & retry

100 events / 3 s defaults. 3× exponential retry. Call `Shutdown()` for graceful drain.

## License

MIT
