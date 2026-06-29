"""
Aforo WebSocket Billing Client — Python.

Integration surfaces:
  - track_websockets_connection(billing, ws, customer_id)   # `websockets` library
  - track_starlette_websocket(billing, ws, customer_id)     # FastAPI/Starlette
  - billing.record(...)                                      # low-level

Default billing strategy: one CONNECTION_OPENED event on entry + one
CONNECTION_CLOSED event on exit with aggregated counters/duration.
Set per_frame_events=True to also emit one event per frame.
"""

from __future__ import annotations

import asyncio
import atexit
import json
import logging
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

try:
    import httpx  # type: ignore
    HAS_HTTPX = True
except ImportError:  # pragma: no cover
    HAS_HTTPX = False

__version__ = "1.0.0"
logger = logging.getLogger("aforo_ws_metering")


WS_CLOSE_REASONS: Dict[int, str] = {
    1000: "NORMAL_CLOSURE",
    1001: "GOING_AWAY",
    1002: "PROTOCOL_ERROR",
    1003: "UNSUPPORTED_DATA",
    1005: "NORMAL_CLOSURE",   # no status
    1006: "ABNORMAL_CLOSURE",
    1007: "PROTOCOL_ERROR",
    1008: "POLICY_VIOLATION",
    1009: "MESSAGE_TOO_BIG",
    1011: "INTERNAL_ERROR",
    1012: "GOING_AWAY",
}


@dataclass
class WsUsageEvent:
    customerId: str
    metricName: str
    quantity: float
    occurredAt: str
    idempotencyKey: str
    productType: str
    wsConnectionId: str
    wsDirection: str
    wsFrameType: str
    messageCount: int = 0
    dataBytes: int = 0
    durationMs: int = 0
    wsCloseReason: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


class AforoWsBilling:
    def __init__(
        self,
        tenant_id: str,
        product_id: str,
        api_key: str,
        ingestor_url: str,
        flush_interval_sec: float = 3.0,
        flush_count: int = 100,
        per_frame_events: bool = False,
        on_error: Optional[Callable[[Exception], None]] = None,
    ):
        if not all([tenant_id, product_id, api_key, ingestor_url]):
            raise ValueError("tenant_id, product_id, api_key and ingestor_url are required")

        self.tenant_id = tenant_id
        self.product_id = product_id
        self.api_key = api_key
        self.ingestor_url = ingestor_url.rstrip("/")
        self.flush_interval_sec = flush_interval_sec
        self.flush_count = flush_count
        self.per_frame_events = per_frame_events
        self.on_error = on_error or (lambda e: logger.error(f"[aforo-ws] {e}"))

        self._buffer: List[Dict[str, Any]] = []
        self._buffer_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._flush_thread = threading.Thread(target=self._flush_loop, daemon=True, name="aforo-ws-flush")
        self._flush_thread.start()

        # Safety net for normal interpreter exit. The flush thread is a
        # daemon (so it won't block process exit), which historically meant
        # any in-flight events at exit were dropped unless the user
        # explicitly called shutdown(). atexit covers the common case
        # where the user forgets — does NOT cover SIGKILL or os._exit().
        atexit.register(self._safe_shutdown)

    def _safe_shutdown(self) -> None:
        """atexit-safe wrapper around shutdown()."""
        try:
            if not self._stop_event.is_set():
                self.shutdown()
        except Exception:
            pass

    def push(self, partial: Dict[str, Any]) -> None:
        now = datetime.now(timezone.utc)
        frame_type = partial.get("wsFrameType", "TEXT")
        ev = WsUsageEvent(
            customerId=partial["customerId"],
            metricName="websocket_api.connection_closed" if frame_type == "CLOSE" else "websocket_api.message",
            quantity=1,
            occurredAt=now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            idempotencyKey=f"ws:{self.tenant_id}:{partial['wsConnectionId']}:{frame_type}:{int(now.timestamp() * 1000)}:{uuid.uuid4().hex[:8]}",
            productType="WEBSOCKET_API",
            wsConnectionId=partial["wsConnectionId"],
            wsDirection=partial.get("wsDirection", "SERVER_TO_CLIENT"),
            wsFrameType=frame_type,
            messageCount=partial.get("messageCount", 1),
            dataBytes=partial.get("dataBytes", 0),
            durationMs=partial.get("durationMs", 0),
            wsCloseReason=partial.get("wsCloseReason"),
            metadata={
                **(partial.get("metadata") or {}),
                "sdkVersion": __version__,
                "productId": self.product_id,
            },
        )
        with self._buffer_lock:
            self._buffer.append(asdict(ev))
            if len(self._buffer) >= self.flush_count:
                threading.Thread(target=self._flush, daemon=True).start()

    def _flush_loop(self) -> None:
        while not self._stop_event.wait(self.flush_interval_sec):
            self._flush()

    def _flush(self) -> None:
        with self._buffer_lock:
            if not self._buffer:
                return
            batch = self._buffer
            self._buffer = []

        body = {"events": batch}
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "X-Tenant-Id": self.tenant_id,
        }
        url = f"{self.ingestor_url}/v1/ingest/events"

        for attempt in range(3):
            try:
                if HAS_HTTPX:
                    with httpx.Client(timeout=10.0) as c:
                        r = c.post(url, json=body, headers=headers)
                        if 200 <= r.status_code < 300:
                            return
                else:
                    import urllib.request
                    req = urllib.request.Request(
                        url, data=json.dumps(body).encode("utf-8"),
                        headers=headers, method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=10.0) as resp:
                        if 200 <= resp.status < 300:
                            return
            except Exception as e:
                if attempt == 2:
                    self.on_error(e)
                    return
            time.sleep(2 ** attempt)
        self.on_error(RuntimeError(f"WebSocket metering flush failed after 3 attempts (dropped {len(batch)} events)"))

    def shutdown(self) -> None:
        self._stop_event.set()
        self._flush()
        if self._flush_thread.is_alive():
            self._flush_thread.join(timeout=5.0)


# ── `websockets` library integration ─────────────────────────────

async def track_websockets_connection(
    billing: AforoWsBilling,
    websocket: Any,
    customer_id: str,
    *,
    metadata: Optional[Dict[str, Any]] = None,
) -> Any:
    """
    Async context helper for the `websockets` library (and similar).

    Usage:
        async def handler(websocket):
            customer_id = extract_customer_id(websocket)
            async with track_websockets_connection(billing, websocket, customer_id):
                async for message in websocket:
                    ...  # handle frame
    """
    class _Tracker:
        def __init__(self):
            self.connection_id = str(uuid.uuid4())
            self.start = time.monotonic()
            self.sent = 0
            self.recv = 0
            self.sent_bytes = 0
            self.recv_bytes = 0
            # Wrap send/recv if present
            self._orig_send = getattr(websocket, "send", None)
            self._orig_recv = getattr(websocket, "recv", None)

            if self._orig_send is not None:
                async def _send(data):
                    self.sent += 1
                    self.sent_bytes += _byte_len(data)
                    if billing.per_frame_events:
                        billing.push({
                            "customerId": customer_id,
                            "wsConnectionId": self.connection_id,
                            "wsDirection": "SERVER_TO_CLIENT",
                            "wsFrameType": "BINARY" if isinstance(data, (bytes, bytearray)) else "TEXT",
                            "messageCount": 1,
                            "dataBytes": _byte_len(data),
                            "durationMs": int((time.monotonic() - self.start) * 1000),
                            "metadata": metadata,
                        })
                    return await self._orig_send(data)
                websocket.send = _send  # type: ignore[attr-defined]

            if self._orig_recv is not None:
                async def _recv():
                    data = await self._orig_recv()
                    self.recv += 1
                    self.recv_bytes += _byte_len(data)
                    if billing.per_frame_events:
                        billing.push({
                            "customerId": customer_id,
                            "wsConnectionId": self.connection_id,
                            "wsDirection": "CLIENT_TO_SERVER",
                            "wsFrameType": "BINARY" if isinstance(data, (bytes, bytearray)) else "TEXT",
                            "messageCount": 1,
                            "dataBytes": _byte_len(data),
                            "durationMs": int((time.monotonic() - self.start) * 1000),
                            "metadata": metadata,
                        })
                    return data
                websocket.recv = _recv  # type: ignore[attr-defined]

        async def __aenter__(self):
            billing.push({
                "customerId": customer_id,
                "wsConnectionId": self.connection_id,
                "wsDirection": "SERVER_TO_CLIENT",
                "wsFrameType": "PING",
                "metadata": {"event": "CONNECTION_OPENED", **(metadata or {})},
            })
            return self

        async def __aexit__(self, exc_type, exc, tb):
            # Restore (best-effort)
            if self._orig_send is not None:
                websocket.send = self._orig_send  # type: ignore[attr-defined]
            if self._orig_recv is not None:
                websocket.recv = self._orig_recv  # type: ignore[attr-defined]

            close_reason = "NORMAL_CLOSURE"
            if exc is not None:
                close_reason = "INTERNAL_ERROR"

            billing.push({
                "customerId": customer_id,
                "wsConnectionId": self.connection_id,
                "wsDirection": "SERVER_TO_CLIENT",
                "wsFrameType": "CLOSE",
                "wsCloseReason": close_reason,
                "messageCount": self.sent + self.recv,
                "dataBytes": self.sent_bytes + self.recv_bytes,
                "durationMs": int((time.monotonic() - self.start) * 1000),
                "metadata": {
                    "event": "CONNECTION_CLOSED",
                    "sentCount": self.sent, "recvCount": self.recv,
                    "sentBytes": self.sent_bytes, "recvBytes": self.recv_bytes,
                    **(metadata or {}),
                },
            })

    return _Tracker()


# ── FastAPI / Starlette integration ──────────────────────────────

async def track_starlette_websocket(
    billing: AforoWsBilling,
    websocket: Any,
    customer_id: str,
    *,
    metadata: Optional[Dict[str, Any]] = None,
):
    """
    Async context helper for FastAPI / Starlette WebSocket routes.

    Usage:
        @app.websocket("/ws")
        async def ws_handler(ws: WebSocket):
            await ws.accept()
            customer_id = ws.headers.get("x-customer-id")
            async with await track_starlette_websocket(billing, ws, customer_id):
                while True:
                    data = await ws.receive_text()
                    await ws.send_text(f"echo: {data}")
    """
    # Starlette's WebSocket exposes receive_text/receive_bytes/send_text/send_bytes
    # rather than send/recv — adapt:
    connection_id = str(uuid.uuid4())
    start = time.monotonic()
    counters = {"sent": 0, "recv": 0, "sent_bytes": 0, "recv_bytes": 0}

    for attr, direction in [
        ("send_text", "SERVER_TO_CLIENT"),
        ("send_bytes", "SERVER_TO_CLIENT"),
    ]:
        orig = getattr(websocket, attr, None)
        if orig is None:
            continue

        async def _wrapped(data, _orig=orig, _attr=attr, _direction=direction):
            counters["sent"] += 1
            counters["sent_bytes"] += _byte_len(data)
            if billing.per_frame_events:
                billing.push({
                    "customerId": customer_id,
                    "wsConnectionId": connection_id,
                    "wsDirection": _direction,
                    "wsFrameType": "BINARY" if _attr == "send_bytes" else "TEXT",
                    "messageCount": 1,
                    "dataBytes": _byte_len(data),
                    "durationMs": int((time.monotonic() - start) * 1000),
                    "metadata": metadata,
                })
            return await _orig(data)

        setattr(websocket, attr, _wrapped)

    for attr, direction, frame in [
        ("receive_text", "CLIENT_TO_SERVER", "TEXT"),
        ("receive_bytes", "CLIENT_TO_SERVER", "BINARY"),
    ]:
        orig = getattr(websocket, attr, None)
        if orig is None:
            continue

        async def _wrapped(_orig=orig, _direction=direction, _frame=frame):
            data = await _orig()
            counters["recv"] += 1
            counters["recv_bytes"] += _byte_len(data)
            if billing.per_frame_events:
                billing.push({
                    "customerId": customer_id,
                    "wsConnectionId": connection_id,
                    "wsDirection": _direction,
                    "wsFrameType": _frame,
                    "messageCount": 1,
                    "dataBytes": _byte_len(data),
                    "durationMs": int((time.monotonic() - start) * 1000),
                    "metadata": metadata,
                })
            return data

        setattr(websocket, attr, _wrapped)

    class _AsyncCtx:
        async def __aenter__(self):
            billing.push({
                "customerId": customer_id,
                "wsConnectionId": connection_id,
                "wsDirection": "SERVER_TO_CLIENT",
                "wsFrameType": "PING",
                "metadata": {"event": "CONNECTION_OPENED", **(metadata or {})},
            })
            return self

        async def __aexit__(self, exc_type, exc, tb):
            close_reason = "NORMAL_CLOSURE" if exc is None else "INTERNAL_ERROR"
            billing.push({
                "customerId": customer_id,
                "wsConnectionId": connection_id,
                "wsDirection": "SERVER_TO_CLIENT",
                "wsFrameType": "CLOSE",
                "wsCloseReason": close_reason,
                "messageCount": counters["sent"] + counters["recv"],
                "dataBytes": counters["sent_bytes"] + counters["recv_bytes"],
                "durationMs": int((time.monotonic() - start) * 1000),
                "metadata": {
                    "event": "CONNECTION_CLOSED",
                    "sentCount": counters["sent"], "recvCount": counters["recv"],
                    "sentBytes": counters["sent_bytes"], "recvBytes": counters["recv_bytes"],
                    **(metadata or {}),
                },
            })

    return _AsyncCtx()


def _byte_len(data: Any) -> int:
    if data is None:
        return 0
    if isinstance(data, (bytes, bytearray)):
        return len(data)
    if isinstance(data, str):
        return len(data.encode("utf-8"))
    try:
        return len(data)  # best-effort
    except TypeError:
        return 0
