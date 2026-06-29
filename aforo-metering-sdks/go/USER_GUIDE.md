# metering-go — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Go engineers adding usage metering to an HTTP service or any code path that knows when a billable event happened.

## What you'll build

A Go service that ships one usage event per HTTP request (or per manual `Track` call) to Aforo's ingestor, batched and retried in the background. By the end you'll have sent a real event and confirmed it landed in Aforo.

## Prerequisites

- Go 1.21+ (the module declares `go 1.21`).
- An Aforo API key (`AFORO_API_KEY`) whose scope already carries your `tenant_id`. The SDK does **not** take a tenant id — it rides on the key.
- A customer identifier per request. For the middleware path that's an inbound `X-Customer-Id` header your gateway/auth layer has already set; for the direct path it's whatever id you pass to `Track`.
- The ingestor base URL — `https://ingest.aforo.ai` in production.

## Step 1 — Add the module from source

`go get github.com/aforoai/SDKs/aforo-metering-sdks/go` does not resolve yet (the module proxy isn't live). Clone the distribution repo and point at it with a `replace`:

```bash
git clone https://github.com/aforoai/SDKs.git
```

In your service's `go.mod`:

```go
require github.com/aforoai/SDKs/aforo-metering-sdks/go v1.0.0

replace github.com/aforoai/SDKs/aforo-metering-sdks/go => ../SDKs/aforo-metering-sdks/go
```

```bash
go mod tidy
```

> ⚠ The `replace` target is a filesystem path relative to YOUR `go.mod`. Adjust `../SDKs/...` to wherever you cloned. There are no third-party deps to fetch — the package is standard-library only.

## Step 2 — Create a client and wire shutdown

```go
import (
	"os"

	metering "github.com/aforoai/SDKs/aforo-metering-sdks/go"
)

client := metering.NewClient(metering.Options{
	APIKey:  os.Getenv("AFORO_API_KEY"),
	BaseURL: "https://ingest.aforo.ai",
})
defer client.Close()
```

> ⚠ `Close()` is the only thing that flushes the buffer on the way out. If you skip it (or your process is `kill -9`'d), in-flight events never leave the buffer. Wire `Close()` into your real shutdown path (signal handler / `defer` in `main`), not just a test.

## Step 3 — Meter one event per request with the middleware

If you want every HTTP request metered without editing handlers, wrap your router:

```go
import "net/http"

mux := http.NewServeMux()
mux.HandleFunc("/v1/widgets", widgetsHandler)

wrapped := metering.HTTPMiddleware(mux, metering.MiddlewareOptions{
	APIKey:  os.Getenv("AFORO_API_KEY"),
	BaseURL: "https://ingest.aforo.ai",
})
http.ListenAndServe(":8080", wrapped)
```

What the middleware does, after the response is written:

- Resolves the customer id from `X-Customer-Id`, then `X-Api-Key`, then your `CustomerIDHeader` if set (a non-empty `CustomerIDHeader` value wins).
- Skips the request if the path matches an `ExcludePaths` prefix (defaults: `/health`, `/ready`, `/metrics`, `/favicon.ico`) or the status matches `ExcludeStatusCode`.
- Skips the request if no customer id resolved.
- Records `MetricName` as `"<METHOD> <normalized-path>"`, where numeric / UUID / 24-hex Mongo-id segments collapse to `:id` (e.g. `GET /v1/widgets/8f3c… ` → `GET /v1/widgets/:id`). A `vN` version segment is left intact.

> ⚠ The customer id is read straight from a request header. Only trust that header behind your own auth/gateway. `HTTPMiddleware` creates and owns its own client internally — you don't pass it one; tune it via `ClientOptions`.

Chi users use the adapter instead:

```go
r.Use(metering.ChiMiddleware(metering.MiddlewareOptions{APIKey: os.Getenv("AFORO_API_KEY")}))
```

## Step 4 — Or meter explicitly with Track

When metering isn't one-per-request — a background job, a batch operation, a non-HTTP trigger — call `Track` directly:

```go
client.Track(metering.TrackEvent{
	CustomerID: "cust_acme_001",
	MetricName: "report_generated",
	Quantity:   1,
	Metadata: map[string]any{
		"format": "pdf",
	},
})
```

Field defaults applied inside `Track`:

- `Quantity` of `0` becomes `1`.
- `OccurredAt` is set to now (`RFC3339Nano`, UTC) if empty.
- `IdempotencyKey` is auto-derived (SHA-256 of `customerID:metricName:quantity:occurredAt`, first 32 hex chars) if empty.

> ⚠ The auto idempotency key is deterministic over those four fields. Two `Track` calls with the same customer, metric, quantity, AND timestamp string produce the same key and dedupe downstream. If you want each call counted separately, set a distinct `OccurredAt` or pass your own `IdempotencyKey`.

## Step 5 — Force a flush and verify it landed

The buffer flushes on its own (every `FlushInterval`, or immediately when it hits `FlushCount`), but to see an event now, flush explicitly and read the result:

```go
res := client.Flush()
log.Printf("aforo flush: sent=%d failed=%d", res.Sent, res.Failed)
```

A clean run prints `failed=0`. Then confirm server-side:

- In the Aforo console, open the customer (`cust_acme_001`) and look at recent usage events for the metric you sent.
- Or query the ingestion API for that tenant + metric over the last few minutes.

The wire call the SDK makes:

```
POST https://ingest.aforo.ai/v1/ingest/batch
Authorization: Bearer <AFORO_API_KEY>
Content-Type: application/json

{"events":[{"customerId":"cust_acme_001","metricName":"report_generated","quantity":1,"idempotencyKey":"…","occurredAt":"2026-06-29T…Z","metadata":{"format":"pdf"}}]}
```

> ⚠ `FlushResult.Failed > 0` means a batch exhausted retries. A `4xx` other than `408`/`429` (bad key, malformed payload, unknown metric) is dropped immediately without retry — check the key, the metric name, and that the tenant on the key owns that metric.

## Configuration reference

`Options`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `APIKey` | `string` | — (required) | `Authorization: Bearer <APIKey>`. |
| `BaseURL` | `string` | `https://ingest.aforo.ai` | Ingestor base; `/v1/ingest/batch` is appended. |
| `FlushCount` | `int` | `50` | Flush threshold + per-batch drain size. |
| `FlushInterval` | `time.Duration` | `5s` | Background flush cadence. |
| `MaxQueueSize` | `int` | `10000` | Ring-buffer capacity; oldest event dropped when full. |
| `MaxRetries` | `int` | `3` | Retry attempts per batch. |
| `RetryBase` | `time.Duration` | `1s` | Backoff base (`RetryBase × 2^attempt`). |
| `Timeout` | `time.Duration` | `10s` | Per-request HTTP timeout. |
| `ShutdownTimeout` | `time.Duration` | `5s` | Reserved for shutdown coordination. |

`MiddlewareOptions`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `APIKey` | `string` | — (required) | API key for the internal client. |
| `BaseURL` | `string` | `https://ingest.aforo.ai` | Ingestor base for the internal client. |
| `ExcludePaths` | `[]string` | `["/health","/ready","/metrics","/favicon.ico"]` | Path prefixes to skip; your value replaces the defaults. |
| `ExcludeStatusCode` | `[]int` | none | Status codes to skip. |
| `CustomerIDHeader` | `string` | `X-Customer-Id` then `X-Api-Key` | Extra header for the customer id; non-empty value wins. |
| `ClientOptions` | `*Options` | nil | Full client tuning; `APIKey`/`BaseURL` above override it. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Track` returns `ErrClientClosed` | `Close()` already ran on this client | Don't reuse a closed client; create a new one, or move `Close()` to actual shutdown. |
| Events never arrive, no error | Process exited before a flush and `Close()` wasn't called | Add `defer client.Close()` / call it in your signal handler. The buffer is in-memory only. |
| `Flush()` returns `Failed > 0` repeatedly | Bad API key, wrong `BaseURL`, or `4xx` from the ingestor | Verify `AFORO_API_KEY`, confirm `BaseURL`, and check the metric exists for the key's tenant. Non-`408`/`429` `4xx` is not retried. |
| Middleware records nothing for some requests | No resolvable customer id, excluded path prefix, or excluded status | Confirm `X-Customer-Id` (or your `CustomerIDHeader`) is set upstream and the path/status isn't in the exclude lists. |
| Two identical calls show as one event | Auto idempotency key collided (same customer/metric/quantity/`OccurredAt`) | Vary `OccurredAt` or pass a distinct `IdempotencyKey`. |
| Older events seem missing under load | Buffer hit `MaxQueueSize` and dropped oldest entries | Raise `MaxQueueSize`, lower `FlushInterval`, or lower `FlushCount` so flushes drain sooner. |

## What this guide does NOT cover

- **Defining metrics / rate plans in Aforo.** This guide gets events to the ingestor; modeling what those events bill is done in the Aforo console.
- **Customer-id extraction from JWTs/sessions.** You decode your auth and feed the id to the middleware header or to `Track` — the SDK only reads what you give it.
- **Non-HTTP protocol metering.** GraphQL / gRPC / WebSocket / MQTT have dedicated sibling SDKs (`go-graphql`, `go-grpc`, `go-ws`, `go-mqtt`).
