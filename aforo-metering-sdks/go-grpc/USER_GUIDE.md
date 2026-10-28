# grpc-metering-go — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** Go engineers metering a gRPC server with server interceptors.

## What you'll build

A gRPC server that emits one Aforo billing event per RPC — service, method, gRPC status, call type, duration — via `UnaryInterceptor` and `StreamInterceptor`, with a manual `Record()` path for exact streaming message counts. By the end you'll have sent a real RPC event and confirmed it landed in Aforo.

## Prerequisites

- Go 1.26+ (the module declares `go 1.26.0`: the `golang.org/x/net` release without known vulnerabilities requires it).
- `google.golang.org/grpc` v1.60.0 (the version this module pins).
- An Aforo API key (`AFORO_API_KEY`), a `tenant_id`, a `product_id`, and the fully-qualified `service_name`. All four are SDK config — never read from a client header.
- A way to get the Aforo customer for a call from your own authentication (auth interceptor, token subject, mTLS peer).
- Ingestor base URL — `https://api.aforo.ai`.

## Step 1 — Add the module

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

> ⚠ Adjust the `replace` path to your clone location. `go mod tidy` will resolve the gRPC dependency from your module cache / proxy as usual — only the Aforo module is replaced.

## Step 2 — Construct the Billing client

```go
import (
	"context"
	"log"
	"os"

	grpcmetering "github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc/v2"
)

billing, err := grpcmetering.New(grpcmetering.Config{
	TenantID:    "tenant_acme",
	ProductID:   "prod_grpc_user_svc",
	APIKey:      os.Getenv("AFORO_API_KEY"),
	IngestorURL: "https://api.aforo.ai",
	ServiceName: "acme.v1.UserService",
})
if err != nil {
	log.Fatal(err) // returned when any required field is empty
}
defer billing.Shutdown(context.Background())
```

> ⚠ `Shutdown(ctx)` sends what is queued, bounded by the earlier of `ctx`'s deadline and `ShutdownTimeout` (5 s). Events still queued then go to `OnDrop` with reason `shutdown` and `Shutdown` returns an error wrapping `ErrShutdownIncomplete`. Call it from your shutdown path; the library installs no signal handler.

## Step 3 — Register the interceptors

```go
import "google.golang.org/grpc"

server := grpc.NewServer(
	grpc.UnaryInterceptor(billing.UnaryInterceptor()),
	grpc.StreamInterceptor(billing.StreamInterceptor()),
)
```

Each interceptor runs the handler, then records one event after it returns. The gRPC status is derived from the handler's error (`status.FromError`); a nil error records `OK`. The method name recorded is the trailing segment of `info.FullMethod` (e.g. `/acme.v1.UserService/GetUser` → `GetUser`); the call type is `UNARY`, `CLIENT_STREAM`, `SERVER_STREAM`, or `BIDI_STREAM`.

## Step 4 — Tell the SDK who the customer is

`CustomerResolver` is required (unless you opt into `TrustCustomerHeader`). Return the customer your server authenticated:

```go
import "google.golang.org/grpc/metadata"

billing, _ := grpcmetering.New(grpcmetering.Config{
	TenantID:    "tenant_acme",
	ProductID:   "prod_grpc_user_svc",
	APIKey:      os.Getenv("AFORO_API_KEY"),
	IngestorURL: "https://api.aforo.ai",
	ServiceName: "acme.v1.UserService",
	CustomerResolver: func(ctx context.Context) string {
		md, ok := metadata.FromIncomingContext(ctx)
		if !ok || len(md.Get("authorization")) == 0 {
			return ""
		}
		return decodeJWTSubject(md.Get("authorization")[0])
	},
})
```

Calls where the resolver returns `""` are served as usual but not billed; each is counted as `invalid` in `DroppedCount()`. `TrustCustomerHeader: true` instead bills the customer named in the `x-customer-id` metadata — your callers control metadata, so use it only behind a proxy that sets it and strips client values.

## Step 5 — Streaming RPCs are counted for you

`StreamInterceptor` counts the messages each stream actually carried: `messageCount` is received + sent, and the event metadata adds `messagesReceived` and `messagesSent`. You do not need a manual `Record()` for streams.

> ⚠ If you also call `Record()` from inside a streaming handler, that RPC emits two events. Use one path per method.

`Record(ctx, method, callType, messageCount, err, durationMs)` — the gRPC status label is derived from the `err` you pass.

## Step 6 — Verify it landed

The sender runs every `FlushInterval` (5s) or when `FlushCount` (500) events are queued. Make one RPC, then call `billing.Flush(ctx)` (or `Shutdown(ctx)`), then check Aforo:

- In the console, open the customer and look for recent `grpc_api.rpc_calls` events.
- Or query the ingestion API for that tenant + metric.

The wire call the SDK makes:

```
POST https://api.aforo.ai/v1/ingest/batch
X-API-Key: <AFORO_API_KEY>
X-Tenant-Id: tenant_acme
Content-Type: application/json

{"events":[{"customerId":"…","metricName":"grpc_api.rpc_calls","quantity":1,"occurredAt":"…","idempotencyKey":"grpc:…","productType":"GRPC_API","grpcService":"acme.v1.UserService","grpcMethod":"GetUser","grpcStatusCode":"OK","grpcCallType":"UNARY","messageCount":1,"executionDurationMs":2,"metadata":{"sdkVersion":"1.0.0","productId":"prod_grpc_user_svc"}}]}
```

> ⚠ Drops are WARN-logged through the standard `log` package and counted in `DroppedCount()`; the reason for a failed flush is only reported to `OnError`. If nothing lands, set `OnError: func(err error){ log.Println("aforo:", err) }` to surface marshal failures, retry-exhausted drops and ingestor rejections (including `errors[].message`).

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `TenantID` | `string` | — (required) | `X-Tenant-Id` header + idempotency-key component. |
| `ProductID` | `string` | — (required) | Event metadata + idempotency-key component. |
| `APIKey` | `string` | — (required) | `X-API-Key: <APIKey>`. |
| `IngestorURL` | `string` | — (required) | Base; `/v1/ingest/batch` is appended. |
| `ServiceName` | `string` | — (required) | Fully-qualified gRPC service; recorded as `grpcService`. |
| `ProductType` | `string` | `GRPC_API` | Top-level `productType` on every event; per-event override via `EventOptions`. |
| `AllowInsecureHTTP` | `bool` | `false` | `IngestorURL` must be `https://`; plain `http://` is accepted only for `localhost`, `127.0.0.1`, `::1`, or with this set. |
| `FlushCount` | `int` | `500` | Events per request (max 1000); reaching it wakes the sender. |
| `FlushInterval` | `time.Duration` | `5s` | The sender also runs on this interval. |
| `MaxQueueSize` | `int` | `10000` | Queue capacity. When full the **oldest** event is dropped (`overflow`). |
| `MaxRetries` | `int` | `3` | Retries per batch; a negative value disables retries. |
| `RetryBase` | `time.Duration` | `500ms` | Full-jitter backoff base (each wait is random up to `min(30s, RetryBase × 2^attempt)`). |
| `Timeout` | `time.Duration` | `10s` | Total deadline per HTTP request. |
| `ShutdownTimeout` | `time.Duration` | `5s` | How long `Shutdown` keeps sending. |
| `HTTPClient` | `*http.Client` | one pooled client | Use your own client for every request; you keep ownership. |
| `CustomerResolver` | `func(context.Context) string` | — (required unless `TrustCustomerHeader`) | Per-call customer id from your authentication. |
| `TrustCustomerHeader` | `bool` | `false` | Bill the customer in `CustomerMetadataKey` metadata (default `x-customer-id`). |
| `OnError` | `func(error)` | no-op | Called when the ingestor rejects a batch or events (messages include its `errors[].message`), when it becomes unreachable (once per outage), when `Shutdown` leaves events unsent, for an event recorded after `Shutdown`, and when an event is invalid. Sending problems arrive as `*TransportError`: use `errors.As` and branch on `Kind` (`KindOutage`, `KindAuth`, `KindRejected`, `KindShutdown`, `KindClosed`); `Events` holds the events concerned. Invalid events arrive as a plain error. Runs on the background sender; it may call `Flush` or `Shutdown`. Never carries the API key. |
| `OnAccepted` | `func(body json.RawMessage, events []map[string]any)` | nil | Called after every `2xx` with the response's `data` object (envelope removed — for example `killedSessionIds`) and the events of that request. Same goroutine rules as `OnError`; panics are recovered. |
| `OnDrop` | `func([]map[string]any, DropReason)` | `nil` | Opt-in hook called with events the SDK gives up on (`overflow`, `rejected`, `invalid`, `shutdown`, `closed`). See [Dropped events](#dropped-events). |

gRPC status mapping is the canonical upper-snake name of `status.Code()` (e.g. `codes.Canceled` → `CANCELLED`, `codes.InvalidArgument` → `INVALID_ARGUMENT`): `OK`, `CANCELLED`, `UNKNOWN`, `INVALID_ARGUMENT`, `DEADLINE_EXCEEDED`, `NOT_FOUND`, `ALREADY_EXISTS`, `PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`, `FAILED_PRECONDITION`, `ABORTED`, `OUT_OF_RANGE`, `UNIMPLEMENTED`, `INTERNAL`, `UNAVAILABLE`, `DATA_LOSS`, `UNAUTHENTICATED`.

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

## Execution status

See [Execution status (outcome-based pricing)](README.md#execution-status-outcome-based-pricing) in the README for the values, how the status is derived and how to set your own.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `New` returns an error | A required field (incl. `ServiceName`) is empty | Set all five required fields. |
| No events for some calls; `DroppedCount()` grows with `invalid` | `CustomerResolver` returned `""` | Check those calls are authenticated before the metering interceptor runs. |
| Streaming RPC counts as 1 message | Interceptor default; per-frame counts aren't observed | Call `billing.Record(...)` with the real count (and don't also rely on the interceptor for that method). |
| One streaming RPC produces two events | Both `StreamInterceptor` and a manual `Record()` fired | Use one path per method. |
| `OnError` reports "ingestor unavailable" | The ingestor is unreachable or answered `401`/`403` | Nothing is lost while the queue has room; verify `APIKey` and network access to `IngestorURL`. Events beyond `MaxQueueSize` are dropped as `overflow`. |
| `Shutdown` blocks at exit | Ingestor unreachable while draining | Pass a context with a deadline to `Shutdown(ctx)` so it returns `ctx.Err()` instead of hanging. |

## What this guide does NOT cover

- **Modeling gRPC billing in Aforo.** Mapping `grpc_api.rpc_calls` (and fields like `grpcStatusCode` / `grpcMethod`) to a rate plan is done in the Aforo console.
- **Client-side metering.** This SDK provides server interceptors only.
- **Exact streaming counts without code changes.** Per-message counts require a manual `Record()` from the handler.
