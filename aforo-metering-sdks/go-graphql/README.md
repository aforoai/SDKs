# graphql-metering-go

Per-operation GraphQL metering for Go servers. Wrap your `/graphql` HTTP handler (gqlgen, graphql-go, or anything that speaks the GraphQL-over-HTTP POST shape) and Aforo gets one billing event per operation — operation type, name, an approximate complexity score, error flag, and duration — batched and retried in the background.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

Reach for this when you bill GraphQL by the operation (or by complexity tier) and want the type/name/complexity extracted for you at the HTTP boundary, or when you already compute an accurate complexity score and just want a clean `Record()` to ship it.

## Install

Intended public install once published:

```bash
go get github.com/aforo/graphql-metering-go
```

**Not yet on a public Go module proxy — `go get github.com/aforo/graphql-metering-go` will not resolve yet.** The module path in `go.mod` (`github.com/aforo/graphql-metering-go`) is mid-migration. Until the proxy is live, vendor from source with a local `replace`:

```bash
git clone https://github.com/aforoai/SDKs.git
```

```go
// go.mod (your service)
require github.com/aforo/graphql-metering-go v1.0.0

replace github.com/aforo/graphql-metering-go => ../SDKs/aforo-metering-sdks/go-graphql
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
	"log"
	"net/http"
	"os"

	graphqlmetering "github.com/aforo/graphql-metering-go"
)

func main() {
	billing, err := graphqlmetering.New(graphqlmetering.Config{
		TenantID:    "tenant_acme",
		ProductID:   "prod_graphql_unified_gateway",
		APIKey:      os.Getenv("AFORO_API_KEY"),
		IngestorURL: "https://ingest.aforo.ai",
	})
	if err != nil {
		log.Fatal(err)
	}
	defer billing.Shutdown()

	var graphqlHandler http.Handler = /* your gqlgen/graphql-go handler */ nil
	http.Handle("/graphql", billing.Middleware(graphqlHandler))
	log.Fatal(http.ListenAndServe(":8080", nil))
}
```

The middleware reads the request body, re-attaches it for your handler, runs the handler, then emits one event with `metricName` `"graphql_api.operations"`. Non-POST requests pass through unmetered. Requests with an empty `query`, or with no resolvable customer id, are skipped.

> ⚠ The middleware reads the body with `io.ReadAll` and restores it via `io.NopCloser` so your handler still sees it. Don't add another body-draining middleware ahead of this one, or your resolvers will get an empty body.

Manual recording — when you compute an accurate complexity yourself:

```go
billing.Record(customerID, query, operationName, durationMs, hasErrors)
```

## Configuration

`Config`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `TenantID` | `string` | — (required) | Sent as the `X-Tenant-Id` header on every flush and embedded in idempotency keys. Set by you, never from a client header. |
| `ProductID` | `string` | — (required) | Recorded in event metadata + idempotency keys. |
| `APIKey` | `string` | — (required) | Sent as `Authorization: Bearer <APIKey>`. |
| `IngestorURL` | `string` | — (required) | Ingestor base; the SDK appends `/v1/ingest/events`. Use `https://ingest.aforo.ai`. |
| `SchemaVersion` | `string` | none | If set, attached to event metadata as `schemaVersion`. |
| `FlushCount` | `int` | `50` | Flush when the buffer reaches this many events. |
| `FlushInterval` | `time.Duration` | `5s` | Background flush cadence. |
| `HTTPClient` | `*http.Client` | `&http.Client{Timeout: 10s}` | Override the HTTP client. |
| `CustomerExtractor` | `func(*http.Request) string` | reads `X-Customer-Id` | How the middleware resolves the customer id per request. |
| `OnError` | `func(error)` | no-op | Called on a marshal failure or a flush that exhausts its 3 retries (events dropped). |

There are no required-field defaults for the four required values — `New` returns an error if `TenantID`, `ProductID`, `APIKey`, or `IngestorURL` is empty.

## Walk me through it

Step-by-step from install to "I can see the operation in Aforo" lives in [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Complexity is approximate by default.** The built-in scorer is `field_count + 5 × max_depth` from a brace-balance + identifier-token count — good enough for tiering, not AST-accurate. For exact scoring, compute it yourself (e.g. graphql-go's visitor) and pass it via `Record()`.
- **No GraphQL subscriptions over WebSocket.** This meters GraphQL-over-HTTP POST. For long-lived WebSocket transports use the `go-ws` SDK.
- **No delivery guarantee on crash.** Events live in memory until flushed; a hard crash before a flush loses the buffer. `Shutdown()` drains on graceful exit.
- **Customer id from a header.** Default extractor trusts `X-Customer-Id` — only safe behind your own auth/gateway. Override `CustomerExtractor` to decode a JWT.
