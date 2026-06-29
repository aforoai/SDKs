# grpc-metering-go

Server interceptors that meter every gRPC call — unary and streaming — and ship one billing event per RPC to Aforo. Service, method, gRPC status code, call type, and duration are captured for you; streaming handlers can report exact message counts manually.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

Reach for this when you bill a gRPC service per call (or per status/method tier) and want the interceptors to do the counting, with a `Record()` escape hatch for streaming RPCs where you care about the exact number of messages sent.

## Install

Intended public install once published:

```bash
go get github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc
```

**Not yet published — `go get github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc` resolves once this repo is public and the module is tagged** (`aforo-metering-sdks/go-grpc/v1.0.0`). Until then, vendor it from source with a local `replace`:

```bash
git clone https://github.com/aforoai/SDKs.git
```

```go
// go.mod (your service)
require github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc v1.0.0

replace github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc => ../SDKs/aforo-metering-sdks/go-grpc
```

```bash
go mod tidy
```

Requires `google.golang.org/grpc` (declared at `v1.60.0` in this module's `go.mod`); the SDK uses `grpc`, `grpc/metadata`, and `grpc/status` only.

## Quickstart

```go
package main

import (
	"context"
	"log"
	"net"
	"os"

	grpcmetering "github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc"
	"google.golang.org/grpc"
)

func main() {
	billing, err := grpcmetering.New(grpcmetering.Config{
		TenantID:    "tenant_acme",
		ProductID:   "prod_grpc_user_svc",
		APIKey:      os.Getenv("AFORO_API_KEY"),
		IngestorURL: "https://ingest.aforo.ai",
		ServiceName: "acme.v1.UserService",
	})
	if err != nil {
		log.Fatal(err)
	}
	defer billing.Shutdown(context.Background())

	server := grpc.NewServer(
		grpc.UnaryInterceptor(billing.UnaryInterceptor()),
		grpc.StreamInterceptor(billing.StreamInterceptor()),
	)
	// pb.RegisterUserServiceServer(server, &userServer{})

	lis, _ := net.Listen("tcp", ":50051")
	server.Serve(lis)
}
```

Each call emits one event with `metricName` `"grpc_api.rpc_calls"`. The customer id comes from the `x-customer-id` gRPC metadata key by default; a call with no customer id is not metered.

> ⚠ `UnaryInterceptor` and `StreamInterceptor` both record `messageCount = 1` per call. That's correct for unary but undercounts streaming. If you bill per message, call `Record()` from inside the streaming handler with the real count (see the user guide).

## Configuration

`Config`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `TenantID` | `string` | — (required) | Sent as the `X-Tenant-Id` header on every flush and embedded in idempotency keys. Set by you, never from a client header. |
| `ProductID` | `string` | — (required) | Recorded in event metadata + idempotency keys. |
| `APIKey` | `string` | — (required) | Sent as `Authorization: Bearer <APIKey>`. |
| `IngestorURL` | `string` | — (required) | Ingestor base; the SDK appends `/v1/ingest/events`. Use `https://ingest.aforo.ai`. |
| `ServiceName` | `string` | — (required) | Fully-qualified gRPC service (e.g. `acme.v1.UserService`); recorded as `grpcService`. |
| `FlushCount` | `int` | `50` | Flush when the buffer reaches this many events. |
| `FlushInterval` | `time.Duration` | `5s` | Background flush cadence. |
| `HTTPClient` | `*http.Client` | `&http.Client{Timeout: 10s}` | Override the HTTP client used for flushing. |
| `CustomerExtractor` | `func(context.Context) string` | reads `x-customer-id` metadata | How a call's customer id is resolved. |
| `OnError` | `func(error)` | no-op | Called on a marshal failure or a flush that exhausts its 3 retries (events dropped). |

`New` returns an error if any of the five required fields is empty.

## Walk me through it

Step-by-step from install to "I can see the RPC in Aforo" lives in [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Streaming message counts aren't automatic.** Interceptors emit one event with `messageCount = 1` per stream; per-frame counts require a manual `Record()` from your handler.
- **No client-side interceptors.** This meters the server. Client-side metering isn't provided.
- **No delivery guarantee on crash.** Events live in memory until flushed; a hard crash before a flush loses the buffer. `Shutdown(ctx)` drains on graceful exit, bounded by the context.
- **Customer id from metadata.** Default reads `x-customer-id` — trust it only behind your own auth. Override `CustomerExtractor` to decode a token.
