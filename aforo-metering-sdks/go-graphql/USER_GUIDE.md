# graphql-metering-go — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Go engineers metering a GraphQL-over-HTTP server (gqlgen, graphql-go, or a custom handler).

## What you'll build

A GraphQL server that emits one Aforo billing event per operation — type, name, complexity, error flag, duration — by wrapping the `/graphql` HTTP handler. By the end you'll have sent a real operation event and confirmed it landed in Aforo.

## Prerequisites

- Go 1.21+ (the module declares `go 1.21`).
- An Aforo API key (`AFORO_API_KEY`), a `tenant_id`, and a `product_id`. All three are SDK config — never read from a client header.
- A GraphQL HTTP handler that accepts POST with a JSON `{ "query": "...", "operationName": "..." }` body.
- A way to identify the customer per request — by default the `X-Customer-Id` header your gateway/auth sets.
- Ingestor base URL — `https://ingest.aforo.ai`.

## Step 1 — Add the module from source

`go get github.com/aforoai/SDKs/aforo-metering-sdks/go-graphql` does not resolve yet (proxy not live). Clone and `replace`:

```bash
git clone https://github.com/aforoai/SDKs.git
```

```go
// go.mod (your service)
require github.com/aforoai/SDKs/aforo-metering-sdks/go-graphql v1.0.0

replace github.com/aforoai/SDKs/aforo-metering-sdks/go-graphql => ../SDKs/aforo-metering-sdks/go-graphql
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

	graphqlmetering "github.com/aforoai/SDKs/aforo-metering-sdks/go-graphql"
)

billing, err := graphqlmetering.New(graphqlmetering.Config{
	TenantID:    "tenant_acme",
	ProductID:   "prod_graphql_unified_gateway",
	APIKey:      os.Getenv("AFORO_API_KEY"),
	IngestorURL: "https://ingest.aforo.ai",
})
if err != nil {
	log.Fatal(err) // returned when any required field is empty
}
defer billing.Shutdown()
```

> ⚠ `Shutdown()` is what flushes the buffer on exit (it closes the stop channel and waits for the flush loop to drain). Skip it and pending events die with the process.

## Step 3 — Wrap your GraphQL handler

```go
var graphqlHandler http.Handler = newGraphQLHandler() // gqlgen / graphql-go / custom
http.Handle("/graphql", billing.Middleware(graphqlHandler))
log.Fatal(http.ListenAndServe(":8080", nil))
```

The middleware, after your handler responds:

- Skips non-POST requests (passes them through).
- Re-reads the body it buffered, parses `query` + `operationName`; skips if `query` is empty.
- Resolves the customer id via `CustomerExtractor` (default `X-Customer-Id`); skips if empty.
- Emits one event with the detected operation type/name, complexity, field count, `hasErrors` (response status ≥ 400), and duration.

> ⚠ The middleware drains the request body and restores it with `io.NopCloser`. If another middleware ahead of it reads the body without restoring it, the resolvers — or this SDK — will see an empty body. Keep this wrapper close to the handler.

Operation name resolution: if `operationName` is absent in the body, the SDK pulls it from the document (`query MyName {...}` → `MyName`). An anonymous operation is recorded as `"anonymous"`.

## Step 4 — Override customer-id extraction (when it's in a JWT)

The default trusts `X-Customer-Id`. Behind your own auth you usually decode it:

```go
billing, _ := graphqlmetering.New(graphqlmetering.Config{
	TenantID:    "tenant_acme",
	ProductID:   "prod_graphql_unified_gateway",
	APIKey:      os.Getenv("AFORO_API_KEY"),
	IngestorURL: "https://ingest.aforo.ai",
	CustomerExtractor: func(r *http.Request) string {
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

The buffer flushes every `FlushInterval` (5s) or when it reaches `FlushCount` (50). Send one operation, wait ~6 seconds (or `Shutdown()` to force a drain), then check Aforo:

- In the console, open the customer and look for recent `graphql_api.operations` events.
- Or query the ingestion API for that tenant + metric over the last few minutes.

The wire call the SDK makes:

```
POST https://ingest.aforo.ai/v1/ingest/events
Authorization: Bearer <AFORO_API_KEY>
X-Tenant-Id: tenant_acme
Content-Type: application/json

{"events":[{"customerId":"…","metricName":"graphql_api.operations","quantity":1,"occurredAt":"…","idempotencyKey":"gql:…","productType":"GRAPHQL_API","gqlOperationType":"QUERY","gqlOperationName":"…","gqlComplexity":12,"gqlFieldCount":7,"gqlHasErrors":false,"executionDurationMs":3,"metadata":{"sdkVersion":"1.0.0","productId":"prod_graphql_unified_gateway"}}]}
```

> ⚠ Flush failures are silent unless you set `OnError`. If nothing lands, set `OnError: func(err error){ log.Println("aforo:", err) }` to surface marshal failures and retry-exhausted drops.

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `TenantID` | `string` | — (required) | `X-Tenant-Id` header + idempotency-key component. |
| `ProductID` | `string` | — (required) | Event metadata + idempotency-key component. |
| `APIKey` | `string` | — (required) | `Authorization: Bearer <APIKey>`. |
| `IngestorURL` | `string` | — (required) | Base; `/v1/ingest/events` is appended. |
| `SchemaVersion` | `string` | none | Added to metadata as `schemaVersion` when set. |
| `FlushCount` | `int` | `50` | Buffer-size flush threshold. |
| `FlushInterval` | `time.Duration` | `5s` | Background flush cadence. |
| `HTTPClient` | `*http.Client` | `&http.Client{Timeout: 10s}` | HTTP client override. |
| `CustomerExtractor` | `func(*http.Request) string` | reads `X-Customer-Id` | Per-request customer-id resolver. |
| `OnError` | `func(error)` | no-op | Marshal failures + retry-exhausted drops. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `New` returns an error | A required field (`TenantID`/`ProductID`/`APIKey`/`IngestorURL`) is empty | Set all four. There is no env auto-load. |
| No events for some requests | Empty `query`, non-POST request, or no resolvable customer id | Confirm the request is a GraphQL POST with a `query`, and that `X-Customer-Id` (or your extractor) returns a value. |
| Resolvers receive an empty body | A body-draining middleware sits ahead of `Middleware` | Order so this wrapper reads/restores the body before others consume it. |
| Complexity scores look off | Built-in scorer is a brace-balance approximation | Compute an exact score and pass it via `Record()`; the middleware path always uses the approximation. |
| Events drop with no log | Flush exhausted 3 retries and `OnError` is unset | Set `OnError` to log; verify `APIKey`, `IngestorURL`, and that the tenant owns the metric. |
| All operations record as `anonymous` | No `operationName` in the body and no named operation in the document | Send `operationName`, or name your operations (`query Foo {...}`). |

## What this guide does NOT cover

- **Modeling GraphQL billing in Aforo.** Mapping `graphql_api.operations` (and the `gqlComplexity` field) to a rate plan is done in the Aforo console.
- **AST-accurate complexity.** The SDK gives an approximation; exact scoring is your code via `Record()`.
- **GraphQL subscriptions over WebSocket.** Use the `go-ws` SDK for long-lived WebSocket transports.
