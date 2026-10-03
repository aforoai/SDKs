# grpc-metering-go

Server interceptors that meter every gRPC call — unary and streaming — and ship one billing event per RPC to Aforo. Service, method, gRPC status code, call type, and duration are captured for you; streaming handlers can report exact message counts manually.

**Version:** 1.2.2 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

Reach for this when you bill a gRPC service per call (or per status/method tier) and want the interceptors to do the counting, with a `Record()` escape hatch for streaming RPCs where you care about the exact number of messages sent.

## Install


```bash
go get github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc
```

Releases are git tags of the form `aforo-metering-sdks/go-grpc/vX.Y.Z` on [github.com/aforoai/SDKs](https://github.com/aforoai/SDKs) (this version: `aforo-metering-sdks/go-grpc/v1.2.2`). Use `v1.2.2` or later: `v1.0.0` was tagged from an older copy of this code and lacks the fixes listed in the changelog. Until the `v1.2.2` tag exists, `go get github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc@main` resolves to a pseudo-version of the default branch. To build against a local checkout instead, use a `replace`:

```bash
git clone https://github.com/aforoai/SDKs.git
```

```go
// go.mod (your service)
require github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc v1.2.2

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
		IngestorURL: "https://api.aforo.ai",
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

Product type: every event carries a top-level `productType` — `Config.ProductType` (default `"GRPC_API"`). `Record` accepts optional trailing `grpcmetering.EventOptions` to override it per call (the interceptors always use `Config.ProductType`); the same options carry `ExecutionStatus`, and `RecordWithOptions` is the single-options form. Example:

```go
billing.Record(ctx, "GetUser", "UNARY", 1, err, durationMs,
	grpcmetering.EventOptions{ProductType: "AGENTIC_API"})
```

Delivery: `POST /v1/ingest/batch` with `{"events":[...]}`, at most 1000 events per request, `X-API-Key` header. Transport errors, `408`, `429` (honouring `Retry-After`) and `5xx` are retried with the same body; any other `4xx` is not retried: the batch is dropped with reason `rejected` and reported via `OnError` (see [Dropped events](#dropped-events)).

## Configuration

`Config`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `TenantID` | `string` | — (required) | Sent as the `X-Tenant-Id` header on every flush and embedded in idempotency keys. Set by you, never from a client header. |
| `ProductID` | `string` | — (required) | Recorded in event metadata + idempotency keys. |
| `APIKey` | `string` | — (required) | Sent as `X-API-Key: <APIKey>`. |
| `IngestorURL` | `string` | — (required) | Ingestor base; the SDK appends `/v1/ingest/batch`. Use `https://api.aforo.ai`. |
| `ServiceName` | `string` | — (required) | Fully-qualified gRPC service (e.g. `acme.v1.UserService`); recorded as `grpcService`. |
| `ProductType` | `string` | `GRPC_API` | Top-level `productType` on every event (required by the ingestor). Trimmed + upper-cased; unknown values pass through. Overridable per event via `EventOptions`. |
| `FlushCount` | `int` | `50` | Flush when the buffer reaches this many events. |
| `FlushInterval` | `time.Duration` | `5s` | Background flush cadence. |
| `HTTPClient` | `*http.Client` | `&http.Client{Timeout: 10s}` | Override the HTTP client used for flushing. |
| `CustomerExtractor` | `func(context.Context) string` | reads `x-customer-id` metadata | How a call's customer id is resolved. |
| `OnError` | `func(error)` | no-op | Called on a marshal failure, a flush that exhausts its 3 retries, a non-retryable `4xx` (dropped without retry), or a `2xx` whose body reports `failed > 0` — messages include the ingestor's `errors[].message`. |
| `OnDrop` | `func([]map[string]any, DropReason)` | `nil` | Opt-in hook called with events the SDK drops (`retry_exhausted`, `rejected`, `invalid`). See [Dropped events](#dropped-events). |

`New` returns an error if any of the five required fields is empty.

## Walk me through it

Step-by-step from install to "I can see the RPC in Aforo" lives in [USER_GUIDE.md](USER_GUIDE.md).

## Execution status (outcome-based pricing)

Every event carries `executionStatus`, which OUTCOME_BASED rate plans use to weight each call. The SDK derives it from the gRPC status code (`OutcomeFromGrpcCode`):

| gRPC code | executionStatus |
|---|---|
| `OK` | `SUCCESS` |
| `Canceled` | `CANCELLED` |
| `InvalidArgument`, `FailedPrecondition`, `OutOfRange` | `VALIDATION_FAILED` |
| `DeadlineExceeded` | `TIMEOUT` |
| `PermissionDenied`, `ResourceExhausted`, `Unauthenticated` | `BLOCKED` |
| anything else | `ERROR` |

To send your own value, call `SetExecutionStatus` from inside a handler served through the interceptors, or pass `EventOptions` to `RecordWithOptions`. An explicit value always wins over the derived one.

```go
func (s *server) Search(ctx context.Context, req *pb.SearchRequest) (*pb.SearchResponse, error) {
	resp, partial := s.search(req)
	if partial {
		grpcmetering.SetExecutionStatus(ctx, "PARTIAL")
	}
	return resp, nil
}

billing.RecordWithOptions(ctx, "StreamUpdates", "SERVER_STREAM", count, err, durMs,
	grpcmetering.EventOptions{ExecutionStatus: "PARTIAL"})
```

Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. The SDK trims and upper-cases the value; a blank value is left out of the event. Any other value is WARN-logged and ignored: the status derived from the gRPC code is sent instead.

## Dropped events

An event the SDK cannot deliver is never lost silently. `billing.DroppedCount()` returns the running total, each drop is WARN-logged, and the opt-in `Config.OnDrop(events, reason)` hook receives the events (with their idempotency keys, so re-submitting them later is dedup-safe).

| `DropReason` | When |
|---|---|
| `grpcmetering.DropRetryExhausted` (`retry_exhausted`) | A batch failed all 3 attempts (transport error, `408`, `429`, `5xx`). |
| `grpcmetering.DropRejected` (`rejected`) | The ingestor answered a non-retryable `4xx`, or refused individual events in a `2xx` partial-failure response. In the partial case only the events named by `errors[].index` are passed to `OnDrop`; failures the ingestor does not identify are counted but not attributed to an event. |
| `grpcmetering.DropInvalid` (`invalid`) | The event failed client-side validation and was never buffered: a blank method, `customerId` over 64 characters, `grpcService` (`Config.ServiceName`) over 255 or `productType` over 20. A method name over 128 is not dropped — it comes from the incoming RPC, so it is truncated to 128 characters without splitting a character, the event is sent, and a WARN is logged once (interceptors and `Record` alike). The invalid-drop WARN log names the field, the limit and the value (throttled: first occurrence, then every 1000th); `OnError` is called too. |

A call with no customer id is not metered and is not a drop. An unknown `executionStatus` is not a drop either: the status is left off (or replaced by the derived one) and the event is sent.

```go
OnDrop: func(events []map[string]any, reason grpcmetering.DropReason) {
	log.Printf("aforo: %d event(s) dropped: %s", len(events), reason)
},
```

Idempotency keys are minted once, when the event is recorded. Every retry re-sends the same body, so a retried batch is deduplicated by the ingestor.

## What this doesn't cover

- **Streaming message counts aren't automatic.** Interceptors emit one event with `messageCount = 1` per stream; per-frame counts require a manual `Record()` from your handler.
- **No client-side interceptors.** This meters the server. Client-side metering isn't provided.
- **No delivery guarantee on crash.** Events live in memory until flushed; a hard crash before a flush loses the buffer. `Shutdown(ctx)` drains on graceful exit, bounded by the context.
- **Customer id from metadata.** Default reads `x-customer-id` — trust it only behind your own auth. Override `CustomerExtractor` to decode a token.
