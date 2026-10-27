# metering-go

A zero-dependency Go metering client for Aforo. You call `Track` when a billable event happens (or wrap your `http.Handler`), and the client queues, batches and sends usage to Aforo's ingestor in the background.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

Use it when your Go service knows who the customer is and what to count, and you want the SDK to own queueing, batching, retries and shutdown. Version 2 changes the public API; the [changelog](CHANGELOG.md) lists the migration steps.

## Install

```bash
go get github.com/aforoai/SDKs/aforo-metering-sdks/go/v2
```

The import path ends in `/v2`. Releases are git tags `aforo-metering-sdks/go/v2.X.Y` on [github.com/aforoai/SDKs](https://github.com/aforoai/SDKs). Until the `v2.0.0` tag exists, build against a local checkout with a `replace`:

```go
// go.mod (your service)
require github.com/aforoai/SDKs/aforo-metering-sdks/go/v2 v2.0.0

replace github.com/aforoai/SDKs/aforo-metering-sdks/go/v2 => ../SDKs/aforo-metering-sdks/go
```

The package uses the standard library only. It needs Go 1.21 or later.

## Quickstart

Create one client per process and close it on shutdown:

```go
package main

import (
	"context"
	"log"
	"os"
	"time"

	metering "github.com/aforoai/SDKs/aforo-metering-sdks/go/v2"
)

func main() {
	client, err := metering.NewClient(metering.Options{
		APIKey:  os.Getenv("AFORO_API_KEY"),
		BaseURL: "https://api.aforo.ai", // default; must be https
	})
	if err != nil {
		log.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := client.Close(ctx); err != nil {
			log.Printf("aforo: %v", err) // events still queued were reported to OnDrop
		}
	}()

	if err := client.Track(metering.TrackEvent{
		CustomerID: "cust_acme_001",
		MetricName: "api_calls",
		Quantity:   1,
	}); err != nil {
		log.Printf("aforo: %v", err)
	}
}
```

`NewClient` returns an error when `APIKey` is blank or `BaseURL` is not `https://`. Plain `http://` is accepted for `localhost`, `127.0.0.1` and `::1`, or anywhere with `AllowInsecureHTTP: true`.

Every event carries a top-level `productType` (required by the ingestor): `TrackEvent.ProductType` if set, else `Options.ProductType`, else `"API"`. Values are trimmed and upper-cased.

`Track` returns an error wrapping `metering.ErrInvalidEvent` — and queues nothing — when `CustomerID` or `MetricName` is blank, `Quantity` is negative/NaN/Inf, `OccurredAt` is not RFC 3339, or a field exceeds the ingestor's limit. A zero `Quantity` means "unset" and becomes `1`.

## Meter every HTTP request

You pass the client in and tell the middleware who the customer is. The customer must come from your own authentication — a session, a JWT subject, an API-key lookup:

```go
mw, err := metering.NewMiddleware(client, metering.MiddlewareOptions{
	MetricName: "api_calls", // must exist in your Aforo catalog
	CustomerResolver: func(r *http.Request) string {
		return customerFromSession(r) // your code: the authenticated Aforo customer id
	},
})
if err != nil {
	log.Fatal(err)
}
http.ListenAndServe(":8080", mw(mux))
```

Chi takes the same middleware: `r.Use(mw)`. `ChiMiddleware(client, opts)` is the same function under the name Chi users look for. Every route shares your one client, and your `client.Close(ctx)` at shutdown sends what they recorded.

`NewMiddleware` returns `metering.ErrNoCustomerResolver` when you set neither `CustomerResolver` nor `TrustCustomerHeader`. `TrustCustomerHeader: true` bills the customer named in the `X-Customer-Id` header (or `CustomerIDHeader`). The caller of your API controls that header, so turn it on only when a trusted proxy sets it and strips any value the client sent.

A request whose resolver returns an empty string is still served, but not billed: the event is dropped as `invalid` and counted in `DroppedCount()`. `OPTIONS` requests and the excluded paths (`/health`, `/ready`, `/metrics`, `/favicon.ico` by default) are not metered and not counted.

Each event carries `endpointPath` (normalized, no query string), `httpMethod`, `statusCode` and `responseTimeMs`. The middleware's response writer passes `Flush` and `Hijack` through and implements `Unwrap`, so server-sent events, WebSocket upgrades and `http.ResponseController` keep working.

## Configuration

`Options`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `APIKey` | `string` | — (required) | Sent only as `X-API-Key`. Never logged and never printed by `String()`/`%v`. |
| `BaseURL` | `string` | `https://api.aforo.ai` | Ingestor base; the client appends `/v1/ingest/batch`. Must be https. |
| `AllowInsecureHTTP` | `bool` | `false` | Allow `http://` to a host other than localhost. |
| `ProductType` | `string` | `API` | Top-level `productType`; `TrackEvent.ProductType` overrides it per event. |
| `FlushCount` | `int` | `500` | Events per request; reaching it wakes the sender. Clamped to 1000. |
| `FlushInterval` | `time.Duration` | `5s` | The sender also runs on this interval. |
| `MaxQueueSize` | `int` | `10000` | Queue capacity. When full the **oldest** event is dropped (`overflow`). |
| `MaxRetries` | `int` | `3` | Retries per batch; a negative value disables retries. |
| `RetryBase` | `time.Duration` | `500ms` | Full-jitter backoff base: each wait is random between 0 and `min(30s, RetryBase × 2^attempt)`. |
| `Timeout` | `time.Duration` | `10s` | Total deadline per HTTP request. |
| `ShutdownTimeout` | `time.Duration` | `5s` | How long `Close` keeps sending. |
| `HTTPClient` | `*http.Client` | one pooled client | Use your own client; you keep ownership. |
| `OnDrop` | `func([]TrackEvent, DropReason)` | `nil` | Called with events the SDK gives up on. See [Dropped events](#dropped-events). |
| `OnError` | `func(*TransportError)` | `nil` | Called for every sending problem. Branch on `Kind`: `KindOutage` and `KindAuth` (events kept queued), `KindRejected`, `KindShutdown`, `KindClosed`. `Events` holds the events concerned, `Status` the HTTP status. `errors.Is` matches `ErrIngestUnavailable`, `ErrShutdownIncomplete`, `ErrClientClosed`. Runs on the background sender and may call `Flush` or `Close`. Never carries the API key. |
| `OnAccepted` | `func(json.RawMessage, []TrackEvent)` | `nil` | Called after every `2xx` with the response's `data` object (envelope removed, for example `killedSessionIds`) and the events of that request. |

`MiddlewareOptions`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `CustomerResolver` | `func(*http.Request) string` | — | The authenticated Aforo customer id. Required unless `TrustCustomerHeader`. |
| `TrustCustomerHeader` | `bool` | `false` | Bill the customer named in `CustomerIDHeader` instead. |
| `CustomerIDHeader` | `string` | `X-Customer-Id` | Header read when `TrustCustomerHeader` is on. |
| `MetricName` | `string` | `api_calls` | Metric recorded per request. Must exist in your Aforo catalog. |
| `MetricNameFunc` | `func(*http.Request) string` | `nil` | Per-request metric; an empty result falls back to `MetricName`. |
| `ExcludePaths` | `[]string` | `/health`, `/ready`, `/metrics`, `/favicon.ico` | Path prefixes to skip. Your list replaces the defaults. |
| `ExcludeStatusCode` | `[]int` | none | Response statuses to skip. |
| `ProductType` | `string` | the client's | Top-level `productType` on metered requests. |

## How events are sent

- `Track` appends to a bounded queue and returns; it never starts a goroutine or makes a request. One background sender per client sends batches of up to `FlushCount` events, and splits a batch whose body would pass 4 MiB.
- Network errors, timeouts and HTTP `408`, `429` and every `5xx` are retried with full-jitter backoff. `Timeout` covers the whole request, including reading the response body. `Retry-After` is read in both forms (seconds, which may be fractional, and HTTP date) and capped at 60 seconds.
- Redirects are never followed, also with your own `HTTPClient` (the SDK uses a copy that refuses them): the API key must not reach another host. A `3xx` is logged at ERROR with the target host and handled like an outage; fix `BaseURL` and the queued events are sent.
- When the retries run out, or the ingestor answers `401`/`403`, the batch goes back to the front of the queue with the same idempotency keys and the sender pauses (a random wait of at least 250 ms and up to 5 s, the upper bound doubling to 5 min). A `401`/`403` logs one ERROR per pause: the key is wrong or revoked, and fixing it keeps the queued usage. The ingestor deduplicates on the idempotency key, so a resend never bills twice.
- `413` splits the batch in half; a single event still too large is dropped as `rejected`. Any other `4xx` drops the batch as `rejected` without retrying.
- A `2xx` answer can refuse single events in `errors[]`: those marked `retryable` are resent after the normal backoff, at most `MaxRetries` times and then handled as an outage; the others are dropped as `rejected`. `errors[]` counts even when `failed` is missing or 0.
- `Flush(ctx)` asks the sender to send everything now and waits, and makes one attempt even while the sender is pausing after an outage. During an outage it returns `ErrIngestUnavailable`; the events stay queued.
- `Close(ctx)` stops accepting events and sends until the earlier of `ctx`'s deadline and `ShutdownTimeout`. An unreachable ingestor is retried with backoff until the deadline, and each request in that window is cut off at it. Events still queued then are reported as `shutdown` and `Close` returns an error wrapping `ErrShutdownIncomplete`. A second `Close` returns the first one's result.
- Requests send `Content-Type: application/json`, `X-API-Key` and `User-Agent: aforo-go/2.0.0`, and no `Content-Encoding` (the ingestor does not decode gzip request bodies yet).

## Dropped events

`client.DroppedCount()` returns the running total, each drop is WARN-logged, and `Options.OnDrop(events, reason)` receives the events with their idempotency keys, so passing them to `Track` later is safe to repeat.

| `DropReason` | When |
|---|---|
| `DropOverflow` (`overflow`) | The queue was full; the oldest event was evicted. |
| `DropRejected` (`rejected`) | The ingestor refused the event (non-retryable `4xx`, too large after splitting, or `errors[]` with `retryable: false`). |
| `DropInvalid` (`invalid`) | `Track` refused the event, or the middleware's resolver returned no customer. |
| `DropShutdown` (`shutdown`) | Still queued when `Close`'s deadline passed. |
| `DropClosed` (`closed`) | `Track` was called after `Close`; `Track` also returns `ErrClientClosed`. |
| `DropRetryExhausted` (`retry_exhausted`) | Kept for compatibility; v2 requeues instead of dropping. |

Field limits mirror the ingestor: `CustomerID` 64, `MetricName` 255, `IdempotencyKey` 255, `ProductType` 20, `EndpointPath` 512, `HTTPMethod` 16 characters; `Quantity` at most 14 integer digits and 6 decimal places. The middleware truncates `endpointPath` and `httpMethod` (they come from the request) instead of dropping the event; values you pass to `Track` are never truncated.

Idempotency keys are minted once, when `Track` queues the event (a random UUID unless you set `IdempotencyKey`). Every resend carries the same key.

## Execution status (outcome-based pricing)

`TrackEvent.ExecutionStatus` is optional. OUTCOME_BASED rate plans bill each event at the weight set for its status. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value is WARN-logged and left off; the event is still sent.

## What this doesn't cover

- **GraphQL, gRPC, WebSocket and MQTT** have sibling SDKs: `go-graphql`, `go-grpc`, `go-ws`, `go-mqtt`.
- **Customer identity.** The SDK does not decode JWTs or sessions; your `CustomerResolver` does.
- **Durability across a crash.** Events live in memory until sent. A hard crash loses the queue; call `Close(ctx)` on graceful shutdown. The library installs no signal handler.
