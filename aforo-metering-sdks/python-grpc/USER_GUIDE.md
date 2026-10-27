# aforo-grpc-metering — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** Python engineers running a gRPC server who need per-RPC billing.

## What you'll build

A gRPC server that reports one Aforo event per RPC — unary calls metered automatically by a server interceptor, streaming calls metered with one explicit `record()` — each event carrying the gRPC status label, call type, and duration. You'll finish by confirming a real RPC reached the Aforo ingestor.

## Prerequisites

- Python **3.9+** and `grpcio>=1.50`.
- An Aforo **API key**, **tenant id**, and **product id** from the Aforo console.
- The fully-qualified gRPC **service name** (e.g. `acme.v1.UserService`).
- A function that returns the customer for a call from identity your service verified (a validated token, an mTLS peer).

## Step 1 — Install

```bash
pip install -e .                  # from python-grpc/ (or: pip install "aforo-grpc-metering>=2.0.0")
pip install -e ".[httpx]"         # or [aiohttp]
```

## Step 2 — Construct the billing client

```python
import os
from aforo_grpc_metering import AforoGrpcBilling

billing = AforoGrpcBilling(
    tenant_id="tenant_acme",
    product_id="prod_grpc_user_svc",
    api_key=os.environ["AFORO_API_KEY"],
    ingestor_url="https://api.aforo.ai",
    service_name="acme.v1.UserService",
)
```

All five arguments are required — the constructor raises `ValueError` if any (including `service_name`) is missing.

> ⚠ `ingestor_url` is the **host**; this package appends `/v1/ingest/batch`. Pass `https://api.aforo.ai`.

## Step 3 — Add the interceptor

```python
import grpc
from concurrent import futures
from aforo_grpc_metering import AforoGrpcInterceptor

server = grpc.server(
    futures.ThreadPoolExecutor(max_workers=10),
    interceptors=[AforoGrpcInterceptor(billing, customer_resolver=customer_for)],
)
# grpc.aio:  grpc.aio.server(interceptors=[AforoAioGrpcInterceptor(billing, customer_resolver=customer_for)])
```

The interceptor wraps all four RPC shapes (unary, server streaming, client streaming, bidirectional) and records each call once, when it ends, in a `finally` — so failed RPCs are still billed with the mapped error label.

## Step 4 — Make sure the customer ID resolves

The interceptor needs a customer resolver: `customer_resolver=` on the interceptor, or `customer_id_extractor=` on `AforoGrpcBilling`. Without one it raises `ValueError` when you build it. A call whose resolver returns nothing still runs; it is not metered and is counted as an `invalid` drop.

```python
def customer_for(context):
    token = dict(context.invocation_metadata()).get("authorization", "")
    return verify_jwt(token)["customer_id"]   # verified, not taken on trust

interceptor = AforoGrpcInterceptor(billing, customer_resolver=customer_for)
```

> ⚠ `trust_customer_header=True` makes the interceptor bill the `x-customer-id` metadata as sent. Any caller can set it to any customer, so use it only when a proxy in front of the service overwrites it.

## Step 5 — Streaming RPCs

The interceptor meters streaming RPCs on its own: one event when the stream ends, with `messageCount` = request messages read plus response messages sent. Call `record()` yourself only for calls that do not pass through the interceptor, for example:

```python
import time

def ListUsers(request, context):
    start = time.monotonic()
    message_count = 0
    try:
        for user in query(...):
            message_count += 1
            yield user
    finally:
        billing.record(
            method="ListUsers",
            call_type="SERVER_STREAM",
            customer_id=extract_customer(context),
            status="OK",
            message_count=message_count,
            duration_ms=int((time.monotonic() - start) * 1000),
        )
```

`record()` no-ops if `customer_id` is falsy — resolve it before calling.

## Step 6 — Run an RPC and flush

Call any RPC against the server. `record()` only queues; one background thread sends batches of up to `flush_count` (500) events every `flush_interval_sec` (5 s), sooner when 500 are queued. If the ingestor is down, batches stay queued and are retried after a pause. To send now and wait (`flush()` returns how many events are still queued):

```python
billing.flush()
```

## Step 7 — Verify it landed in Aforo

In the Aforo console, open the usage/events view for your tenant and filter by `metric_name = grpc_api.rpc_calls`. You should see one event per call carrying `grpcService`, `grpcMethod`, `grpcStatusCode`, `grpcCallType`, and `executionDurationMs`. If nothing appears, check the `ingestor_url` host and that your customer resolver returns a value — see Troubleshooting.

## Step 8 — Shut down cleanly

```python
billing.shutdown()   # flushes the final batch before process exit
```

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | required | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | required | Product the RPCs bill against. |
| `api_key` | `str` | required | Aforo API key, sent as `X-API-Key`. |
| `ingestor_url` | `str` | required | Host; `/v1/ingest/batch` appended. |
| `service_name` | `str` | required | Stamped as `grpcService`. |
| `flush_interval_sec` | `float` | `5.0` | Background flush cadence. |
| `flush_count` | `int` | `500` | Events per request, and the queue size that wakes the sender early (at most 1000). |
| `on_error` | `Callable?` | logs | Receives a `TransportError`; branch on `.kind`: `outage` / `auth` (events still queued and retried), `rejected` (the ingestor refused them; message carries its `errors[].message`), `shutdown`, `closed`. `.events` and `.status` say which events and which HTTP status. |
| `on_drop` | `Callable[[list[dict], str], None]?` | `None` | Called with events that will not be delivered and the reason (`overflow`, `rejected`, `invalid`, `shutdown`, `closed`). Pass by keyword. |
| `product_type` | `str` | `"GRPC_API"` | Top-level `productType` sent on every event (trimmed and upper-cased; values the SDK does not know are passed through). Override per event with `record(..., product_type=...)`. |
| `max_queue_size` | `int` | `10000` | Queue capacity; the oldest event is dropped as `overflow` when full. Keyword-only. |
| `timeout_sec` | `float` | `10.0` | Total deadline per HTTP request. Keyword-only. |
| `shutdown_timeout_sec` | `float` | `5.0` | `shutdown()` flushes for at most this long; leftovers are dropped as `shutdown`. Keyword-only. |
| `allow_insecure_http` | `bool` | `False` | Allow plain `http://` to a host other than localhost. Keyword-only. |
| `http_transport`, `transport_options` | | `None` | An `httpx` transport / extra transport-core settings, for tests and unusual networks. Keyword-only. |
| `customer_id_extractor` | `Callable?` | `None` | Customer resolver used by the interceptors; or pass `customer_resolver=` to the interceptor. |
| `trust_customer_header` | `bool` | `False` | Bill the `x-customer-id` metadata as sent. |

`record()` arguments: `method`, `call_type`, `customer_id`, `status`, `message_count`, `duration_ms`, `data_bytes=0`. Exports: `AforoGrpcBilling`, `AforoGrpcInterceptor`, `GRPC_STATUS_LABELS`.

Execution status (`executionStatus`, used by OUTCOME_BASED pricing) is described in the [README](README.md#execution-status-executionstatus).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Unary calls metered, streaming calls aren't | The interceptor auto-wraps unary only. | Call `billing.record(...)` in the streaming handler's `finally`. |
| Some calls never metered; `dropped_count` rises with `invalid` | Your customer resolver returned nothing for those calls. | Check the resolver against an authenticated call. |
| `ValueError: AforoGrpcInterceptor needs to know which customer to bill` | No resolver and no `trust_customer_header`. | Pass `customer_resolver=` (recommended). |
| ERROR log "Ingestor answered HTTP 401" (or 403) | Bad or revoked API key. The events stay queued (up to `max_queue_size`) and are retried after a pause. | Fix `api_key` and restart; confirm it matches `tenant_id`. |
| `billing.dropped_count` is above 0 | Events were dropped: `invalid` (failed a client-side check, or no customer), `rejected` (ingestor refused them), `overflow` (queue full during an outage), `shutdown` (still queued at the shutdown deadline) or `closed` (sent after shutdown). An ingest outage alone does not drop events. | Read the WARNING log line for the reason; see [Dropped events](README.md#dropped-events). |
| Events sent, none in console | Wrong `ingestor_url` host, or `grpc_api.rpc_calls` isn't mapped to a rate plan. | Use `https://api.aforo.ai`; map the metric in Aforo. |
| `grpcStatusCode` shows `UNKNOWN` for errors | The numeric code wasn't in `GRPC_STATUS_LABELS` (defaults to `UNKNOWN`, code 2). | Expected for unusual codes; pass an explicit `status` label via `record()` if you need precision. |
| Final batch lost on shutdown | `shutdown()` not called before exit. | Call `billing.shutdown()` in your server-stop path. |

## What this guide does NOT cover

Per-message metering for streams beyond the `message_count`/`data_bytes` you pass to `record()`. Client-side interceptors (this is server-side). Quota enforcement or aborting RPCs — the SDK only emits events. Pricing and metric mapping are in the Aforo console.
