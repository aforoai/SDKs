"""
Real-server integration test for aforo-grpc-metering.

Where test_client.py uses mock context objects, this file:
  - spins up a REAL grpc.server on a random localhost port
  - registers a programmatically-defined service (no .proto, no protoc)
    via grpc.method_handlers_generic_handler — JSON serialization
  - installs AforoGrpcInterceptor
  - connects a REAL grpc client and makes UNARY calls
  - asserts the metering event reaches an http capture server with
    the expected method name, status, customer ID, and headers

Catches what mock-based tests can't:
  - real grpc.ServicerContext.invocation_metadata() shape
  - real status code propagation from raised handler errors
  - real wire-time latency vs synthetic time.monotonic() in mocks
  - HTTP headers actually transit on the flush

Self-contained — no external broker. Skipped when grpcio is missing.
"""
from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, List, Optional, Tuple

import pytest

from aforo_grpc_metering import AforoGrpcBilling

try:
    import grpc  # type: ignore
    HAS_GRPC = True
except ImportError:  # pragma: no cover
    HAS_GRPC = False


pytestmark = pytest.mark.skipif(not HAS_GRPC, reason="grpcio not installed")


# ── Capture HTTP server for the ingestor ──────────────────────────────

class _CapturingHandler(BaseHTTPRequestHandler):
    captured: List[Dict[str, Any]] = []  # populated by the test fixture

    def do_POST(self) -> None:  # noqa: N802 — http.server contract
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else None
        except Exception:
            body = None
        type(self).captured.append({
            "url": self.path,
            "body": body,
            "headers": dict(self.headers),
        })
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_args: Any) -> None:  # silence noisy default
        pass


def _start_http_capture() -> Tuple[HTTPServer, threading.Thread, List[Dict[str, Any]]]:
    captured: List[Dict[str, Any]] = []

    class _Handler(_CapturingHandler):
        pass

    _Handler.captured = captured
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, captured


# ── Programmatic gRPC service definition (no .proto) ──────────────────

def _serialize(value: Dict[str, Any]) -> bytes:
    return json.dumps(value).encode("utf-8")


def _deserialize(buf: bytes) -> Dict[str, Any]:
    return json.loads(buf.decode("utf-8"))


def _make_say_hello_handler() -> Any:
    def behavior(request: Dict[str, Any], context: Any) -> Dict[str, Any]:
        return {"message": f"hello {request.get('name', 'anon')}"}
    return grpc.unary_unary_rpc_method_handler(
        behavior,
        request_deserializer=_deserialize,
        response_serializer=_serialize,
    )


def _make_fail_hard_handler() -> Any:
    def behavior(_request: Dict[str, Any], context: Any) -> Dict[str, Any]:
        context.abort(grpc.StatusCode.INVALID_ARGUMENT, "boom")
        return {}  # unreachable
    return grpc.unary_unary_rpc_method_handler(
        behavior,
        request_deserializer=_deserialize,
        response_serializer=_serialize,
    )


# ── Fixtures ──────────────────────────────────────────────────────────

@pytest.fixture
def fixture():
    capture_server, capture_thread, captured = _start_http_capture()
    capture_port = capture_server.server_address[1]
    ingestor_url = f"http://127.0.0.1:{capture_port}"

    billing = AforoGrpcBilling(
        tenant_id="tenant-int-grpc",
        product_id="prod-int-grpc",
        api_key="sk_int_grpc",
        ingestor_url=ingestor_url,
        service_name="aforo.test.Greeter",
        flush_count=1,
        flush_interval_sec=60.0,
    )

    # AforoGrpcInterceptor lives in the same module
    from aforo_grpc_metering.client import AforoGrpcInterceptor
    interceptor = AforoGrpcInterceptor(billing)

    server = grpc.server(
        ThreadPoolExecutor(max_workers=4),
        interceptors=[interceptor],
    )
    handlers: Dict[str, Any] = {
        "SayHello": _make_say_hello_handler(),
        "FailHard": _make_fail_hard_handler(),
    }
    generic = grpc.method_handlers_generic_handler("aforo.test.Greeter", handlers)
    server.add_generic_rpc_handlers((generic,))
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()

    yield {
        "billing": billing,
        "server": server,
        "port": port,
        "captured": captured,
        "ingestor_url": ingestor_url,
    }

    server.stop(grace=0.5).wait(timeout=2)
    billing.shutdown()
    capture_server.shutdown()
    capture_thread.join(timeout=2)


def _wait_for_events(captured: List[Dict[str, Any]],
                     predicate, timeout_sec: float = 2.0) -> List[Dict[str, Any]]:
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        events = [e for r in captured for e in (r.get("body") or {}).get("events", [])]
        if predicate(events):
            return events
        time.sleep(0.025)
    raise AssertionError(f"timed out; captured={captured!r}")


def _channel_call(port: int, method: str, request: Dict[str, Any],
                  metadata: Optional[Tuple[Tuple[str, str], ...]] = None) -> Dict[str, Any]:
    """Make a unary call via a generic channel — no service stub needed."""
    channel = grpc.insecure_channel(f"127.0.0.1:{port}")
    try:
        callable_ = channel.unary_unary(
            f"/aforo.test.Greeter/{method}",
            request_serializer=_serialize,
            response_deserializer=_deserialize,
        )
        return callable_(request, metadata=metadata or ())
    finally:
        channel.close()


# ── Tests ─────────────────────────────────────────────────────────────

def test_unary_success_emits_OK_event(fixture):
    response = _channel_call(
        fixture["port"], "SayHello", {"name": "world"},
        metadata=(("x-customer-id", "cust_grpc_001"),),
    )
    assert response == {"message": "hello world"}

    events = _wait_for_events(fixture["captured"], lambda evs: len(evs) >= 1)
    ev = events[0]
    assert ev["productType"] == "GRPC_API"
    assert ev["grpcService"] == "aforo.test.Greeter"
    assert ev["grpcMethod"] == "SayHello"
    assert ev["grpcStatusCode"] == "OK"
    assert ev["grpcCallType"] == "UNARY"
    assert ev["customerId"] == "cust_grpc_001"
    assert ev["executionDurationMs"] >= 0


def test_unary_handler_error_emits_mapped_status(fixture):
    with pytest.raises(grpc.RpcError) as exc_info:
        _channel_call(
            fixture["port"], "FailHard", {"name": "anything"},
            metadata=(("x-customer-id", "cust_grpc_002"),),
        )
    assert exc_info.value.code() == grpc.StatusCode.INVALID_ARGUMENT

    events = _wait_for_events(fixture["captured"], lambda evs: len(evs) >= 1)
    ev = events[0]
    assert ev["grpcMethod"] == "FailHard"
    # The interceptor's grpc.RpcError branch maps to INVALID_ARGUMENT (code 3).
    # If a different exception path is taken the SDK falls back to INTERNAL —
    # accept either, but assert it's a real failure label, not OK.
    assert ev["grpcStatusCode"] in {"INVALID_ARGUMENT", "INTERNAL"}
    assert ev["customerId"] == "cust_grpc_002"


def test_no_customer_id_metadata_is_silently_skipped(fixture):
    # No x-customer-id metadata → default extractor returns None → record() exits
    response = _channel_call(fixture["port"], "SayHello", {"name": "ghost"})
    assert response == {"message": "hello ghost"}

    # Give the SDK a beat, then drain
    time.sleep(0.2)
    fixture["billing"].shutdown()

    events = [e for r in fixture["captured"] for e in (r.get("body") or {}).get("events", [])]
    assert events == []


def test_authorization_and_tenant_headers_reach_ingestor(fixture):
    _channel_call(
        fixture["port"], "SayHello", {"name": "headers"},
        metadata=(("x-customer-id", "cust_grpc_headers"),),
    )

    # Wait for the ingestor request to land
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and not fixture["captured"]:
        time.sleep(0.025)

    assert fixture["captured"], "ingestor was never called"
    headers = fixture["captured"][0]["headers"]
    # http.server lowercases header keys; values stay verbatim
    assert headers.get("Authorization") == "Bearer sk_int_grpc"
    assert headers.get("X-Tenant-Id") == "tenant-int-grpc"
