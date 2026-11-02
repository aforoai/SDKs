# graphql-metering-go

Per-operation GraphQL metering for Go servers. Wrap your `/graphql` HTTP handler (gqlgen, graphql-go, or anything that speaks the GraphQL-over-HTTP POST shape) and Aforo gets one billing event per operation — operation type, name, an approximate complexity score, error flag, and duration — batched and retried in the background.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

Reach for this when you bill GraphQL by the operation (or by complexity tier) and want the type/name/complexity extracted for you at the HTTP boundary, or when you already compute an accurate complexity score and just want a clean `Record()` to ship it.

## Install


```bash
go get github.com/aforoai/SDKs/aforo-metering-sdks/go-graphql/v2
```

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

Standard-library only — no third-party runtime deps.

## Quickstart

HTTP middleware — meter every GraphQL POST without touching resolvers:

```go
package main

import (
	"context"
	"log"
	"net/http"
	"os"

	graphqlmetering "github.com/aforoai/SDKs/aforo-metering-sdks/go-graphql/v2"
)

func main() {
	billing, err := graphqlmetering.New(graphqlmetering.Config{
		TenantID:    "tenant_acme",
		ProductID:   "prod_graphql_unified_gateway",
		APIKey:      os.Getenv("AFORO_API_KEY"),
		IngestorURL: "https://api.aforo.ai",
		CustomerResolver: func(r *http.Request) string {
			return customerFromSession(r) // your authenticated Aforo customer id
		},
	})
	if err != nil {
		log.Fatal(err)
	}
	defer billing.Shutdown(context.Background()) // bounded by Config.ShutdownTimeout

	var graphqlHandler http.Handler = /* your gqlgen/graphql-go handler */ nil
	mw, err := billing.NewMiddleware(graphqlHandler)
	if err != nil {
		log.Fatal(err) // ErrNoCustomerResolver
	}
	http.Handle("/graphql", mw)
	log.Fatal(http.ListenAndServe(":8080", nil))
}
```

The middleware runs your handler, then emits one event per GraphQL operation with `metricName` `"graphql_api.operations"`. It meters POST with a JSON body (a batch array gives one event per operation), POST with `Content-Type: application/graphql`, GET with `query` in the URL, and Automatic Persisted Queries (the `sha256Hash` goes to metadata as `persistedQueryHash`). A hash-only request the server answers with `PersistedQueryNotFound` is not billed — the client resends it with the query, and that request is billed. Requests that carry no operation pass through unmetered.

The customer comes from `CustomerResolver`, which you write from your own authentication. `NewMiddleware` returns `ErrNoCustomerResolver` without one unless you set `TrustCustomerHeader: true`, which bills the customer named in `X-Customer-Id` (or `CustomerIDHeader`) — callers control that header, so use it only behind a proxy that sets it and strips client values. `Middleware(next)` is the same but panics at wiring time instead of returning the error. A request whose resolver returns `""` is served as usual but not billed: it is counted as `invalid`.

> ⚠ The middleware reads at most `MaxRequestBodyBytes` (default 1 MiB) of the body to find the operation, then gives your handler the whole body, unchanged. A larger body is passed through without being held in memory and is not metered (counted as `invalid`). The response writer passes `Flush` and `Hijack` through, so subscriptions over SSE or WebSocket keep working.

Manual recording — when you compute an accurate complexity yourself:

```go
billing.Record(customerID, query, operationName, durationMs, hasErrors)
```

Product type: every event carries a top-level `productType` — `Config.ProductType` (default `"GRAPHQL_API"`). `Record` accepts optional trailing `graphqlmetering.EventOptions` to override it; the same options carry `ExecutionStatus`, and `RecordWithOptions` is the single-options form. Example:

```go
billing.Record(customerID, query, operationName, durationMs, hasErrors,
	graphqlmetering.EventOptions{ProductType: "AGENTIC_API"})
```

How events are sent: every `Record`/`Open`/`Close` call appends to a bounded queue (`MaxQueueSize`, default 10 000) and returns; it never starts a goroutine or makes a request. One background sender per `Billing` posts `{"events":[...]}` to `/v1/ingest/batch` in batches of up to `FlushCount` (default 500, at most 1000), with `X-API-Key` and `User-Agent: aforo-go-graphql/2.0.0`. Network errors, timeouts, `408`, `429` and `5xx` are retried with full-jitter backoff; `Retry-After` is honoured in both forms (seconds or HTTP date) up to 60 s. Each request, including reading the response body, is cut off at `Timeout`. Redirects are never followed (the API key must not reach another host): a `3xx` is logged at ERROR with the target host and handled like an outage. When retries run out — or the ingestor answers `401`/`403` or `3xx` — the batch goes back to the front of the queue with the same idempotency keys and the sender pauses (a random wait up to 5 s, doubling to 5 min, at least 250 ms); nothing is dropped and the ingestor deduplicates the resend. Events a `2xx` names in `errors[]` with `retryable: true` are resent after the same backoff, at most `MaxRetries` times, then handled as an outage. `413` splits the batch; any other `4xx` drops it as `rejected` and reports it via `OnError`. `Shutdown(ctx)` keeps sending — and retrying an unreachable ingestor — until the earlier of `ctx`'s deadline and `ShutdownTimeout` (5 s) and reports the rest as `shutdown` (see [Dropped events](#dropped-events)).

## Configuration

`Config`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `TenantID` | `string` | — (required) | Sent as the `X-Tenant-Id` header on every flush and embedded in idempotency keys. Set by you, never from a client header. |
| `ProductID` | `string` | — (required) | Recorded in event metadata + idempotency keys. |
| `APIKey` | `string` | — (required) | Sent as `X-API-Key: <APIKey>`. |
| `IngestorURL` | `string` | — (required) | Ingestor base; the SDK appends `/v1/ingest/batch`. Use `https://api.aforo.ai`. |
| `SchemaVersion` | `string` | none | If set, attached to event metadata as `schemaVersion`. |
| `ProductType` | `string` | `GRAPHQL_API` | Top-level `productType` on every event (required by the ingestor). Trimmed + upper-cased; unknown values pass through. Overridable per event via `EventOptions`. |
| `AllowInsecureHTTP` | `bool` | `false` | `IngestorURL` must be `https://`; plain `http://` is accepted only for `localhost`, `127.0.0.1`, `::1`, or with this set. |
| `FlushCount` | `int` | `500` | Events per request (max 1000); reaching it wakes the sender. |
| `FlushInterval` | `time.Duration` | `5s` | The sender also runs on this interval. |
| `MaxQueueSize` | `int` | `10000` | Queue capacity. When full the **oldest** event is dropped (`overflow`). |
| `MaxRetries` | `int` | `3` | Retries per batch; a negative value disables retries. |
| `RetryBase` | `time.Duration` | `500ms` | Full-jitter backoff base (each wait is random up to `min(30s, RetryBase × 2^attempt)`). |
| `Timeout` | `time.Duration` | `10s` | Total deadline per HTTP request. |
| `ShutdownTimeout` | `time.Duration` | `5s` | How long `Shutdown` keeps sending. |
| `HTTPClient` | `*http.Client` | one pooled client | Use your own client for every request; you keep ownership. |
| `CustomerResolver` | `func(*http.Request) string` | — | The authenticated Aforo customer id. Required for the middleware unless `TrustCustomerHeader`. |
| `TrustCustomerHeader` | `bool` | `false` | Bill the customer named in `CustomerIDHeader` instead. |
| `CustomerIDHeader` | `string` | `X-Customer-Id` | Header read when `TrustCustomerHeader` is on. |
| `MaxRequestBodyBytes` | `int64` | `1048576` | How much of a request body the middleware reads to find the operation. |
| `OnError` | `func(error)` | no-op | Called when the ingestor rejects a batch or events (messages include its `errors[].message`), when it becomes unreachable (once per outage), when `Shutdown` leaves events unsent, for an event recorded after `Shutdown`, and when an event is invalid. Sending problems arrive as `*TransportError`: use `errors.As` and branch on `Kind` (`KindOutage`, `KindAuth`, `KindRejected`, `KindShutdown`, `KindClosed`); `Events` holds the events concerned. Invalid events arrive as a plain error. Runs on the background sender; it may call `Flush` or `Shutdown`. Never carries the API key. |
| `OnAccepted` | `func(body json.RawMessage, events []map[string]any)` | nil | Called after every `2xx` with the response's `data` object (envelope removed — for example `killedSessionIds`) and the events of that request. Same goroutine rules as `OnError`; panics are recovered. |
| `OnDrop` | `func([]map[string]any, DropReason)` | `nil` | Opt-in hook called with events the SDK gives up on (`overflow`, `rejected`, `invalid`, `shutdown`, `closed`). See [Dropped events](#dropped-events). |

There are no required-field defaults for the four required values — `New` returns an error if `TenantID`, `ProductID`, `APIKey`, or `IngestorURL` is empty.

## Walk me through it

Step-by-step from install to "I can see the operation in Aforo" lives in [USER_GUIDE.md](USER_GUIDE.md).

## Execution status (outcome-based pricing)

OUTCOME_BASED rate plans weight each operation by its `executionStatus`.

The middleware derives it from the response body (`OutcomeFromGraphQLResponse`): no errors → `SUCCESS`, errors with data → `PARTIAL`, errors with `"data": null` (failed during execution) → `ERROR`, errors with no `data` key (parse or validation failure) → `VALIDATION_FAILED`. When the body isn't a single GraphQL response (or is over 1 MiB) it falls back to the HTTP status (`OutcomeFromHTTPStatus`): 2xx/3xx `SUCCESS`, 408/504 `TIMEOUT`, 499 `CANCELLED`, 400/422 `VALIDATION_FAILED`, 401/403/429 `BLOCKED`, other 4xx/5xx `ERROR`. A handler can set its own value with `SetExecutionStatus(r.Context(), "...")`, which always wins.

`Record` sends no status unless you pass one. For manual recording, pass `EventOptions` (to `Record` or `RecordWithOptions`):

```go
billing.RecordWithOptions(customerID, query, opName, durMs, hasErrors,
	graphqlmetering.EventOptions{
		ExecutionStatus: graphqlmetering.OutcomeFromGraphQLResponse(responseJSON),
	})
```

Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. The SDK trims and upper-cases the value; a blank value is left out of the event. Any other value is WARN-logged and left off the event; the event is still sent.

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

## What this doesn't cover

- **Complexity is approximate by default.** The built-in scorer is `field_count + 5 × max_depth` from a brace-balance + identifier-token count — good enough for tiering, not AST-accurate. For exact scoring, compute it yourself (e.g. graphql-go's visitor) and pass it via `Record()`.
- **No GraphQL subscriptions over WebSocket.** This meters GraphQL-over-HTTP POST. For long-lived WebSocket transports use the `go-ws` SDK.
- **No delivery guarantee on crash.** Events live in memory until sent; a hard crash loses the queue. `Shutdown(ctx)` sends what is left on graceful exit, bounded by `ShutdownTimeout`. The library installs no signal handler.
- **Customer identity.** The SDK does not decode JWTs; your `CustomerResolver` returns the customer.
