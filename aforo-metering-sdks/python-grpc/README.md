# aforo-grpc-metering

Meter every gRPC call with a server interceptor — one Aforo event per RPC, with the gRPC status mapped to a readable label, call type, and duration. Streaming RPCs are metered with one explicit `record()` call.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install:

```bash
pip install aforo-grpc-metering
pip install "aforo-grpc-metering[httpx]"     # or [aiohttp] — faster HTTP flush than stdlib urllib
```

**Install `2.0.0` or later. `1.0.0` on PyPI was built from an older copy of this code and lacks the fixes listed in the changelog.** If `2.0.0` is not on PyPI yet, install from source:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/python-grpc     # folder holding setup.py
pip install -e .
pip install -e ".[httpx]"              # or [aiohttp]
```

The one required dependency is `grpcio>=1.50`.

## Quickstart — unary interceptor

Best when your service is mostly unary RPCs and you want per-call billing with no handler changes.

```python
import os, grpc
from concurrent import futures
from aforo_grpc_metering import AforoGrpcBilling, AforoGrpcInterceptor

billing = AforoGrpcBilling(
    tenant_id="tenant_acme",
    product_id="prod_grpc_user_svc",
    api_key=os.environ["AFORO_API_KEY"],
    ingestor_url="https://api.aforo.ai",
    service_name="acme.v1.UserService",
)

def customer_for(context):
    # The customer your auth layer verified, e.g. from a validated token or mTLS peer.
    return verified_customer_id(context)

server = grpc.server(
    futures.ThreadPoolExecutor(max_workers=10),
    interceptors=[AforoGrpcInterceptor(billing, customer_resolver=customer_for)],
)
# add_UserServiceServicer_to_server(servicer, server)
server.add_insecure_port("[::]:50051")
server.start()
server.wait_for_termination()
```

Every RPC is now metered — unary, server streaming, client streaming and bidirectional: one `grpc_api.rpc_calls` event per call when it ends, with `grpcStatusCode`, `grpcCallType`, `messageCount` (request messages read plus responses sent) and `executionDurationMs`, POSTed to `https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>` and `X-Tenant-Id: <tenant_id>`.

> ⚠ Events are sent to the ingestor's **`/v1/ingest/batch`** path as `{"events": [...]}`, at most 1000 events per request (larger buffers are split). Set `ingestor_url` to the host only — the SDK appends the path.

> For `grpc.aio` servers use `AforoAioGrpcInterceptor` the same way: `grpc.aio.server(interceptors=[AforoAioGrpcInterceptor(billing, customer_resolver=customer_for)])`.

> **The customer must come from identity you verified.** Pass `customer_resolver=callable(context)` to the interceptor (or `customer_id_extractor=` to `AforoGrpcBilling`). Reading the `x-customer-id` metadata the caller sends needs `trust_customer_header=True`, because any caller can put any customer there. With neither, the interceptor raises `ValueError` when you build it. A call whose resolver returns nothing is served normally, not metered, and counted in `dropped_count` as `invalid`. `tenant_id` is fixed from config.

## Configuration

Constructor arguments for `AforoGrpcBilling(...)`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | — (required) | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | — (required) | Product the RPCs bill against. |
| `api_key` | `str` | — (required) | Aforo API key, sent to the ingestor as `X-API-Key`. |
| `ingestor_url` | `str` | — (required) | Host; `/v1/ingest/batch` is appended. |
| `service_name` | `str` | — (required) | Fully-qualified gRPC service; stamped as `grpcService`. |
| `flush_interval_sec` | `float` | `5.0` | Background flush cadence (daemon thread from construction). |
| `flush_count` | `int` | `500` | Events per request, and the queue size that wakes the sender early (at most 1000). |
| `on_error` | `Callable[[Exception], None]?` | logs | Receives a `TransportError`; branch on `.kind`: `outage` / `auth` (events still queued and retried), `rejected` (the ingestor refused them; message carries its `errors[].message`), `shutdown`, `closed`. `.events` and `.status` say which events and which HTTP status. |
| `on_drop` | `Callable[[list[dict], str], None]?` | `None` | Called with events that will not be delivered and the reason (`overflow`, `rejected`, `invalid`, `shutdown`, `closed`). See [Dropped events](#dropped-events). Pass by keyword. |
| `product_type` | `str` | `"GRPC_API"` | Top-level `productType` sent on every event (trimmed and upper-cased; values the SDK does not know are passed through). Override per event with `record(..., product_type=...)`. |
| `max_queue_size` | `int` | `10000` | Queue capacity; the oldest event is dropped as `overflow` when full. Keyword-only. |
| `timeout_sec` | `float` | `10.0` | Total deadline per HTTP request. Keyword-only. |
| `shutdown_timeout_sec` | `float` | `5.0` | `shutdown()` flushes for at most this long; leftovers are dropped as `shutdown`. Keyword-only. |
| `allow_insecure_http` | `bool` | `False` | Allow plain `http://` to a host other than localhost. Keyword-only. |
| `http_transport`, `transport_options` | | `None` | An `httpx` transport / extra transport-core settings, for tests and unusual networks. Keyword-only. |
| `customer_id_extractor` | `Callable[[Any], str?]?` | `None` | Customer resolver the interceptors use (`context -> str | None`). Required unless an interceptor gets `customer_resolver=` or `trust_customer_header=True`. |
| `trust_customer_header` | `bool` | `False` | Let the interceptors bill the `x-customer-id` metadata the caller sends. Keyword-only. |

Status mapping: `GRPC_STATUS_LABELS` maps numeric codes to descriptor labels (e.g. `OK`, `NOT_FOUND`, `UNAVAILABLE`); the interceptor records the label as `grpcStatusCode`. Delivery uses the shared transport core: `push()`/`record()` only queue (bounded by `max_queue_size`, default 10 000; the oldest event is dropped as `overflow` when full) and one background thread sends batches of up to `flush_count` events (default 500, at most 1000; a body over 4 MiB is split). Network errors, timeouts, 408, 429 and 5xx are retried 3 times with full-jitter backoff; `Retry-After` is honoured as seconds or an HTTP date, capped at 60 s. After that, or on 401/403 (logged at ERROR: the API key is wrong or revoked), the batch goes back to the front of the queue with the same idempotency keys and the sender pauses (full jitter, at most 5 s at first and at least 250 ms, growing to 5 min) — an outage loses nothing unless the queue fills. A redirect (3xx) is never followed, so the API key cannot reach another host; it is treated like 401/403 and logged at ERROR with the target host. Events the ingestor marks `retryable` in a 2xx are re-sent with the same keys after the same backoff, at most 3 times. Each request's `timeout_sec` covers the whole exchange, including reading the response. `flush()` during an outage makes one attempt. `shutdown()` keeps retrying until its deadline. An event that cannot be turned into JSON is dropped as `invalid` when you push it. A 413 splits the batch; any other 4xx drops it with reason `rejected`. `shutdown()` (also run at interpreter exit) flushes for at most `shutdown_timeout_sec` (default 5 s). `ingestor_url` must be `https://`; plain `http://` only for localhost / 127.0.0.1 / ::1 or with `allow_insecure_http=True`. The API key is sent only as `X-API-Key` and never appears in `repr()` or logs.

## Execution status (`executionStatus`)

Each event can carry an execution status. OUTCOME_BASED rate plans bill each event at the weight set for its status; events without one bill at full price.

The SDK derives it from the gRPC status code:

| gRPC status | `executionStatus` |
|---|---|
| `OK` | `SUCCESS` |
| `CANCELLED` | `CANCELLED` |
| `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `OUT_OF_RANGE` | `VALIDATION_FAILED` |
| `DEADLINE_EXCEEDED` | `TIMEOUT` |
| `PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`, `UNAUTHENTICATED` | `BLOCKED` |
| any other code | `ERROR` |

The interceptor reads the code the handler set with `context.abort(...)` or `context.set_code(...)` (grpcio 1.38+); without one, an uncaught exception counts as `INTERNAL` and a normal return as `OK`.

The mapping is exported as `outcome_from_grpc_status(...)` (takes a `grpc.StatusCode`, its int value, or its name). A value you pass yourself always wins:

```python
billing.record("ListUsers", "SERVER_STREAM", customer_id, "OK", count, duration_ms,
               execution_status="PARTIAL")

# Interceptor: return a status from the handler's context (None keeps the derived one)
AforoGrpcInterceptor(billing, execution_status_resolver=lambda ctx: current_outcome.get(None))
```

`execution_status` is keyword-only. The SDK trims and upper-cases it and leaves it off the event when it's blank. If `status` isn't a gRPC status name or code, and you pass no value, the event goes out without one. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED` — any other value is logged as a warning and left off the event, since the ingestor would reject the event.

## Dropped events

An event that will never reach Aforo is counted in `billing.dropped_count`, logged at WARNING, and passed to the opt-in `on_drop(events, reason)` hook. The events keep their idempotency keys, so sending them again later cannot double-bill.

| Reason | When |
|---|---|
| `invalid` | The event failed a client-side check (a blank `customer_id`, one longer than 64 characters, or a blank `method`). It is not buffered or sent. `record()` does not raise for event content. An over-long method name does not drop the event: it comes from the client's request, so it is truncated to 128 characters and the event is sent (one WARNING per client). |
| `rejected` | The ingestor answered 4xx (other than 408 / 429) for the batch, or refused individual events inside a 202 response. |
| `overflow` | The queue was full (usually a long ingest outage); the oldest event was evicted. |
| `shutdown` | Still queued when `shutdown()` reached `shutdown_timeout_sec`. |
| `closed` | Sent after `shutdown()`. |

```python
def on_drop(events, reason):
    dead_letter.write(reason, events)

billing = AforoGrpcBilling(..., on_drop=on_drop)
```

When a 202 response reports refused events without a usable `index`, they are counted in `dropped_count` but not passed to the hook, since the SDK cannot tell which events they were. Exceptions raised by the hook are swallowed. An unknown `executionStatus` is not a drop: the field is left off and the event is still sent.

## Walk me through it

Install → add the interceptor → call an RPC → confirm the event in Aforo, plus the streaming pattern, is in **[USER_GUIDE.md](USER_GUIDE.md)**.

## What this doesn't cover

The interceptor only auto-meters **unary** RPCs — streaming RPCs need a manual `record()` (the SDK can't know when a stream ends or how many messages flowed). It meters per-call, not per-message, unless you pass `message_count`/`data_bytes` to `record()`. It doesn't enforce quotas or abort RPCs. Pricing and metric mapping live in the Aforo console.
