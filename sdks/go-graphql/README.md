# graphqlmetering — Aforo GraphQL Metering SDK for Go

Per-operation GraphQL billing for Go HTTP servers and custom executors.

## Install

```bash
go get github.com/aforo/graphql-metering-go
```

Zero runtime deps — uses standard library only.

## Usage — HTTP middleware

Works with any GraphQL server that exposes a `/graphql` HTTP handler (graphql-go, gqlgen, custom):

```go
package main

import (
    "log"
    "net/http"
    "os"

    graphqlmetering "github.com/aforo/graphql-metering-go"
)

func main() {
    billing, _ := graphqlmetering.New(graphqlmetering.Config{
        TenantID:      "tenant_acme",
        ProductID:     "prod_graphql_unified_gateway",
        APIKey:        os.Getenv("AFORO_API_KEY"),
        IngestorURL:   "https://ingestor.aforo.ai",
        SchemaVersion: "v2.1",
    })
    defer billing.Shutdown()

    var graphqlHandler http.Handler = /* your gqlgen/graphql-go handler */
    http.Handle("/graphql", billing.Middleware(graphqlHandler))
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

## Usage — manual recording

For executor-level integration with AST-accurate complexity scoring (e.g. via graphql-go's visitor):

```go
billing.Record(
    customerID,
    query,
    operationName,
    durationMs,
    hasErrors,
)
```

## Complexity scoring

Built-in scorer is a brace-balance approximation: `field_count + 5 × max_depth`, where `field_count` is the number of identifier-like tokens. For AST-accurate scoring, compute the value yourself with graphql-go's visitor and call `Record()` with the precomputed number.

## Customer-ID resolution

Default extractor reads the `X-Customer-Id` HTTP header. Override:

```go
billing, _ := graphqlmetering.New(graphqlmetering.Config{
    // ...
    CustomerExtractor: func(r *http.Request) string {
        return decodeJWT(r.Header.Get("Authorization"))
    },
})
```

## Operation-name extraction

If `operationName` is missing from the request body, the SDK extracts it from the query document (`query MyName {...}` → `MyName`). Anonymous operations are recorded as `"anonymous"`.

## Batching & retry

50 events / 5 s defaults. 3× exponential retry. Call `Shutdown()` to drain before exit.

## License

MIT
