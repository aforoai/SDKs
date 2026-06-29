# aforo-grpc-metering

Meter every gRPC call with a server interceptor — one Aforo event per RPC, with the gRPC status mapped to a readable label, call type, and duration. Streaming RPCs are metered with one explicit `record()` call.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install:

```bash
pip install aforo-grpc-metering
pip install "aforo-grpc-metering[httpx]"     # or [aiohttp] — faster HTTP flush than stdlib urllib
```

**Not yet on PyPI — install from source for now:**

```bash
git clone https://github.com/aforoai/aforo-metering-sdks.git
cd aforo-metering-sdks/python-grpc     # folder holding setup.py
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
    ingestor_url="https://ingest.aforo.ai",
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

Every unary RPC is now metered — one `grpc_api.rpc_calls` event with `grpcStatusCode`, `grpcCallType=UNARY`, and `executionDurationMs`, POSTed to `https://ingest.aforo.ai/v1/ingest/events` with `Authorization: Bearer <api_key>` and `X-Tenant-Id: <tenant_id>`.

> ⚠ This package targets the ingestor's **`/v1/ingest/events`** path (the base and MCP Aforo SDKs use `/v1/ingest/batch`). Set `ingestor_url` to the host only — the SDK appends the path.

> The interceptor auto-wraps **unary** RPCs only. For server-stream / client-stream / bidi, call `billing.record(...)` yourself at the end of the handler (see the [user guide](USER_GUIDE.md#step-5--meter-streaming-rpcs)). `tenant_id` is fixed from config; the default extractor reads `x-customer-id` from invocation metadata, and calls with no resolvable customer ID are **not** metered.

## Configuration

Constructor arguments for `AforoGrpcBilling(...)`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | — (required) | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | — (required) | Product the RPCs bill against. |
| `api_key` | `str` | — (required) | Bearer token for the ingestor. |
| `ingestor_url` | `str` | — (required) | Host; `/v1/ingest/events` is appended. |
| `service_name` | `str` | — (required) | Fully-qualified gRPC service; stamped as `grpcService`. |
| `flush_interval_sec` | `float` | `5.0` | Background flush cadence (daemon thread from construction). |
| `flush_count` | `int` | `50` | Buffer size that triggers an immediate flush. |
| `on_error` | `Callable[[Exception], None]?` | logs | Called on permanent batch failure. |
| `customer_id_extractor` | `Callable[[Any], str?]?` | reads `x-customer-id` from metadata | Resolve the billed customer from the gRPC context. |

Status mapping: `GRPC_STATUS_LABELS` maps numeric codes to descriptor labels (e.g. `OK`, `NOT_FOUND`, `UNAVAILABLE`); the interceptor records the label as `grpcStatusCode`. Retry is fixed at **3 attempts** (`1s / 2s / 4s`); 4xx from the ingestor is non-retryable.

## Walk me through it

Install → add the interceptor → call an RPC → confirm the event in Aforo, plus the streaming pattern, is in **[USER_GUIDE.md](USER_GUIDE.md)**.

## What this doesn't cover

The interceptor only auto-meters **unary** RPCs — streaming RPCs need a manual `record()` (the SDK can't know when a stream ends or how many messages flowed). It meters per-call, not per-message, unless you pass `message_count`/`data_bytes` to `record()`. It doesn't enforce quotas or abort RPCs. Pricing and metric mapping live in the Aforo console.
