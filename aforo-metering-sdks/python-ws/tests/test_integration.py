"""
Real-server integration test for aforo-ws-metering.

Where test_client.py uses a mock websocket object, this file:
  - spins up a REAL `websockets` server on a random localhost port
  - connects a REAL `websockets` client
  - exercises the full open → frames → close lifecycle under
    track_websockets_connection(billing, ws, customer_id)
  - asserts CONNECTION_OPENED + CONNECTION_CLOSED events with
    aggregated counters reach a real HTTP capture server

Catches what mock-based tests can't:
  - real websockets library send/recv interplay with the wrapper
  - ASGI-agnostic path: `websockets` is a pure asyncio impl, not a
    framework
  - real TCP round-trips for the handshake (the "opened" event should
    fire reliably even under real network timing)

Self-contained — skipped when `websockets` isn't installed.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, List, Tuple

import pytest

from aforo_ws_metering import AforoWsBilling, track_websockets_connection

try:
    import websockets  # type: ignore
    HAS_WS = True
except ImportError:  # pragma: no cover
    HAS_WS = False


pytestmark = pytest.mark.skipif(not HAS_WS, reason="websockets library not installed")


# ── HTTP capture for the ingestor ─────────────────────────────────────

class _CaptureHandler(BaseHTTPRequestHandler):
    captured: List[Dict[str, Any]] = []

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else None
        except Exception:
            body = None
        type(self).captured.append(
            {"url": self.path, "body": body, "headers": dict(self.headers)}
        )
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_args: Any) -> None:
        pass


def _start_capture() -> Tuple[HTTPServer, threading.Thread, List[Dict[str, Any]]]:
    captured: List[Dict[str, Any]] = []

    class _Handler(_CaptureHandler):
        pass

    _Handler.captured = captured
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server, t, captured


def _wait_for_events(captured: List[Dict[str, Any]],
                     predicate, timeout_sec: float = 2.0) -> List[Dict[str, Any]]:
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        events = [e for r in captured for e in (r.get("body") or {}).get("events", [])]
        if predicate(events):
            return events
        time.sleep(0.025)
    raise AssertionError(f"timed out; captured={captured!r}")


# ── Tests ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_CONNECTION_OPENED_and_CLOSED_on_real_websocket_roundtrip():
    """Real websocket connects, client sends frames, server closes — assert
    both lifecycle events carry the right aggregated counters."""
    capture_server, capture_thread, captured = _start_capture()
    port = capture_server.server_address[1]
    try:
        billing = AforoWsBilling(
            tenant_id="tenant-int-ws",
            product_id="prod-int-ws",
            api_key="sk_int_ws",
            ingestor_url=f"http://127.0.0.1:{port}",
            flush_count=1,
            flush_interval_sec=60.0,
        )

        async def handler(ws):
            # Extract "customer_id" from the first header (simulating an
            # auth check). The `websockets` library passes headers through
            # the `request` attribute in recent versions; fall back to a
            # fixed id for test simplicity.
            customer_id = "cust_ws_lifecycle"
            async with await track_websockets_connection(billing, ws, customer_id):
                # Read 3 frames, don't echo — keeps the test deterministic
                for _ in range(3):
                    await ws.recv()

        server = await websockets.serve(handler, "127.0.0.1", 0)
        srv_port = server.sockets[0].getsockname()[1]

        try:
            async with websockets.connect(f"ws://127.0.0.1:{srv_port}/") as client:
                await client.send("hello-1")       # 7 bytes text
                await client.send("hello-22")      # 8 bytes text
                await client.send(b"\x01\x02\x03\x04\x05")  # 5 bytes binary

                # Let the server finish handling + aexit
                await asyncio.sleep(0.15)

            # Client exit triggers server close → aexit → CONNECTION_CLOSED push
            await asyncio.sleep(0.1)
        finally:
            server.close()
            await server.wait_closed()

        # Both events should be captured
        events = _wait_for_events(
            captured,
            lambda evs: (any(e.get("metadata", {}).get("event") == "CONNECTION_OPENED" for e in evs)
                         and any(e.get("metadata", {}).get("event") == "CONNECTION_CLOSED" for e in evs)),
        )
        opened = next(e for e in events if e.get("metadata", {}).get("event") == "CONNECTION_OPENED")
        closed = next(e for e in events if e.get("metadata", {}).get("event") == "CONNECTION_CLOSED")

        assert opened["productType"] == "WEBSOCKET_API"
        assert opened["customerId"] == "cust_ws_lifecycle"
        assert opened["wsFrameType"] == "PING"  # SDK uses PING as the lifecycle marker

        assert closed["productType"] == "WEBSOCKET_API"
        assert closed["customerId"] == "cust_ws_lifecycle"
        assert closed["wsFrameType"] == "CLOSE"
        # 3 frames received, 7+8+5 bytes total (receive side)
        assert closed["metadata"]["recvCount"] == 3
        assert closed["metadata"]["recvBytes"] == 7 + 8 + 5
        assert closed["durationMs"] >= 0

        billing.shutdown()
    finally:
        capture_server.shutdown()
        capture_thread.join(timeout=2)


@pytest.mark.asyncio
async def test_authorization_and_tenant_headers_reach_ingestor():
    capture_server, capture_thread, captured = _start_capture()
    port = capture_server.server_address[1]
    try:
        billing = AforoWsBilling(
            tenant_id="tenant-headers",
            product_id="prod-headers",
            api_key="sk_header_check",
            ingestor_url=f"http://127.0.0.1:{port}",
            flush_count=1,
            flush_interval_sec=60.0,
        )

        async def handler(ws):
            async with await track_websockets_connection(billing, ws, "cust_headers_001"):
                pass  # open + immediate close

        server = await websockets.serve(handler, "127.0.0.1", 0)
        srv_port = server.sockets[0].getsockname()[1]
        try:
            async with websockets.connect(f"ws://127.0.0.1:{srv_port}/"):
                pass
            await asyncio.sleep(0.1)
        finally:
            server.close()
            await server.wait_closed()

        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and not captured:
            time.sleep(0.025)

        assert captured, "ingestor was never called"
        headers = captured[0]["headers"]
        assert headers.get("Authorization") == "Bearer sk_header_check"
        assert headers.get("X-Tenant-Id") == "tenant-headers"

        billing.shutdown()
    finally:
        capture_server.shutdown()
        capture_thread.join(timeout=2)


@pytest.mark.asyncio
async def test_per_frame_events_when_enabled():
    """per_frame_events=True should emit one event per frame plus the
    lifecycle OPEN + CLOSE events."""
    capture_server, capture_thread, captured = _start_capture()
    port = capture_server.server_address[1]
    try:
        billing = AforoWsBilling(
            tenant_id="tenant-int-ws-pfe",
            product_id="prod-int-ws-pfe",
            api_key="sk_int_ws_pfe",
            ingestor_url=f"http://127.0.0.1:{port}",
            flush_count=1,
            flush_interval_sec=60.0,
            per_frame_events=True,
        )

        async def handler(ws):
            async with await track_websockets_connection(billing, ws, "cust_pfe"):
                for _ in range(2):
                    await ws.recv()

        server = await websockets.serve(handler, "127.0.0.1", 0)
        srv_port = server.sockets[0].getsockname()[1]
        try:
            async with websockets.connect(f"ws://127.0.0.1:{srv_port}/") as client:
                await client.send("a")  # 1 byte
                await client.send("b")  # 1 byte
                await asyncio.sleep(0.1)
            await asyncio.sleep(0.1)
        finally:
            server.close()
            await server.wait_closed()

        # Should see OPEN + 2 frame events + CLOSE = 4 total
        events = _wait_for_events(captured, lambda evs: len(evs) >= 4, timeout_sec=3.0)
        frame_events = [e for e in events if e.get("wsFrameType") in {"TEXT", "BINARY"}]
        assert len(frame_events) >= 2

        billing.shutdown()
    finally:
        capture_server.shutdown()
        capture_thread.join(timeout=2)
