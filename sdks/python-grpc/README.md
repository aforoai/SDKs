# aforo-grpc-metering

Aforo gRPC Metering SDK for Python. Meters every RPC call, maps gRPC status codes to descriptor enum labels, and ships billing events to Aforo's usage ingestor.

## Install

```bash
pip install aforo-grpc-metering grpcio
```

Optional HTTP clients (faster than stdlib urllib):
```bash
pip install aforo-grpc-metering[httpx]    # or [aiohttp]
```

## Usage — ServerInterceptor (unary)

```python
import grpc
from concurrent import futures
from aforo_grpc_metering import AforoGrpcBilling, AforoGrpcInterceptor

billing = AforoGrpcBilling(
    tenant_id="tenant_acme",
    product_id="prod_grpc_user_svc",
    api_key=os.environ["AFORO_API_KEY"],
    ingestor_url="https://ingestor.aforo.ai",
    service_name="acme.v1.UserService",
)

server = grpc.server(
    futures.ThreadPoolExecutor(max_workers=10),
    interceptors=[AforoGrpcInterceptor(billing)],
)
# ... add_UserServiceServicer_to_server(servicer, server)
server.add_insecure_port("[::]:50051")
server.start()
server.wait_for_termination()
```

Every unary RPC handled by `server` is now metered — one `GRPC_API` event per call with accurate `grpcStatusCode`, `grpcCallType=UNARY`, and `executionDurationMs`.

## Usage — streaming RPCs

For `server-stream`, `client-stream`, and `bidi-stream` methods, the interceptor doesn't auto-wrap. Call `billing.record()` directly at the end of your handler:

```python
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

## Customer-ID resolution

Default: reads `x-customer-id` from gRPC invocation metadata. Override via the constructor:

```python
billing = AforoGrpcBilling(
    # ...
    customer_id_extractor=lambda ctx: decode_jwt(
        dict(ctx.invocation_metadata()).get("authorization", "")
    ),
)
```

Calls with no resolvable customer ID are **not** metered.

## Batching & retry

- Buffer size: 50 events (configurable via `flush_count`)
- Flush interval: 5 seconds (configurable via `flush_interval_sec`)
- 3× exponential retry (1s / 2s / 4s) on ingestor failure
- Dropped batches invoke the `on_error` callback

Call `billing.shutdown()` before process exit to flush the final batch.

## License

MIT
