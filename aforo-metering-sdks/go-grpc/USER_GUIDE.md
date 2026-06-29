# grpc-metering-go — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Go engineers metering a gRPC server with server interceptors.

## What you'll build

A gRPC server that emits one Aforo billing event per RPC — service, method, gRPC status, call type, duration — via `UnaryInterceptor` and `StreamInterceptor`, with a manual `Record()` path for exact streaming message counts. By the end you'll have sent a real RPC event and confirmed it landed in Aforo.

## Prerequisites

- Go 1.21+ (the module declares `go 1.21`).
- `google.golang.org/grpc` v1.60.0 (the version this module pins).
- An Aforo API key (`AFORO_API_KEY`), a `tenant_id`, a `product_id`, and the fully-qualified `service_name`. All four are SDK config — never read from a client header.
- A customer id reachable from the call context — by default the `x-customer-id` gRPC metadata key.
- Ingestor base URL — `https://ingest.aforo.ai`.

## Step 1 — Add the module from source

`go get github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc` does not resolve yet (proxy not live). Clone and `replace`:

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

> ⚠ Adjust the `replace` path to your clone location. `go mod tidy` will resolve the gRPC dependency from your module cache / proxy as usual — only the Aforo module is replaced.

## Step 2 — Construct the Billing client

```go
import (
	"context"
	"log"
	"os"

	grpcmetering "github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc"
)

billing, err := grpcmetering.New(grpcmetering.Config{
	TenantID:    "tenant_acme",
	ProductID:   "prod_grpc_user_svc",
	APIKey:      os.Getenv("AFORO_API_KEY"),
	IngestorURL: "https://ingest.aforo.ai",
	ServiceName: "acme.v1.UserService",
})
if err != nil {
	log.Fatal(err) // returned when any required field is empty
}
defer billing.Shutdown(context.Background())
```

> ⚠ `Shutdown(ctx)` flushes pending events and waits for the flush loop, bounded by the context — pass a context with a deadline if you don't want shutdown to block indefinitely on a stuck ingestor. Skip it and pending events die with the process.

## Step 3 — Register the interceptors

```go
import "google.golang.org/grpc"

server := grpc.NewServer(
	grpc.UnaryInterceptor(billing.UnaryInterceptor()),
	grpc.StreamInterceptor(billing.StreamInterceptor()),
)
```

Each interceptor runs the handler, then records one event after it returns. The gRPC status is derived from the handler's error (`status.FromError`); a nil error records `OK`. The method name recorded is the trailing segment of `info.FullMethod` (e.g. `/acme.v1.UserService/GetUser` → `GetUser`); the call type is `UNARY`, `CLIENT_STREAM`, `SERVER_STREAM`, or `BIDI_STREAM`.

## Step 4 — Override customer-id extraction (when it's in a token)

Default reads the `x-customer-id` metadata key. Behind your own auth you typically decode it:

```go
import "google.golang.org/grpc/metadata"

billing, _ := grpcmetering.New(grpcmetering.Config{
	TenantID:    "tenant_acme",
	ProductID:   "prod_grpc_user_svc",
	APIKey:      os.Getenv("AFORO_API_KEY"),
	IngestorURL: "https://ingest.aforo.ai",
	ServiceName: "acme.v1.UserService",
	CustomerExtractor: func(ctx context.Context) string {
		md, ok := metadata.FromIncomingContext(ctx)
		if !ok || len(md.Get("authorization")) == 0 {
			return ""
		}
		return decodeJWTSubject(md.Get("authorization")[0])
	},
})
```

Calls where the extractor returns `""` are not metered.

## Step 5 — Count messages exactly on streaming RPCs

The interceptors record `messageCount = 1` per stream — fine for unary, an undercount for streaming. If you bill per message, call `Record()` from inside the handler with the real count:

```go
func (s *server) ListUsers(req *pb.ListReq, stream pb.UserService_ListUsersServer) error {
	start := time.Now()
	n := 0
	for _, u := range users {
		if err := stream.Send(u); err != nil {
			return err
		}
		n++
	}
	billing.Record(stream.Context(), "ListUsers", "SERVER_STREAM", n, nil, time.Since(start).Milliseconds())
	return nil
}
```

> ⚠ Doing both the `StreamInterceptor` AND a manual `Record()` in the same handler emits **two** events for that RPC (one with count 1 from the interceptor, one with your real count). Pick one path per streaming method: either drop `StreamInterceptor` and `Record()` manually, or accept the interceptor's count-of-1.

`Record(ctx, method, callType, messageCount, err, durationMs)` — the gRPC status label is derived from the `err` you pass.

## Step 6 — Verify it landed

The buffer flushes every `FlushInterval` (5s) or when it reaches `FlushCount` (50). Make one RPC, wait ~6 seconds (or `Shutdown()` to force a drain), then check Aforo:

- In the console, open the customer and look for recent `grpc_api.rpc_calls` events.
- Or query the ingestion API for that tenant + metric.

The wire call the SDK makes:

```
POST https://ingest.aforo.ai/v1/ingest/events
Authorization: Bearer <AFORO_API_KEY>
X-Tenant-Id: tenant_acme
Content-Type: application/json

{"events":[{"customerId":"…","metricName":"grpc_api.rpc_calls","quantity":1,"occurredAt":"…","idempotencyKey":"grpc:…","productType":"GRPC_API","grpcService":"acme.v1.UserService","grpcMethod":"GetUser","grpcStatusCode":"OK","grpcCallType":"UNARY","messageCount":1,"executionDurationMs":2,"metadata":{"sdkVersion":"1.0.0","productId":"prod_grpc_user_svc"}}]}
```

> ⚠ Flush failures are silent unless you set `OnError`. If nothing lands, set `OnError: func(err error){ log.Println("aforo:", err) }` to surface marshal failures and retry-exhausted drops.

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `TenantID` | `string` | — (required) | `X-Tenant-Id` header + idempotency-key component. |
| `ProductID` | `string` | — (required) | Event metadata + idempotency-key component. |
| `APIKey` | `string` | — (required) | `Authorization: Bearer <APIKey>`. |
| `IngestorURL` | `string` | — (required) | Base; `/v1/ingest/events` is appended. |
| `ServiceName` | `string` | — (required) | Fully-qualified gRPC service; recorded as `grpcService`. |
| `FlushCount` | `int` | `50` | Buffer-size flush threshold. |
| `FlushInterval` | `time.Duration` | `5s` | Background flush cadence. |
| `HTTPClient` | `*http.Client` | `&http.Client{Timeout: 10s}` | HTTP client override. |
| `CustomerExtractor` | `func(context.Context) string` | reads `x-customer-id` metadata | Per-call customer-id resolver. |
| `OnError` | `func(error)` | no-op | Marshal failures + retry-exhausted drops. |

gRPC status mapping is `status.Code().String()`: `OK`, `CANCELLED`, `UNKNOWN`, `INVALID_ARGUMENT`, `DEADLINE_EXCEEDED`, `NOT_FOUND`, `ALREADY_EXISTS`, `PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`, `FAILED_PRECONDITION`, `ABORTED`, `OUT_OF_RANGE`, `UNIMPLEMENTED`, `INTERNAL`, `UNAVAILABLE`, `DATA_LOSS`, `UNAUTHENTICATED`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `New` returns an error | A required field (incl. `ServiceName`) is empty | Set all five required fields. |
| No events for some calls | Extractor returned `""` (no `x-customer-id` metadata) | Ensure the customer id is in the call metadata, or override `CustomerExtractor`. |
| Streaming RPC counts as 1 message | Interceptor default; per-frame counts aren't observed | Call `billing.Record(...)` with the real count (and don't also rely on the interceptor for that method). |
| One streaming RPC produces two events | Both `StreamInterceptor` and a manual `Record()` fired | Use one path per method. |
| Events drop with no log | Flush exhausted 3 retries and `OnError` is unset | Set `OnError`; verify `APIKey`, `IngestorURL`, and that the tenant owns the metric. |
| `Shutdown` blocks at exit | Ingestor unreachable while draining | Pass a context with a deadline to `Shutdown(ctx)` so it returns `ctx.Err()` instead of hanging. |

## What this guide does NOT cover

- **Modeling gRPC billing in Aforo.** Mapping `grpc_api.rpc_calls` (and fields like `grpcStatusCode` / `grpcMethod`) to a rate plan is done in the Aforo console.
- **Client-side metering.** This SDK provides server interceptors only.
- **Exact streaming counts without code changes.** Per-message counts require a manual `Record()` from the handler.
