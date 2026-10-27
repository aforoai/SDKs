# graphql-metering-go — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** Go engineers metering a GraphQL-over-HTTP server (gqlgen, graphql-go, or a custom handler).

## What you'll build

A GraphQL server that emits one Aforo billing event per operation — type, name, complexity, error flag, duration — by wrapping the `/graphql` HTTP handler. By the end you'll have sent a real operation event and confirmed it landed in Aforo.

## Prerequisites

- Go 1.21+ (the module declares `go 1.21`).
- An Aforo API key (`AFORO_API_KEY`), a `tenant_id`, and a `product_id`. All three are SDK config — never read from a client header.
- A GraphQL HTTP handler that accepts POST with a JSON `{ "query": "...", "operationName": "..." }` body.
- A way to get the Aforo customer for a request from your own authentication (session, JWT subject, API-key lookup).
- Ingestor base URL — `https://api.aforo.ai`.

## Step 1 — Add the module

The import path ends in `/v2` (version 2 changed the public API; see the [changelog](CHANGELOG.md)). Releases are git tags `aforo-metering-sdks/go-graphql/v2.X.Y` on github.com/aforoai/SDKs. Until the `v2.0.0` tag exists, build against a local checkout with a `replace`:

```bash
git clone https://github.com/aforoai/SDKs.git
```

```go
// go.mod (your service)
require github.com/aforoai/SDKs/aforo-metering-sdks/go-graphql/v2 v2.0.0

replace github.com/aforoai/SDKs/aforo-metering-sdks/go-graphql/v2 => ../SDKs/aforo-metering-sdks/go-graphql
```

```bash
go mod tidy
```

> ⚠ Fix the `replace` path to where you actually cloned, relative to your `go.mod`. No third-party deps are fetched.

## Step 2 — Construct the Billing client

```go
import (
	"log"
	"os"

	graphqlmetering "github.com/aforoai/SDKs/aforo-metering-sdks/go-graphql/v2"
)

billing, err := graphqlmetering.New(graphqlmetering.Config{
	TenantID:    "tenant_acme",
	ProductID:   "prod_graphql_unified_gateway",
	APIKey:      os.Getenv("AFORO_API_KEY"),
	IngestorURL: "https://api.aforo.ai",
})
if err != nil {
	log.Fatal(err) // returned when any required field is empty
}
defer billing.Shutdown(context.Background()) // bounded by Config.ShutdownTimeout
```

> ⚠ `Shutdown(ctx)` sends what is queued, bounded by the earlier of `ctx`'s deadline and `ShutdownTimeout` (5 s). Events still queued then go to `OnDrop` with reason `shutdown` and `Shutdown` returns an error wrapping `ErrShutdownIncomplete`. Call it from your shutdown path; the library installs no signal handler.

## Step 3 — Wrap your GraphQL handler

```go
var graphqlHandler http.Handler = newGraphQLHandler() // gqlgen / graphql-go / custom
mw, err := billing.NewMiddleware(graphqlHandler) // needs Config.CustomerResolver (Step 4)
if err != nil {
	log.Fatal(err)
}
http.Handle("/graphql", mw)
log.Fatal(http.ListenAndServe(":8080", nil))
```

The middleware, after your handler responds:

- Finds the operation(s): POST JSON (a batch array gives one event each), POST `application/graphql`, GET `?query=`, or an Automatic Persisted Query hash. Requests with no operation pass through unmetered; a hash-only request answered with `PersistedQueryNotFound` is not billed (the client's resend is).
- Reads at most `MaxRequestBodyBytes` (1 MiB) of the body and gives your handler the whole body. A larger body is not held in memory and not metered (counted as `invalid`).
- Asks `CustomerResolver` for the customer; an empty answer is not billed and is counted as `invalid`.
- Emits one event with the detected operation type/name, complexity, field count, `hasErrors` (response status ≥ 400), and duration.

> ⚠ If another middleware ahead of this one reads the body without restoring it, the SDK sees no operation. Keep this wrapper close to the handler.

Operation name resolution: if `operationName` is absent in the body, the SDK pulls it from the document (`query MyName {...}` → `MyName`). An anonymous operation is recorded as `"anonymous"`.

## Step 4 — Tell the SDK who the customer is

`CustomerResolver` is required for the middleware (unless you opt into `TrustCustomerHeader`, which bills the customer named in `X-Customer-Id` — a header your callers control; use it only behind a proxy that sets it and strips client values):

```go
billing, _ := graphqlmetering.New(graphqlmetering.Config{
	TenantID:    "tenant_acme",
	ProductID:   "prod_graphql_unified_gateway",
	APIKey:      os.Getenv("AFORO_API_KEY"),
	IngestorURL: "https://api.aforo.ai",
	CustomerResolver: func(r *http.Request) string {
		return decodeJWTSubject(r.Header.Get("Authorization"))
	},
})
```

## Step 5 — Record an accurate complexity yourself (optional)

The built-in scorer is approximate (`field_count + 5 × max_depth` from brace balance + identifier tokens). If you have an AST-accurate number, bypass the middleware's auto-scoring and call `Record` from your executor:

```go
billing.Record(
	customerID,
	query,
	operationName,
	durationMs, // int64
	hasErrors,  // bool
)
```

`Record` ignores empty `customerID` or empty `query`.

## Step 6 — Verify it landed

The sender runs every `FlushInterval` (5s) or when `FlushCount` (500) events are queued. Send one operation, then call `billing.Flush(ctx)` (or `Shutdown(ctx)`), then check Aforo:

- In the console, open the customer and look for recent `graphql_api.operations` events.
- Or query the ingestion API for that tenant + metric over the last few minutes.

The wire call the SDK makes:

```
POST https://api.aforo.ai/v1/ingest/batch
X-API-Key: <AFORO_API_KEY>
X-Tenant-Id: tenant_acme
Content-Type: application/json

{"events":[{"customerId":"…","metricName":"graphql_api.operations","quantity":1,"occurredAt":"…","idempotencyKey":"gql:…","productType":"GRAPHQL_API","gqlOperationType":"QUERY","gqlOperationName":"…","gqlComplexity":12,"gqlFieldCount":7,"gqlHasErrors":false,"executionDurationMs":3,"metadata":{"sdkVersion":"1.0.0","productId":"prod_graphql_unified_gateway"}}]}
```

> ⚠ Drops are WARN-logged through the standard `log` package and counted in `DroppedCount()`; the reason for a failed flush is only reported to `OnError`. If nothing lands, set `OnError: func(err error){ log.Println("aforo:", err) }` to surface marshal failures, retry-exhausted drops and ingestor rejections (including `errors[].message`).

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `TenantID` | `string` | — (required) | `X-Tenant-Id` header + idempotency-key component. |
| `ProductID` | `string` | — (required) | Event metadata + idempotency-key component. |
| `APIKey` | `string` | — (required) | `X-API-Key: <APIKey>`. |
| `IngestorURL` | `string` | — (required) | Base; `/v1/ingest/batch` is appended. |
| `SchemaVersion` | `string` | none | Added to metadata as `schemaVersion` when set. |
| `ProductType` | `string` | `GRAPHQL_API` | Top-level `productType` on every event; per-event override via `EventOptions`. |
| `AllowInsecureHTTP` | `bool` | `false` | `IngestorURL` must be `https://`; plain `http://` is accepted only for `localhost`, `127.0.0.1`, `::1`, or with this set. |
| `FlushCount` | `int` | `500` | Events per request (max 1000); reaching it wakes the sender. |
| `FlushInterval` | `time.Duration` | `5s` | The sender also runs on this interval. |
| `MaxQueueSize` | `int` | `10000` | Queue capacity. When full the **oldest** event is dropped (`overflow`). |
| `MaxRetries` | `int` | `3` | Retries per batch; a negative value disables retries. |
| `RetryBase` | `time.Duration` | `500ms` | Full-jitter backoff base (each wait is random up to `min(30s, RetryBase × 2^attempt)`). |
| `Timeout` | `time.Duration` | `10s` | Total deadline per HTTP request. |
| `ShutdownTimeout` | `time.Duration` | `5s` | How long `Shutdown` keeps sending. |
| `HTTPClient` | `*http.Client` | one pooled client | Use your own client for every request; you keep ownership. |
| `CustomerResolver` | `func(*http.Request) string` | — (required for the middleware unless `TrustCustomerHeader`) | Per-request customer id from your authentication. |
| `TrustCustomerHeader` | `bool` | `false` | Bill the customer named in `CustomerIDHeader` (default `X-Customer-Id`). |
| `MaxRequestBodyBytes` | `int64` | `1048576` | Body bytes read to find the operation. |
| `OnError` | `func(error)` | no-op | Called when the ingestor rejects a batch or events (messages include its `errors[].message`), when it becomes unreachable (once per outage), when `Shutdown` leaves events unsent, for an event recorded after `Shutdown`, and when an event is invalid. Sending problems arrive as `*TransportError`: use `errors.As` and branch on `Kind` (`KindOutage`, `KindAuth`, `KindRejected`, `KindShutdown`, `KindClosed`); `Events` holds the events concerned. Invalid events arrive as a plain error. Runs on the background sender; it may call `Flush` or `Shutdown`. Never carries the API key. |
| `OnAccepted` | `func(body json.RawMessage, events []map[string]any)` | nil | Called after every `2xx` with the response's `data` object (envelope removed — for example `killedSessionIds`) and the events of that request. Same goroutine rules as `OnError`; panics are recovered. |
| `OnDrop` | `func([]map[string]any, DropReason)` | `nil` | Opt-in hook called with events the SDK gives up on (`overflow`, `rejected`, `invalid`, `shutdown`, `closed`). See [Dropped events](#dropped-events). |

## Dropped events

An event the SDK cannot deliver is never lost silently. `billing.DroppedCount()` returns the running total, each drop is WARN-logged, and the opt-in `Config.OnDrop(events, reason)` hook receives the events (with their idempotency keys, so re-submitting them later is dedup-safe).

| `DropReason` | When |
|---|---|
| `graphqlmetering.DropOverflow` (`overflow`) | The queue was full (for example during a long outage); the oldest event was evicted. |
| `graphqlmetering.DropShutdown` (`shutdown`) | Still queued when `Shutdown`'s deadline passed. `Shutdown` returns an error wrapping `ErrShutdownIncomplete`. |
| `graphqlmetering.DropClosed` (`closed`) | Recorded after `Shutdown`. |
| `graphqlmetering.DropRejected` (`rejected`) | The ingestor answered a non-retryable `4xx`, or refused individual events in a `2xx` partial-failure response. In the partial case only the events named by `errors[].index` are passed to `OnDrop`; failures the ingestor does not identify are counted but not attributed to an event. |
| `graphqlmetering.DropInvalid` (`invalid`) | The event failed client-side validation and was never buffered: `customerId` over 64 characters, or `productType` over 20. An operation name over 255 is not dropped — it comes from the client's request, so it is truncated to 255 characters without splitting a character, the event is sent, and a WARN is logged once (`Middleware` and `Record` alike). The invalid-drop WARN log names the field, the limit and the value (throttled: first occurrence, then every 1000th); `OnError` is called too. |

A call with a blank customer id is not billed: it is dropped as `invalid`, counted in `DroppedCount()` and reported via `OnError`. An unknown `executionStatus` is not a drop either: the status is left off (or replaced by the derived one) and the event is sent.

```go
OnDrop: func(events []map[string]any, reason graphqlmetering.DropReason) {
	log.Printf("aforo: %d event(s) dropped: %s", len(events), reason)
},
```

Idempotency keys are minted once, when the event is recorded. Every retry and every resend after an outage carries the same key, so the ingestor deduplicates it. `DropRetryExhausted` (`retry_exhausted`) is kept for compatibility but is no longer reported: v2 keeps a failing batch queued instead of dropping it.

## Execution status

See [Execution status (outcome-based pricing)](README.md#execution-status-outcome-based-pricing) in the README for the values, how the status is derived and how to set your own.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `New` returns an error | A required field (`TenantID`/`ProductID`/`APIKey`/`IngestorURL`) is empty | Set all four. There is no env auto-load. |
| No events for some requests | No operation in the request, body over `MaxRequestBodyBytes`, or `CustomerResolver` returned `""` | The last two are counted as `invalid` in `DroppedCount()`; check authentication runs before this middleware. |
| Resolvers receive an empty body | A body-draining middleware sits ahead of `Middleware` | Order so this wrapper reads/restores the body before others consume it. |
| Complexity scores look off | Built-in scorer is a brace-balance approximation | Compute an exact score and pass it via `Record()`; the middleware path always uses the approximation. |
| `OnError` reports "ingestor unavailable" | The ingestor is unreachable or answered `401`/`403` | Nothing is lost while the queue has room; verify `APIKey` and network access to `IngestorURL`. Events beyond `MaxQueueSize` are dropped as `overflow`. |
| All operations record as `anonymous` | No `operationName` in the body and no named operation in the document | Send `operationName`, or name your operations (`query Foo {...}`). |

## What this guide does NOT cover

- **Modeling GraphQL billing in Aforo.** Mapping `graphql_api.operations` (and the `gqlComplexity` field) to a rate plan is done in the Aforo console.
- **AST-accurate complexity.** The SDK gives an approximation; exact scoring is your code via `Record()`.
- **GraphQL subscriptions over WebSocket.** Use the `go-ws` SDK for long-lived WebSocket transports.
