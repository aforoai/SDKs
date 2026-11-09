"""End-to-end test finding (2026-11-09): the README said ``messageCount`` is
"request messages read plus responses sent" (2 for a unary call) while unary
calls store 1, as in every other gRPC SDK, and its limits section said the
interceptor "only auto-meters unary RPCs" although all four shapes are metered.
This locks the documented counts against a real grpcio server."""

from __future__ import annotations

import pathlib
from concurrent import futures

import pytest

from fakes import ScriptedServer
from aforo_grpc_metering import AforoGrpcBilling, AforoGrpcInterceptor

grpc = pytest.importorskip("grpc")
pytestmark = pytest.mark.real_transport

README = pathlib.Path(__file__).resolve().parent.parent / "README.md"
_ident = lambda b: b  # noqa: E731  (raw bytes in and out: no generated stubs needed)


def _handlers():
    def say(req, ctx):
        return b"hi"

    def count(req, ctx):
        for _ in range(3):
            yield b"r"

    def total(it, ctx):
        return b"%d" % sum(1 for _ in it)

    def chat(it, ctx):
        for m in it:
            yield m

    return grpc.method_handlers_generic_handler("e2e.v1.Echo", {
        "Say": grpc.unary_unary_rpc_method_handler(say, _ident, _ident),
        "Count": grpc.unary_stream_rpc_method_handler(count, _ident, _ident),
        "Sum": grpc.stream_unary_rpc_method_handler(total, _ident, _ident),
        "Chat": grpc.stream_stream_rpc_method_handler(chat, _ident, _ident),
    })


def test_message_count_per_call_shape_matches_the_readme():
    server = ScriptedServer()
    billing = AforoGrpcBilling(tenant_id="t", product_id="p", api_key="k",
                               ingestor_url="https://ingest.example.test", service_name="e2e.v1.Echo",
                               flush_interval_sec=3600, http_transport=server.transport())
    srv = grpc.server(futures.ThreadPoolExecutor(max_workers=4),
                      interceptors=[AforoGrpcInterceptor(billing, customer_resolver=lambda ctx: "cust_1")])
    srv.add_generic_rpc_handlers((_handlers(),))
    port = srv.add_insecure_port("127.0.0.1:0")
    srv.start()
    try:
        with grpc.insecure_channel(f"127.0.0.1:{port}") as ch:
            ch.unary_unary("/e2e.v1.Echo/Say")(b"x")
            list(ch.unary_stream("/e2e.v1.Echo/Count")(b"x"))
            ch.stream_unary("/e2e.v1.Echo/Sum")(iter([b"1", b"2", b"3"]))
            list(ch.stream_stream("/e2e.v1.Echo/Chat")(iter([b"a", b"b", b"c"])))
    finally:
        srv.stop(grace=1).wait()
    billing.shutdown()
    events = {e["grpcMethod"]: (e["grpcCallType"], e["messageCount"])
              for r in server.requests for e in r["body"]["events"]}
    assert events == {
        "Say": ("UNARY", 1),             # unary: 1
        "Count": ("SERVER_STREAM", 4),   # 1 request read + 3 responses sent
        "Sum": ("CLIENT_STREAM", 4),     # 3 requests read + 1 response sent
        "Chat": ("BIDI_STREAM", 6),      # 3 read + 3 sent
    }


def test_readme_describes_what_the_interceptor_records():
    text = README.read_text(encoding="utf-8")
    assert "only auto-meters **unary**" not in text
    assert "`messageCount` is 1 for a unary call" in text
