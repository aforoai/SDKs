# metering-go

A zero-dependency Go metering client for Aforo. Buffer usage events in-process, batch them, and ship them to Aforo's ingestor with retry — plus an `http.Handler` middleware (and a Chi adapter) that meters every request without touching your handler code.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

Reach for this when your Go service already knows who the customer is and what to count, and you want Aforo to own buffering, batching, and retry instead of writing that yourself. The middleware path is for the common case: meter one event per HTTP request, keyed by an inbound customer-id header, with no per-handler changes.

## Install

Intended public install once published:

```bash
go get github.com/aforoai/SDKs/aforo-metering-sdks/go
```

**Not yet published — `go get github.com/aforoai/SDKs/aforo-metering-sdks/go` resolves once this repo is public and the module is tagged** (`aforo-metering-sdks/go/v1.0.0`). Until then, vendor it from source with a local `replace`:

```bash
# 1. Clone the SDK distribution repo next to your service
git clone https://github.com/aforoai/SDKs.git

# 2. In YOUR service's go.mod, add the import + a replace pointing at the clone
#    (adjust the relative path to where you cloned it)
```

```go
// go.mod (your service)
require github.com/aforoai/SDKs/aforo-metering-sdks/go v1.0.0

replace github.com/aforoai/SDKs/aforo-metering-sdks/go => ../SDKs/aforo-metering-sdks/go
```

```bash
go mod tidy
```

The package itself pulls in nothing beyond the standard library.

## Quickstart

Direct client — you call `Track` when you know an event happened:

```go
package main

import (
	"os"

	metering "github.com/aforoai/SDKs/aforo-metering-sdks/go"
)

func main() {
	client := metering.NewClient(metering.Options{
		APIKey:  os.Getenv("AFORO_API_KEY"),
		BaseURL: "https://ingest.aforo.ai", // default; override per environment
	})
	defer client.Close() // flushes the buffer before exit

	client.Track(metering.TrackEvent{
		CustomerID: "cust_acme_001",
		MetricName: "api_calls",
		Quantity:   1,
	})
}
```

`Track` is non-blocking — it pushes onto an in-memory ring buffer and returns. A background goroutine flushes every `FlushInterval`, and any `Track` that pushes the buffer to `FlushCount` triggers an immediate flush. `Close()` stops the goroutine and flushes what's left; skip it and buffered events die with the process.

Middleware — one metered event per HTTP request, no handler changes:

```go
package main

import (
	"net/http"
	"os"

	metering "github.com/aforoai/SDKs/aforo-metering-sdks/go"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/widgets", widgetsHandler)

	wrapped := metering.HTTPMiddleware(mux, metering.MiddlewareOptions{
		APIKey:  os.Getenv("AFORO_API_KEY"),
		BaseURL: "https://ingest.aforo.ai",
	})
	http.ListenAndServe(":8080", wrapped)
}
```

The middleware reads the customer id from `X-Customer-Id` (falling back to `X-Api-Key`), records `"<METHOD> <normalized-path>"` as the metric name — e.g. `GET /v1/widgets/:id` — and emits after the response is written. Requests with no resolvable customer id are not metered.

> ⚠ The customer id comes from a request header here. That's the convention for a service sitting behind your own auth/gateway that has already verified the caller. `tenant_id` is never read from a client header — set it through your Aforo API key's scope, not the request.

Chi router:

```go
r := chi.NewRouter()
r.Use(metering.ChiMiddleware(metering.MiddlewareOptions{
	APIKey: os.Getenv("AFORO_API_KEY"),
}))
```

## Configuration

`Options` (client):

| Option | Type | Default | What it does |
|---|---|---|---|
| `APIKey` | `string` | — (required) | Sent as `Authorization: Bearer <APIKey>`. |
| `BaseURL` | `string` | `https://ingest.aforo.ai` | Ingestor base; the client appends `/v1/ingest/batch`. Override per environment. |
| `FlushCount` | `int` | `50` | Flush when the buffer reaches this many events; also the per-batch drain size. |
| `FlushInterval` | `time.Duration` | `5s` | Background flush cadence. |
| `MaxQueueSize` | `int` | `10000` | Ring-buffer capacity. When full, the **oldest** event is dropped to make room. |
| `MaxRetries` | `int` | `3` | Retry attempts per batch on a transport error or retryable status. |
| `RetryBase` | `time.Duration` | `1s` | Base for exponential backoff (`RetryBase × 2^attempt`). |
| `Timeout` | `time.Duration` | `10s` | Per-request HTTP timeout. |
| `ShutdownTimeout` | `time.Duration` | `5s` | Accepted by `Options`; reserved for shutdown coordination. |

`MiddlewareOptions`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `APIKey` | `string` | — (required) | API key for the internally-created client. |
| `BaseURL` | `string` | `https://ingest.aforo.ai` | Ingestor base for the internal client. |
| `ExcludePaths` | `[]string` | `["/health","/ready","/metrics","/favicon.ico"]` | Path **prefixes** to skip. Setting your own replaces the defaults. |
| `ExcludeStatusCode` | `[]int` | none | Response status codes to skip (e.g. `404`). |
| `CustomerIDHeader` | `string` | `X-Customer-Id` (then `X-Api-Key`) | Extra header checked for the customer id; if present and non-empty it wins. |
| `ClientOptions` | `*Options` | nil | Full client tuning; `APIKey`/`BaseURL` from `MiddlewareOptions` override its fields. |

Retry rule (in `transport`): `2xx` → sent; `4xx` except `408`/`429` → dropped, no retry; everything else (including `5xx`, `408`, `429`) is retried with backoff, honoring `Retry-After` on a `429`.

## Walk me through it

Step-by-step from install to "I can see the event in Aforo" lives in [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **No broker/queue metering.** This is an HTTP-request + manual-`Track` client. For GraphQL, gRPC, WebSocket, or MQTT use the sibling Go SDKs (`go-graphql`, `go-grpc`, `go-ws`, `go-mqtt`).
- **No automatic customer-id discovery.** The middleware only knows the customer from a header (or your `CustomerIDHeader`); JWT/session decoding is yours to wire — read the header you control and pass the id to `Track` directly.
- **No delivery guarantee on crash.** Events live in memory until flushed. A hard crash before a flush loses the buffer, and an overflowing buffer drops the oldest events. Call `Close()` on graceful shutdown.
