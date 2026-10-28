"""G286: every RPC shape is metered, on grpc.server and grpc.aio. G265: the
customer comes from a resolver or an explicit trust opt-in."""

from __future__ import annotations

import asyncio
from concurrent import futures

import grpc
import pytest

from fakes import ScriptedServer
from aforo_grpc_metering import AforoAioGrpcInterceptor, AforoGrpcBilling, AforoGrpcInterceptor

pytestmark = pytest.mark.real_transport

SERVICE = "acme.v1.Echo"


def _billing(server):
    return AforoGrpcBilling(tenant_id="t", product_id="p", api_key="k", ingestor_url="https://ingest.example.test",
                            service_name=SERVICE, flush_interval_sec=3600, http_transport=server.transport())


def _events(server):
    return sorted((e["grpcMethod"], e["grpcCallType"], e["messageCount"], e["grpcStatusCode"], e["customerId"])
                  for r in server.requests for e in r["body"]["events"])


def _sync_handlers():
    def unary(request, context):
        return request

    def server_stream(request, context):
        for _ in range(3):
            yield request

    def client_stream(request_iterator, context):
        return b"".join(request_iterator)

    def bidi(request_iterator, context):
        for item in request_iterator:
            yield item

    def failing(request, context):
        context.abort(grpc.StatusCode.PERMISSION_DENIED, "no")

    return grpc.method_handlers_generic_handler(SERVICE, {
        "Unary": grpc.unary_unary_rpc_method_handler(unary),
        "ServerStream": grpc.unary_stream_rpc_method_handler(server_stream),
        "ClientStream": grpc.stream_unary_rpc_method_handler(client_stream),
        "Bidi": grpc.stream_stream_rpc_method_handler(bidi),
        "Failing": grpc.unary_unary_rpc_method_handler(failing),
    })


def _exercise(channel):
    channel.unary_unary(f"/{SERVICE}/Unary")(b"a", metadata=(("x-customer-id", "cust_md"),))
    list(channel.unary_stream(f"/{SERVICE}/ServerStream")(b"a"))
    channel.stream_unary(f"/{SERVICE}/ClientStream")(iter([b"a", b"b"]))
    list(channel.stream_stream(f"/{SERVICE}/Bidi")(iter([b"a", b"b", b"c"])))
    with pytest.raises(grpc.RpcError):
        channel.unary_unary(f"/{SERVICE}/Failing")(b"a")


EXPECTED = [
    ("Bidi", "BIDI_STREAM", 6, "OK", "cust_auth"),
    ("ClientStream", "CLIENT_STREAM", 3, "OK", "cust_auth"),
    ("Failing", "UNARY", 1, "PERMISSION_DENIED", "cust_auth"),
    ("ServerStream", "SERVER_STREAM", 4, "OK", "cust_auth"),
    ("Unary", "UNARY", 1, "OK", "cust_auth"),
]


def test_sync_server_meters_all_four_rpc_shapes():
    http = ScriptedServer()
    billing = _billing(http)
    interceptor = AforoGrpcInterceptor(billing, customer_resolver=lambda context: "cust_auth")
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4), interceptors=[interceptor])
    server.add_generic_rpc_handlers((_sync_handlers(),))
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    try:
        with grpc.insecure_channel(f"127.0.0.1:{port}") as channel:
            _exercise(channel)
    finally:
        server.stop(0)
    billing.shutdown()
    assert _events(http) == EXPECTED


def test_aio_server_meters_all_four_rpc_shapes():
    http = ScriptedServer()
    billing = _billing(http)

    async def unary(request, context):
        return request

    async def server_stream(request, context):
        for _ in range(3):
            yield request

    async def client_stream(request_iterator, context):
        return b"".join([item async for item in request_iterator])

    async def bidi(request_iterator, context):
        async for item in request_iterator:
            yield item

    async def failing(request, context):
        await context.abort(grpc.StatusCode.PERMISSION_DENIED, "no")

    handlers = grpc.method_handlers_generic_handler(SERVICE, {
        "Unary": grpc.unary_unary_rpc_method_handler(unary),
        "ServerStream": grpc.unary_stream_rpc_method_handler(server_stream),
        "ClientStream": grpc.stream_unary_rpc_method_handler(client_stream),
        "Bidi": grpc.stream_stream_rpc_method_handler(bidi),
        "Failing": grpc.unary_unary_rpc_method_handler(failing),
    })

    async def main():
        server = grpc.aio.server(interceptors=[
            AforoAioGrpcInterceptor(billing, customer_resolver=lambda context: "cust_auth")])
        server.add_generic_rpc_handlers((handlers,))
        port = server.add_insecure_port("127.0.0.1:0")
        await server.start()
        try:
            async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
                await channel.unary_unary(f"/{SERVICE}/Unary")(b"a")
                [r async for r in channel.unary_stream(f"/{SERVICE}/ServerStream")(b"a")]

                async def requests(n):
                    for i in range(n):
                        yield bytes([97 + i])

                await channel.stream_unary(f"/{SERVICE}/ClientStream")(requests(2))
                [r async for r in channel.stream_stream(f"/{SERVICE}/Bidi")(requests(3))]
                with pytest.raises(grpc.RpcError):
                    await channel.unary_unary(f"/{SERVICE}/Failing")(b"a")
        finally:
            await server.stop(0)

    asyncio.run(main())
    billing.shutdown()
    assert _events(http) == EXPECTED


def test_interceptor_without_a_customer_source_refuses_to_start():
    billing = _billing(ScriptedServer())
    try:
        with pytest.raises(ValueError, match="customer_resolver"):
            AforoGrpcInterceptor(billing)
        with pytest.raises(ValueError, match="trust_customer_header"):
            AforoAioGrpcInterceptor(billing)
    finally:
        billing.shutdown(timeout=0)


def test_metadata_is_used_only_with_the_trust_opt_in_and_a_missing_customer_is_counted():
    http = ScriptedServer()
    billing = _billing(http)
    trusted = AforoGrpcInterceptor(billing, trust_customer_header=True)
    resolved = AforoGrpcInterceptor(billing, customer_resolver=lambda ctx: None)

    class _Ctx:
        def invocation_metadata(self):
            return (("x-customer-id", "cust_md"),)

    class _H:
        unary_unary = staticmethod(lambda request, context: b"ok")
        unary_stream = stream_unary = stream_stream = None
        request_deserializer = response_serializer = None

    class _Details:
        method = f"/{SERVICE}/Unary"

    trusted.intercept_service(lambda d: _H(), _Details()).unary_unary(b"", _Ctx())
    resolved.intercept_service(lambda d: _H(), _Details()).unary_unary(b"", _Ctx())
    billing.shutdown()
    assert [e["customerId"] for r in http.requests for e in r["body"]["events"]] == ["cust_md"]
    assert billing.dropped_count == 1  # the call with no customer, as "invalid"
