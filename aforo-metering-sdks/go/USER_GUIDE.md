# metering-go — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** Go engineers adding usage metering to an HTTP service or any code path that knows when a billable event happened.

## What you'll build

A Go service that sends one usage event per HTTP request (or per `Track` call) to Aforo's ingestor, batched and retried in the background, and that sends what is left when it shuts down. By the end you'll have sent a real event and confirmed it landed in Aforo.

## Prerequisites

- Go 1.21 or later.
- An Aforo API key (`AFORO_API_KEY`). The tenant comes from the key; the SDK takes no tenant id.
- A way to know the Aforo customer for a request from your own authentication (session, JWT subject, API-key lookup).
- The ingestor base URL — `https://api.aforo.ai` in production.

## Step 1 — Add the module

```bash
go get github.com/aforoai/SDKs/aforo-metering-sdks/go/v2
```

Until the `aforo-metering-sdks/go/v2.0.0` tag exists, clone github.com/aforoai/SDKs and point at it from your `go.mod`:

```go
require github.com/aforoai/SDKs/aforo-metering-sdks/go/v2 v2.0.0

replace github.com/aforoai/SDKs/aforo-metering-sdks/go/v2 => ../SDKs/aforo-metering-sdks/go
```

> ⚠ The `replace` target is a filesystem path relative to your `go.mod`. The package uses the standard library only.

## Step 2 — Create one client and close it on shutdown

```go
import (
	"context"
	"log"
	"os"
	"time"

	metering "github.com/aforoai/SDKs/aforo-metering-sdks/go/v2"
)

client, err := metering.NewClient(metering.Options{
	APIKey:  os.Getenv("AFORO_API_KEY"),
	BaseURL: "https://api.aforo.ai",
})
if err != nil {
	log.Fatal(err) // blank key, or a BaseURL that is not https
}

// In your shutdown path (after the HTTP server stopped accepting requests):
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()
if err := client.Close(ctx); err != nil {
	log.Printf("aforo: %v", err)
}
```

> ⚠ `Close` sends what is queued. It is bounded: it stops at the earlier of `ctx`'s deadline and `Options.ShutdownTimeout` (5 s), reports events still queued to `OnDrop` with reason `shutdown`, and returns an error wrapping `metering.ErrShutdownIncomplete`. The library installs no signal handler — call `Close` from yours.

## Step 3 — Meter one event per request with the middleware

```go
mw, err := metering.NewMiddleware(client, metering.MiddlewareOptions{
	MetricName: "api_calls", // must exist in your Aforo catalog
	CustomerResolver: func(r *http.Request) string {
		return customerFromSession(r) // your authenticated Aforo customer id
	},
})
if err != nil {
	log.Fatal(err)
}

mux := http.NewServeMux()
mux.HandleFunc("/v1/widgets", widgetsHandler)
http.ListenAndServe(":8080", mw(mux))
```

Chi: `r.Use(mw)` (or build it with `metering.ChiMiddleware(client, opts)`). Every route shares the client you passed in.

What the middleware does after the response is written:

- Skips `OPTIONS` requests, paths under `ExcludePaths` (defaults: `/health`, `/ready`, `/metrics`, `/favicon.ico`) and statuses in `ExcludeStatusCode`.
- Asks `CustomerResolver` for the customer. An empty answer is not billed: the event is dropped as `invalid` and counted in `DroppedCount()`. The request is never blocked.
- Records `MetricNameFunc(r)` if set and non-empty, otherwise `MetricName` (default `api_calls`), with `productType`, `endpointPath` (normalized, no query string), `httpMethod`, `statusCode` and `responseTimeMs`.

> ⚠ `NewMiddleware` refuses to build without `CustomerResolver` unless you set `TrustCustomerHeader: true`. That option bills the customer named in the `X-Customer-Id` header (or `CustomerIDHeader`). Callers of your API control that header, so use it only when a trusted proxy sets it and removes any value the client sent.

> ⚠ The metric must exist in your tenant's Aforo catalog. The ingestor rejects an unknown metric for the whole batch.

The middleware's response writer passes `Flush` and `Hijack` through and implements `Unwrap`, so server-sent events and WebSocket upgrades behind it keep working.

## Step 4 — Or meter explicitly with Track

```go
if err := client.Track(metering.TrackEvent{
	CustomerID: "cust_acme_001",
	MetricName: "report_generated",
	Quantity:   1,
	Metadata:   map[string]any{"format": "pdf"},
}); err != nil {
	log.Printf("aforo: %v", err) // ErrInvalidEvent or ErrClientClosed
}
```

Inside `Track`: a `Quantity` of `0` becomes `1`; an empty `OccurredAt` becomes now (UTC), a set one must be RFC 3339; `IdempotencyKey` defaults to a new random UUID. `Track` returns an error wrapping `metering.ErrInvalidEvent` (and queues nothing) for a blank `CustomerID`/`MetricName`, a negative/NaN/Inf `Quantity`, an unparseable `OccurredAt` or a field over the ingestor's limit.

> **Idempotency keys.** The key is minted once, when `Track` queues the event, and every resend carries it, so a retried or requeued batch is deduplicated by the ingestor. To deduplicate a logical event you replay yourself, set `IdempotencyKey`.

## Step 5 — Flush and verify it landed

```go
res, err := client.Flush(ctx)
log.Printf("aforo flush: sent=%d rejected=%d pending=%d err=%v", res.Sent, res.Rejected, res.Pending, err)
```

A clean run prints `rejected=0 pending=0 err=<nil>`. Then open the customer in the Aforo console and look at recent usage for the metric.

The wire call:

```
POST https://api.aforo.ai/v1/ingest/batch
X-API-Key: <AFORO_API_KEY>
Content-Type: application/json
User-Agent: aforo-go/2.0.0

{"events":[{"customerId":"cust_acme_001","metricName":"report_generated","quantity":1,"idempotencyKey":"…","occurredAt":"2026-10-26T…Z","productType":"API","metadata":{"format":"pdf"}}]}
```

> ⚠ `err == metering.ErrIngestUnavailable` means the ingestor could not be reached (or refused the key) after the retries. Nothing is lost: the events stay queued and go out when it recovers. `Rejected > 0` means the ingestor refused events (bad payload, unknown metric); they were reported to `OnDrop` with reason `rejected`.

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `APIKey` | `string` | — (required) | Sent only as `X-API-Key`; never logged or printed. |
| `BaseURL` | `string` | `https://api.aforo.ai` | Must be https (http only for localhost or with `AllowInsecureHTTP`). |
| `ProductType` | `string` | `API` | Top-level `productType`. |
| `FlushCount` | `int` | `500` | Events per request (max 1000). |
| `FlushInterval` | `time.Duration` | `5s` | Background send interval. |
| `MaxQueueSize` | `int` | `10000` | Queue capacity; when full the oldest event is dropped. |
| `MaxRetries` | `int` | `3` | Retries per batch; negative disables. |
| `RetryBase` | `time.Duration` | `500ms` | Full-jitter backoff base (cap 30 s; `Retry-After` honoured up to 60 s). |
| `Timeout` | `time.Duration` | `10s` | Total deadline per request. |
| `ShutdownTimeout` | `time.Duration` | `5s` | How long `Close` keeps sending. |
| `HTTPClient` | `*http.Client` | one pooled client | Your own client; you keep ownership. |
| `OnDrop` | `func([]TrackEvent, DropReason)` | `nil` | Events the SDK gives up on. |

## Dropped events

| `DropReason` | When |
|---|---|
| `overflow` | The queue was full (for example during a long outage); the oldest event was evicted. |
| `rejected` | The ingestor refused the event. |
| `invalid` | `Track` refused the event, or the middleware resolved no customer. |
| `shutdown` | Still queued at `Close`'s deadline. |
| `closed` | `Track` after `Close`. |

Every dropped event keeps its idempotency key; passing it to `Track` again after recovery cannot bill twice. Panics in `OnDrop` are recovered and logged.

## Execution status (outcome-based pricing)

`TrackEvent.ExecutionStatus` is optional. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value is WARN-logged and left off; the event is still sent. The middleware does not set a status.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `NewClient` returns an error about https | `BaseURL` is `http://` on a remote host | Use `https://`; for a local test server use `localhost`/`127.0.0.1`. |
| `NewMiddleware` returns `ErrNoCustomerResolver` | Neither `CustomerResolver` nor `TrustCustomerHeader` set | Add a resolver that returns your authenticated customer id. |
| `DroppedCount()` grows with reason `invalid` from the middleware | Your resolver returned `""` for some requests | Check those requests are authenticated; unauthenticated calls are not billed. |
| ERROR log "the API key is wrong or revoked" | `401`/`403` from the ingestor | Fix `AFORO_API_KEY`. The queued events are kept and sent once the key works. |
| `Flush` returns `ErrIngestUnavailable` | Ingestor unreachable | Nothing to do in code; events are kept. Check network/egress to `BaseURL`. |
| `Close` returns `ErrShutdownIncomplete` | The ingestor was slow or down during shutdown | Raise `ShutdownTimeout`, or persist the events your `OnDrop` receives with reason `shutdown`. |
| Two identical calls show as one event | Same explicit `IdempotencyKey` | Leave it empty or pass distinct keys. |

## What this guide does NOT cover

- **Defining metrics / rate plans.** Done in the Aforo console.
- **Customer identity.** You decode your auth; the SDK only calls your resolver.
- **Non-HTTP protocols.** Use `go-graphql`, `go-grpc`, `go-ws` or `go-mqtt`.
