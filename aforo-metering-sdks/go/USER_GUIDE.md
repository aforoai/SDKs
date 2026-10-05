# metering-go — User Guide

**Version:** 1.1.2 · **Updated:** 2026-10-01 · **Audience:** Go engineers adding usage metering to an HTTP service or any code path that knows when a billable event happened.

## What you'll build

A Go service that ships one usage event per HTTP request (or per manual `Track` call) to Aforo's ingestor, batched and retried in the background. By the end you'll have sent a real event and confirmed it landed in Aforo.

## Prerequisites

- Go 1.21+ (the module declares `go 1.21`).
- An Aforo API key (`AFORO_API_KEY`) whose scope already carries your `tenant_id`. The SDK does **not** take a tenant id — it rides on the key.
- A customer identifier per request. For the middleware path that's an inbound `X-Customer-Id` header your gateway/auth layer has already set; for the direct path it's whatever id you pass to `Track`.
- The ingestor base URL — `https://api.aforo.ai` in production.

## Step 1 — Add the module

Releases are git tags of the form `aforo-metering-sdks/go/vX.Y.Z` on github.com/aforoai/SDKs. Use `v1.1.2` or later: `v1.0.0` was tagged from an older copy of this code and lacks the fixes listed in the changelog. Until the `v1.1.2` tag exists, `go get github.com/aforoai/SDKs/aforo-metering-sdks/go@main` resolves to a pseudo-version of the default branch. To build against a local checkout, clone the repo and point at it with a `replace`:

```bash
git clone https://github.com/aforoai/SDKs.git
```

In your service's `go.mod`:

```go
require github.com/aforoai/SDKs/aforo-metering-sdks/go v1.1.2

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
	BaseURL: "https://api.aforo.ai",
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
	BaseURL: "https://api.aforo.ai",
})
http.ListenAndServe(":8080", wrapped)
```

What the middleware does, after the response is written:

- Skips `OPTIONS` (CORS preflight) requests.
- Resolves the customer id from `CustomerIDFunc` if set, otherwise from the `CustomerIDHeader` header (default `X-Customer-Id`). The caller's `X-Api-Key` is never used — it is a secret, not a customer id.
- Skips the request if the path matches an `ExcludePaths` prefix (defaults: `/health`, `/ready`, `/metrics`, `/favicon.ico`) or the status matches `ExcludeStatusCode`.
- Skips the request if no customer id resolved.
- Records the metric from `MetricNameFunc` if set and non-empty, otherwise `MetricName` (default `"api_calls"`).
- Also sends top-level `productType` (`MiddlewareOptions.ProductType`, default `API`), `endpointPath` (the normalized path without query string, capped at 512 chars), `httpMethod`, `statusCode` and `responseTimeMs`.

> ⚠ The metric must exist in your tenant's Aforo catalog: the ingestor rejects an unknown metric, and because it validates a batch as a whole, one rejected event fails every event in that batch. Earlier versions recorded `"<METHOD> <normalized-path>"`, which no catalog contains.

> ⚠ The customer id is read straight from a request header. Only trust that header behind your own auth/gateway. `HTTPMiddleware` creates and owns its own client internally — you don't pass it one; tune it via `ClientOptions`.

Chi users use the adapter instead:

```go
r.Use(metering.ChiMiddleware(metering.MiddlewareOptions{APIKey: os.Getenv("AFORO_API_KEY")}))
```

## Step 4 — Or meter explicitly with Track

When metering isn't one-per-request — a background job, a batch operation, a non-HTTP trigger — call `Track` directly:

```go
client.Track(metering.TrackEvent{
	CustomerID:  "cust_acme_001",
	MetricName:  "report_generated",
	Quantity:    1,
	ProductType: "API", // optional per-event override of Options.ProductType
	Metadata: map[string]any{
		"format": "pdf",
	},
})
```

Field defaults applied inside `Track`:

- `Quantity` of `0` becomes `1`.
- `ProductType` (top-level `productType`) is the event's value if set, else `Options.ProductType`, else `API`; trimmed and upper-cased, unknown values passed through.
- `OccurredAt`, when set, must be RFC 3339 and is normalized to UTC.

`Track` returns an error wrapping `metering.ErrInvalidEvent` (and buffers nothing) for a blank `CustomerID` / `MetricName`, a negative / NaN / Inf `Quantity`, an unparseable `OccurredAt`, or a field over the ingestor's limit. The event is also counted in `DroppedCount()` and passed to `OnDrop` with reason `invalid` (see [Dropped events](#dropped-events)).
- `OccurredAt` is set to now (`RFC3339Nano`, UTC) if empty.
- `IdempotencyKey` defaults to a fresh random UUID v4 per event if empty.

> **Idempotency keys.** Each event gets its own random key, so two genuinely distinct `Track` calls are never confused — even when they share customer, metric, quantity and `OccurredAt`. (It used to be SHA-256 of those four fields, which made same-timestamp calls collide so the ingestor silently dropped the second one.) The key is minted once, when `Track` enqueues the event, and never changes, so a retried batch is still deduplicated. **If you want dedup — e.g. an at-least-once pipeline replaying the same logical event — pass your own `IdempotencyKey`;** that value is sent verbatim and is the only thing the ingestor dedupes on.

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
POST https://api.aforo.ai/v1/ingest/batch
X-API-Key: <AFORO_API_KEY>
Content-Type: application/json

{"events":[{"customerId":"cust_acme_001","metricName":"report_generated","quantity":1,"idempotencyKey":"…","occurredAt":"2026-06-29T…Z","metadata":{"format":"pdf"}}]}
```

> ⚠ `FlushResult.Failed > 0` means events were dropped (retries exhausted, or rejected by the ingestor); `DroppedCount()` and `OnDrop` carry the same information for background flushes. A `4xx` other than `408`/`429` (bad key, malformed payload, unknown metric) is dropped immediately without retry — check the key, the metric name, and that the tenant on the key owns that metric.

## Configuration reference

`Options`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `APIKey` | `string` | — (required) | `X-API-Key: <APIKey>`. |
| `BaseURL` | `string` | `https://api.aforo.ai` | Ingestor base; `/v1/ingest/batch` is appended. |
| `ProductType` | `string` | `API` | Top-level `productType` on every event; `TrackEvent.ProductType` overrides per event. |
| `FlushCount` | `int` | `50` | Flush threshold + per-batch drain size (clamped to 1000). |
| `FlushInterval` | `time.Duration` | `5s` | Background flush cadence. |
| `MaxQueueSize` | `int` | `10000` | Ring-buffer capacity; oldest event dropped when full. |
| `MaxRetries` | `int` | `3` | Retry attempts per batch. |
| `RetryBase` | `time.Duration` | `1s` | Backoff base (`RetryBase × 2^attempt`). |
| `Timeout` | `time.Duration` | `10s` | Per-request HTTP timeout. |
| `ShutdownTimeout` | `time.Duration` | `5s` | Reserved for shutdown coordination. |
| `OnDrop` | `func([]TrackEvent, DropReason)` | `nil` | Opt-in hook called with events the SDK drops (`overflow`, `retry_exhausted`, `rejected`, `invalid`). See [Dropped events](#dropped-events). |

`MiddlewareOptions`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `APIKey` | `string` | — (required) | API key for the internal client. |
| `BaseURL` | `string` | `https://api.aforo.ai` | Ingestor base for the internal client. |
| `ExcludePaths` | `[]string` | `["/health","/ready","/metrics","/favicon.ico"]` | Path prefixes to skip; your value replaces the defaults. |
| `ExcludeStatusCode` | `[]int` | none | Status codes to skip. |
| `MetricName` | `string` | `api_calls` (`DefaultMetricName`) | Fixed metric recorded per request. Must exist in your Aforo catalog. |
| `MetricNameFunc` | `func(*http.Request) string` | nil | Per-request metric; wins over `MetricName`. An empty result falls back to `MetricName`. |
| `CustomerIDHeader` | `string` | `X-Customer-Id` | Header carrying the Aforo customer id. The caller's `X-Api-Key` is never read. |
| `CustomerIDFunc` | `func(*http.Request) string` | nil | Per-request customer id; wins over `CustomerIDHeader`. Empty result → request not metered. |
| `ProductType` | `string` | `ClientOptions.ProductType`, else `API` | Top-level `productType` on every metered request. |
| `ClientOptions` | `*Options` | nil | Full client tuning; `APIKey`/`BaseURL` above override it. |

## Dropped events

An event the SDK cannot deliver is never lost silently. `client.DroppedCount()` returns the running total, each drop is WARN-logged, and the opt-in `Options.OnDrop(events, reason)` hook receives the events as `TrackEvent`s with their idempotency keys, so passing them back to `Track` later is dedup-safe.

| `DropReason` | When |
|---|---|
| `metering.DropOverflow` (`overflow`) | The ring buffer was full; the oldest event was evicted. Log throttled (first, then every 1000th). |
| `metering.DropRetryExhausted` (`retry_exhausted`) | A batch failed after `MaxRetries` retries (transport error, `408`, `429`, `5xx`). |
| `metering.DropRejected` (`rejected`) | The ingestor answered a non-retryable `4xx`, or refused individual events in a `2xx` partial-failure response. In the partial case only the events named by `errors[].index` are passed to `OnDrop`; failures the ingestor does not identify are counted but not attributed to an event. |
| `metering.DropInvalid` (`invalid`) | `Track` refused the event (blank `CustomerID`/`MetricName`, negative/NaN/Inf `Quantity`, non-RFC 3339 `OccurredAt`, or a field over the ingestor's limit). `Track` also returns an error wrapping `metering.ErrInvalidEvent`. The WARN log names the field, the limit and the value (throttled: first, then every 1000th). Nothing you pass to `Track` is truncated or rounded. |

Field limits mirror the ingestor: `CustomerID` 64, `MetricName` 255, `IdempotencyKey` 255, `ProductType` 20, `EndpointPath` 512, `HTTPMethod` 16 characters; `Quantity` at most 14 integer digits and 6 decimal places. Limits the server makes configurable (event age, clock skew, metadata size) are left to the server. The HTTP middleware (`HTTPMiddleware`, `ChiMiddleware`) reads `endpointPath` and `httpMethod` from the incoming request, so it truncates them to 512 and 16 characters instead of dropping the event — otherwise a caller of your API could avoid metering with an over-long URL. The cut never splits a character, and a WARN is logged once per label. Values you pass to `Track` yourself are not truncated; over the limit they are dropped as `invalid`.

Idempotency keys are minted once, when `Track` enqueues the event (random UUID v4 unless you set `IdempotencyKey`). Retries re-send the same keys.

## Execution status (outcome-based pricing)

`TrackEvent.ExecutionStatus` is optional. OUTCOME_BASED rate plans bill each event at the weight set for its status; an event without a status bills at full weight. The SDK trims and upper-cases the value. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value (or one longer than 20 characters) is WARN-logged and left off; the event itself is still sent. The HTTP middleware does not set a status.

```go
client.Track(metering.TrackEvent{
	CustomerID:      "cust_acme_001",
	MetricName:      "api_calls",
	ExecutionStatus: "PARTIAL",
})
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Track` returns `ErrClientClosed` | `Close()` already ran on this client | Don't reuse a closed client; create a new one, or move `Close()` to actual shutdown. |
| Events never arrive, no error | Process exited before a flush and `Close()` wasn't called | Add `defer client.Close()` / call it in your signal handler. The buffer is in-memory only. |
| `Flush()` returns `Failed > 0` repeatedly | Bad API key, wrong `BaseURL`, or `4xx` from the ingestor | Verify `AFORO_API_KEY`, confirm `BaseURL`, and check the metric exists for the key's tenant. Non-`408`/`429` `4xx` is not retried. |
| Middleware records nothing for some requests | No resolvable customer id, excluded path prefix, or excluded status | Confirm `X-Customer-Id` (or your `CustomerIDHeader` / `CustomerIDFunc`) is set upstream and the path/status isn't in the exclude lists. |
| Two identical calls show as one event | You passed the same explicit `IdempotencyKey` for both | Leave `IdempotencyKey` empty (each event then gets its own UUID) or pass distinct keys. |
| Older events seem missing under load | Buffer hit `MaxQueueSize` and dropped oldest entries | Raise `MaxQueueSize`, lower `FlushInterval`, or lower `FlushCount` so flushes drain sooner. |

## What this guide does NOT cover

- **Defining metrics / rate plans in Aforo.** This guide gets events to the ingestor; modeling what those events bill is done in the Aforo console.
- **Customer-id extraction from JWTs/sessions.** You decode your auth and feed the id to the middleware header or to `Track` — the SDK only reads what you give it.
- **Non-HTTP protocol metering.** GraphQL / gRPC / WebSocket / MQTT have dedicated sibling SDKs (`go-graphql`, `go-grpc`, `go-ws`, `go-mqtt`).
