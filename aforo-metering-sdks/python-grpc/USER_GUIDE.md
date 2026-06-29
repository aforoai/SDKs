# aforo-grpc-metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Python engineers running a gRPC server who need per-RPC billing.

## What you'll build

A gRPC server that reports one Aforo event per RPC — unary calls metered automatically by a server interceptor, streaming calls metered with one explicit `record()` — each event carrying the gRPC status label, call type, and duration. You'll finish by confirming a real RPC reached the Aforo ingestor.

## Prerequisites

- Python **3.9+** and `grpcio>=1.50`.
- An Aforo **API key**, **tenant id**, and **product id** from the Aforo console.
- The fully-qualified gRPC **service name** (e.g. `acme.v1.UserService`).
- Callers that send `x-customer-id` in gRPC metadata, or a custom extractor.

## Step 1 — Install

```bash
pip install -e .                  # from python-grpc/ (not yet on PyPI)
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
    ingestor_url="https://ingest.aforo.ai",
    service_name="acme.v1.UserService",
)
```

All five arguments are required — the constructor raises `ValueError` if any (including `service_name`) is missing.

> ⚠ `ingestor_url` is the **host**; this package appends `/v1/ingest/events`. Pass `https://ingest.aforo.ai`.

## Step 3 — Add the interceptor

```python
import grpc
from concurrent import futures
from aforo_grpc_metering import AforoGrpcInterceptor

server = grpc.server(
    futures.ThreadPoolExecutor(max_workers=10),
    interceptors=[AforoGrpcInterceptor(billing)],
)
```

The interceptor times each handler and records the call in a `finally`, so failed RPCs are still billed with the mapped error label.

## Step 4 — Make sure the customer ID resolves

The default extractor reads `x-customer-id` from invocation metadata. A call with no resolvable customer ID is dropped — not metered. Set it client-side, or override:

```python
billing = AforoGrpcBilling(
    # ...
    customer_id_extractor=lambda ctx: decode_jwt(
        dict(ctx.invocation_metadata()).get("authorization", "")
    ),
)
```

> ⚠ Derive `customer_id` from something you trust (a verified token, your mesh identity). Don't bill against a raw metadata value the caller can set to any customer.

## Step 5 — Meter streaming RPCs

The interceptor auto-wraps **unary** only. For server-stream, client-stream, and bidi, call `record()` at the end of the handler — it's the only way the SDK learns the message count and final status:

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

Call any RPC against the server. Events buffer and flush on `flush_count` (50) or every `flush_interval_sec` (5 s) via a daemon thread started at construction. Force delivery now:

```python
billing.flush()
```

## Step 7 — Verify it landed in Aforo

In the Aforo console, open the usage/events view for your tenant and filter by `metric_name = grpc_api.rpc_calls`. You should see one event per call carrying `grpcService`, `grpcMethod`, `grpcStatusCode`, `grpcCallType`, and `executionDurationMs`. If nothing appears, check the `ingestor_url` host and the `x-customer-id` metadata — see Troubleshooting.

## Step 8 — Shut down cleanly

```python
billing.shutdown()   # flushes the final batch before process exit
```

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | required | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | required | Product the RPCs bill against. |
| `api_key` | `str` | required | Bearer token. |
| `ingestor_url` | `str` | required | Host; `/v1/ingest/events` appended. |
| `service_name` | `str` | required | Stamped as `grpcService`. |
| `flush_interval_sec` | `float` | `5.0` | Background flush cadence. |
| `flush_count` | `int` | `50` | Buffer size that forces a flush. |
| `on_error` | `Callable?` | logs | Called on permanent batch failure. |
| `customer_id_extractor` | `Callable?` | reads `x-customer-id` metadata | Resolve the billed customer. |

`record()` arguments: `method`, `call_type`, `customer_id`, `status`, `message_count`, `duration_ms`, `data_bytes=0`. Exports: `AforoGrpcBilling`, `AforoGrpcInterceptor`, `GRPC_STATUS_LABELS`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Unary calls metered, streaming calls aren't | The interceptor auto-wraps unary only. | Call `billing.record(...)` in the streaming handler's `finally`. |
| Some calls never metered | No `x-customer-id` in metadata, so the extractor returned nothing. | Send the metadata client-side or supply a `customer_id_extractor`. |
| `on_error` fires with "Aforo returned 401/403" | Bad/unscoped API key — 4xx is dropped, not retried. | Fix `api_key`; confirm it matches `tenant_id`. |
| Events sent, none in console | Wrong `ingestor_url` host, or `grpc_api.rpc_calls` isn't mapped to a rate plan. | Use `https://ingest.aforo.ai`; map the metric in Aforo. |
| `grpcStatusCode` shows `UNKNOWN` for errors | The numeric code wasn't in `GRPC_STATUS_LABELS` (defaults to `UNKNOWN`, code 2). | Expected for unusual codes; pass an explicit `status` label via `record()` if you need precision. |
| Final batch lost on shutdown | `shutdown()` not called before exit. | Call `billing.shutdown()` in your server-stop path. |

## What this guide does NOT cover

Per-message metering for streams beyond the `message_count`/`data_bytes` you pass to `record()`. Client-side interceptors (this is server-side). Quota enforcement or aborting RPCs — the SDK only emits events. Pricing and metric mapping are in the Aforo console.
