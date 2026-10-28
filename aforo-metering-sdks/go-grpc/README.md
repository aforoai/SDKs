# grpc-metering-go

Server interceptors that meter every gRPC call — unary and streaming — and ship one billing event per RPC to Aforo. Service, method, gRPC status code, call type, and duration are captured for you; streaming handlers can report exact message counts manually.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

Reach for this when you bill a gRPC service per call (or per status/method tier) and want the interceptors to do the counting, with a `Record()` escape hatch for streaming RPCs where you care about the exact number of messages sent.

## Install


```bash
go get github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc/v2
```

The import path ends in `/v2` (version 2 changed the public API; see the [changelog](CHANGELOG.md)). Releases are git tags `aforo-metering-sdks/go-grpc/v2.X.Y` on github.com/aforoai/SDKs. Until the `v2.0.0` tag exists, build against a local checkout with a `replace`:

```bash
git clone https://github.com/aforoai/SDKs.git
```

```go
// go.mod (your service)
require github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc/v2 v2.0.0

replace github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc/v2 => ../SDKs/aforo-metering-sdks/go-grpc
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

	grpcmetering "github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc/v2"
	"google.golang.org/grpc"
)

func main() {
	billing, err := grpcmetering.New(grpcmetering.Config{
		TenantID:    "tenant_acme",
		ProductID:   "prod_grpc_user_svc",
		APIKey:      os.Getenv("AFORO_API_KEY"),
		IngestorURL: "https://api.aforo.ai",
		ServiceName: "acme.v1.UserService",
		// The Aforo customer your auth interceptor put on the context.
		CustomerResolver: func(ctx context.Context) string { return auth.CustomerID(ctx) },
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

Each call emits one event with `metricName` `"grpc_api.rpc_calls"`. The customer comes from `CustomerResolver`, which you write from identity your server authenticated. `New` returns `ErrNoCustomerResolver` without a resolver unless you set `TrustCustomerHeader: true`, which bills the customer named in the `x-customer-id` metadata (or `CustomerMetadataKey`) — your callers control metadata, so use it only behind a proxy that sets it and strips client values. A call whose resolver returns `""` is served as usual but not billed: it is counted as `invalid`.

Unary calls record `messageCount = 1`. Streams record the messages they actually carried: `messageCount` is received + sent, and metadata adds `messagesReceived` and `messagesSent`.

Product type: every event carries a top-level `productType` — `Config.ProductType` (default `"GRPC_API"`). `Record` accepts optional trailing `grpcmetering.EventOptions` to override it per call (the interceptors always use `Config.ProductType`); the same options carry `ExecutionStatus`, and `RecordWithOptions` is the single-options form. Example:

```go
billing.Record(ctx, "GetUser", "UNARY", 1, err, durationMs,
	grpcmetering.EventOptions{ProductType: "AGENTIC_API"})
```

How events are sent: every `Record`/`Open`/`Close` call appends to a bounded queue (`MaxQueueSize`, default 10 000) and returns; it never starts a goroutine or makes a request. One background sender per `Billing` posts `{"events":[...]}` to `/v1/ingest/batch` in batches of up to `FlushCount` (default 500, at most 1000), with `X-API-Key` and `User-Agent: aforo-go-grpc/2.0.0`. Network errors, timeouts, `408`, `429` and `5xx` are retried with full-jitter backoff; `Retry-After` is honoured in both forms (seconds or HTTP date) up to 60 s. Each request, including reading the response body, is cut off at `Timeout`. Redirects are never followed (the API key must not reach another host): a `3xx` is logged at ERROR with the target host and handled like an outage. When retries run out — or the ingestor answers `401`/`403` or `3xx` — the batch goes back to the front of the queue with the same idempotency keys and the sender pauses (a random wait up to 5 s, doubling to 5 min, at least 250 ms); nothing is dropped and the ingestor deduplicates the resend. Events a `2xx` names in `errors[]` with `retryable: true` are resent after the same backoff, at most `MaxRetries` times, then handled as an outage. `413` splits the batch; any other `4xx` drops it as `rejected` and reports it via `OnError`. `Shutdown(ctx)` keeps sending — and retrying an unreachable ingestor — until the earlier of `ctx`'s deadline and `ShutdownTimeout` (5 s) and reports the rest as `shutdown` (see [Dropped events](#dropped-events)).

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
| `AllowInsecureHTTP` | `bool` | `false` | `IngestorURL` must be `https://`; plain `http://` is accepted only for `localhost`, `127.0.0.1`, `::1`, or with this set. |
| `FlushCount` | `int` | `500` | Events per request (max 1000); reaching it wakes the sender. |
| `FlushInterval` | `time.Duration` | `5s` | The sender also runs on this interval. |
| `MaxQueueSize` | `int` | `10000` | Queue capacity. When full the **oldest** event is dropped (`overflow`). |
| `MaxRetries` | `int` | `3` | Retries per batch; a negative value disables retries. |
| `RetryBase` | `time.Duration` | `500ms` | Full-jitter backoff base (each wait is random up to `min(30s, RetryBase × 2^attempt)`). |
| `Timeout` | `time.Duration` | `10s` | Total deadline per HTTP request. |
| `ShutdownTimeout` | `time.Duration` | `5s` | How long `Shutdown` keeps sending. |
| `HTTPClient` | `*http.Client` | one pooled client | Use your own client for every request; you keep ownership. |
| `CustomerResolver` | `func(context.Context) string` | — | The authenticated Aforo customer id for a call. Required unless `TrustCustomerHeader`. |
| `TrustCustomerHeader` | `bool` | `false` | Bill the customer named in incoming metadata instead. |
| `CustomerMetadataKey` | `string` | `x-customer-id` | Metadata key read when `TrustCustomerHeader` is on. |
| `OnError` | `func(error)` | no-op | Called when the ingestor rejects a batch or events (messages include its `errors[].message`), when it becomes unreachable (once per outage), when `Shutdown` leaves events unsent, for an event recorded after `Shutdown`, and when an event is invalid. Sending problems arrive as `*TransportError`: use `errors.As` and branch on `Kind` (`KindOutage`, `KindAuth`, `KindRejected`, `KindShutdown`, `KindClosed`); `Events` holds the events concerned. Invalid events arrive as a plain error. Runs on the background sender; it may call `Flush` or `Shutdown`. Never carries the API key. |
| `OnAccepted` | `func(body json.RawMessage, events []map[string]any)` | nil | Called after every `2xx` with the response's `data` object (envelope removed — for example `killedSessionIds`) and the events of that request. Same goroutine rules as `OnError`; panics are recovered. |
| `OnDrop` | `func([]map[string]any, DropReason)` | `nil` | Opt-in hook called with events the SDK gives up on (`overflow`, `rejected`, `invalid`, `shutdown`, `closed`). See [Dropped events](#dropped-events). |

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
| `grpcmetering.DropOverflow` (`overflow`) | The queue was full (for example during a long outage); the oldest event was evicted. |
| `grpcmetering.DropShutdown` (`shutdown`) | Still queued when `Shutdown`'s deadline passed. `Shutdown` returns an error wrapping `ErrShutdownIncomplete`. |
| `grpcmetering.DropClosed` (`closed`) | Recorded after `Shutdown`. |
| `grpcmetering.DropRejected` (`rejected`) | The ingestor answered a non-retryable `4xx`, or refused individual events in a `2xx` partial-failure response. In the partial case only the events named by `errors[].index` are passed to `OnDrop`; failures the ingestor does not identify are counted but not attributed to an event. |
| `grpcmetering.DropInvalid` (`invalid`) | The event failed client-side validation and was never buffered: a blank method, `customerId` over 64 characters, `grpcService` (`Config.ServiceName`) over 255 or `productType` over 20. A method name over 128 is not dropped — it comes from the incoming RPC, so it is truncated to 128 characters without splitting a character, the event is sent, and a WARN is logged once (interceptors and `Record` alike). The invalid-drop WARN log names the field, the limit and the value (throttled: first occurrence, then every 1000th); `OnError` is called too. |

A call with a blank customer id is not billed: it is dropped as `invalid`, counted in `DroppedCount()` and reported via `OnError`. An unknown `executionStatus` is not a drop either: the status is left off (or replaced by the derived one) and the event is sent.

```go
OnDrop: func(events []map[string]any, reason grpcmetering.DropReason) {
	log.Printf("aforo: %d event(s) dropped: %s", len(events), reason)
},
```

Idempotency keys are minted once, when the event is recorded. Every retry and every resend after an outage carries the same key, so the ingestor deduplicates it. `DropRetryExhausted` (`retry_exhausted`) is kept for compatibility but is no longer reported: v2 keeps a failing batch queued instead of dropping it.

## What this doesn't cover

- **No client-side interceptors.** This meters the server. Client-side metering isn't provided.
- **No delivery guarantee on crash.** Events live in memory until sent; a hard crash loses the queue. `Shutdown(ctx)` sends what is left on graceful exit, bounded by `ShutdownTimeout`. The library installs no signal handler.
- **Customer identity.** The SDK does not decode tokens; your `CustomerResolver` returns the customer.
