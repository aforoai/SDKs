# aforo-grpc-metering

Meter every gRPC call with a server interceptor — one Aforo event per RPC, with the gRPC status mapped to a readable label, call type, and duration. Streaming RPCs are metered with one explicit `record()` call.

**Version:** 1.2.2 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install:

```bash
pip install aforo-grpc-metering
pip install "aforo-grpc-metering[httpx]"     # or [aiohttp] — faster HTTP flush than stdlib urllib
```

**Install `1.2.2` or later. `1.0.0` on PyPI was built from an older copy of this code and lacks the fixes listed in the changelog.** If `1.2.2` is not on PyPI yet, install from source:

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

server = grpc.server(
    futures.ThreadPoolExecutor(max_workers=10),
    interceptors=[AforoGrpcInterceptor(billing)],
)
# add_UserServiceServicer_to_server(servicer, server)
server.add_insecure_port("[::]:50051")
server.start()
server.wait_for_termination()
```

Every unary RPC is now metered — one `grpc_api.rpc_calls` event with `grpcStatusCode`, `grpcCallType=UNARY`, and `executionDurationMs`, POSTed to `https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>` and `X-Tenant-Id: <tenant_id>`.

> ⚠ Events are sent to the ingestor's **`/v1/ingest/batch`** path as `{"events": [...]}`, at most 1000 events per request (larger buffers are split). Set `ingestor_url` to the host only — the SDK appends the path.

> The interceptor auto-wraps **unary** RPCs only. For server-stream / client-stream / bidi, call `billing.record(...)` yourself at the end of the handler (see the [user guide](USER_GUIDE.md#step-5--meter-streaming-rpcs)). `tenant_id` is fixed from config; the default extractor reads `x-customer-id` from invocation metadata, and calls with no resolvable customer ID are **not** metered.

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
| `flush_count` | `int` | `50` | Buffer size that triggers an immediate flush. |
| `on_error` | `Callable[[Exception], None]?` | logs | Called on permanent batch failure, and with the ingestor's `errors[].message` when it rejects events. |
| `on_drop` | `Callable[[list[dict], str], None]?` | `None` | Called with events that will not be delivered and the reason (`invalid`, `rejected`, `retry_exhausted`). See [Dropped events](#dropped-events). Pass by keyword. |
| `product_type` | `str` | `"GRPC_API"` | Top-level `productType` sent on every event (trimmed and upper-cased; values the SDK does not know are passed through). Override per event with `record(..., product_type=...)`. |
| `customer_id_extractor` | `Callable[[Any], str?]?` | reads `x-customer-id` from metadata | Resolve the billed customer from the gRPC context. |

Status mapping: `GRPC_STATUS_LABELS` maps numeric codes to descriptor labels (e.g. `OK`, `NOT_FOUND`, `UNAVAILABLE`); the interceptor records the label as `grpcStatusCode`. Retry is fixed at **3 attempts** (`1s / 2s` backoff between them); 408 and 5xx are retried, 429 waits for `Retry-After` (capped at 60 s), and any other 4xx is not retried and the batch is dropped with reason `rejected`.

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
| `retry_exhausted` | Network errors, 5xx, 408 or 429 on all 3 attempts. |

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
