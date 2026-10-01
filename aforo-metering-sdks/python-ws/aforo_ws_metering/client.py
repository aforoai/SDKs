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
from typing import Any, Callable, Dict, List, Optional, Tuple

try:
    import httpx  # type: ignore
    HAS_HTTPX = True
except ImportError:  # pragma: no cover
    HAS_HTTPX = False

__version__ = "1.2.2"
logger = logging.getLogger("aforo_ws_metering")

# POST /v1/ingest/batch takes 1..1000 events per request.
MAX_BATCH_EVENTS = 1000
MAX_CUSTOMER_ID_LEN = 64
MAX_IDEMPOTENCY_KEY_LEN = 255
MAX_WS_CLOSE_REASON_LEN = 32


# ── Request-derived labels ───────────────────────────────────────
# A label the SDK copies from the incoming request / message is cut to the
# ingestor's limit and the event is still sent: dropping it would let an API
# consumer avoid metering by sending an over-long name. Fields the SDK caller
# sets are never altered. The ingestor counts Java String.length(), i.e. UTF-16
# code units, so a character outside the BMP counts as 2.

_truncation_lock = threading.Lock()


def _utf16_length(text: str) -> int:
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in text)


def _truncate_utf16(text: str, limit: int) -> str:
    """Longest prefix of ``text`` within ``limit`` UTF-16 code units. Cuts
    between characters, so a surrogate pair is never split."""
    if len(text) * 2 <= limit:
        return text
    units = 0
    for index, ch in enumerate(text):
        units += 2 if ord(ch) > 0xFFFF else 1
        if units > limit:
            return text[:index]
    return text


def _truncate_label(field_name: str, value: Any, limit: int, warned: set) -> Any:
    """Cut a request-derived label to ``limit``; one WARNING per field name per
    ``warned`` set (one set per client). Non-strings pass through."""
    if not isinstance(value, str):
        return value
    cut = _truncate_utf16(value, limit)
    if len(cut) == len(value):
        return value
    with _truncation_lock:
        first = field_name not in warned
        warned.add(field_name)
    if first:
        logger.warning(
            "[aforo-ws] %s taken from the request was longer than the ingestor's limit and was "
            "truncated to %d characters; the event is still sent. Logged once per field.",
            field_name, limit,
        )
    return cut



def _unwrap_envelope(payload):
    """The ingestor wraps every 2xx JSON body in ``{success, data, meta}``.

    Returns the inner ``data`` object when present, else the payload unchanged
    (bare shape).
    """
    if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
        return payload["data"]
    return payload


def _cap_idempotency_key(key: str) -> str:
    """Keep keys within the ingestor's 255-char limit while staying unique."""
    if len(key) <= MAX_IDEMPOTENCY_KEY_LEN:
        return key
    suffix = uuid.uuid4().hex
    return key[:MAX_IDEMPOTENCY_KEY_LEN - len(suffix) - 1] + ":" + suffix


def _clip(value: Any) -> str:
    text = repr(value)
    return text if len(text) <= 80 else text[:77] + "..."


def _invalid_reason(partial: Dict[str, Any]) -> Optional[str]:
    """Why the ingestor would refuse this event, or None when it is sendable."""
    customer_id = partial.get("customerId")
    if not isinstance(customer_id, str) or not customer_id.strip():
        return f"customerId is required (got {_clip(customer_id)})"
    if len(customer_id) > MAX_CUSTOMER_ID_LEN:
        return f"customerId exceeds {MAX_CUSTOMER_ID_LEN} chars (got {_clip(customer_id)})"
    connection_id = partial.get("wsConnectionId")
    if connection_id is None or not str(connection_id).strip():
        return f"wsConnectionId is required (got {_clip(connection_id)})"
    return None


def _failed_events(raw: bytes, batch_len: int) -> Tuple[List[int], int]:
    """(indexes of refused events, refused count) from a batch response."""
    try:
        data = _unwrap_envelope(json.loads(raw.decode("utf-8")) if raw else None)
    except Exception:
        return [], 0
    if not isinstance(data, dict):
        return [], 0
    indexes: List[int] = []
    errors = data.get("errors") or []
    for err in errors if isinstance(errors, list) else []:
        idx = err.get("index") if isinstance(err, dict) else None
        if isinstance(idx, int) and not isinstance(idx, bool) and 0 <= idx < batch_len and idx not in indexes:
            indexes.append(idx)
    failed = data.get("failed")
    if not isinstance(failed, int) or isinstance(failed, bool) or failed < 0:
        failed = len(errors) if isinstance(errors, list) else 0
    return indexes, min(max(failed, len(indexes)), batch_len)


DEFAULT_PRODUCT_TYPE = "WEBSOCKET_API"
MAX_RETRY_AFTER_SEC = 60.0


def _normalize_product_type(product_type: Any, default: str) -> str:
    """Trim + uppercase. Unknown values pass through; the ingestor is the authority."""
    value = str(product_type).strip().upper() if product_type is not None else ""
    return value or default


def _post_json(url: str, body: Dict[str, Any], headers: Dict[str, str]) -> Tuple[int, Optional[str], bytes]:
    """POST JSON; returns (status, Retry-After header, response body). Raises on network errors."""
    if HAS_HTTPX:
        with httpx.Client(timeout=10.0) as c:
            r = c.post(url, json=body, headers=headers)
            return r.status_code, r.headers.get("Retry-After"), r.content
    import urllib.error
    import urllib.request
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers=headers, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            return resp.status, _header(resp, "Retry-After"), _read(resp)
    except urllib.error.HTTPError as e:
        return e.code, _header(e, "Retry-After"), _read(e)


def _header(resp: Any, name: str) -> Optional[str]:
    try:
        value = resp.headers.get(name)
        return value if isinstance(value, str) else None
    except Exception:
        return None


def _read(resp: Any) -> bytes:
    try:
        data = resp.read()
        return data if isinstance(data, (bytes, bytearray)) else b""
    except Exception:
        return b""


def _retry_after_seconds(value: str, default: float) -> float:
    try:
        return min(max(0.0, float(value)), MAX_RETRY_AFTER_SEC)
    except (TypeError, ValueError):
        return default


def _error_messages(raw: bytes) -> List[str]:
    """Pull errors[].message out of a batch response ({accepted, failed, errors:[{index, message}]})."""
    try:
        data = _unwrap_envelope(json.loads(raw.decode("utf-8")) if raw else None)
    except Exception:
        return []
    if not isinstance(data, dict):
        return []
    out: List[str] = []
    for err in data.get("errors") or []:
        if isinstance(err, dict) and err.get("message"):
            prefix = f"[{err['index']}] " if err.get("index") is not None else ""
            out.append(prefix + str(err["message"]))
    return out


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

WS_DIRECTIONS = ("CLIENT_TO_SERVER", "SERVER_TO_CLIENT")
WS_FRAME_TYPES = ("TEXT", "BINARY", "PING", "PONG", "CLOSE")


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
    executionDurationMs: int = 0
    wsCloseReason: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    executionStatus: Optional[str] = None
    """Normalized (trimmed, upper-cased) outcome; left off the wire when None."""

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        if d.get("executionStatus") is None:
            d.pop("executionStatus", None)
        return d


# Canonical execution statuses accepted by the usage-ingestor (mirrors
# contract/ingest-contract.json ``executionStatus.values``; maxLength 20).
EXECUTION_STATUSES = frozenset({
    "SUCCESS", "PARTIAL", "TIMEOUT", "ERROR", "VALIDATION_FAILED", "FAILED",
    "FAILURE", "CANCELLED", "PENDING", "BLOCKED", "HITL_REQUIRED",
})


def normalize_execution_status(value: Optional[str]) -> Optional[str]:
    """Trim + upper-case an execution status; blank or non-string -> None.

    A value outside the canonical set (see ``EXECUTION_STATUSES``) is logged
    and dropped (None): the ingestor rejects an unknown status with a 400 for
    that event, so its usage would be lost.
    """
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    normalized = trimmed.upper()
    if normalized not in EXECUTION_STATUSES:
        logger.warning(
            "Ignoring unknown executionStatus %r; expected one of %s",
            value[:40], ", ".join(sorted(EXECUTION_STATUSES)),
        )
        return None
    return normalized


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
        on_drop: Optional[Callable[[List[Dict[str, Any]], str], None]] = None,
        product_type: str = DEFAULT_PRODUCT_TYPE,
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
        # Top-level productType on every event; a "productType" key in push() overrides it.
        self.product_type = _normalize_product_type(product_type, DEFAULT_PRODUCT_TYPE)
        self.on_error = on_error or (lambda e: logger.error(f"[aforo-ws] {e}"))
        # Opt-in hook receiving permanently dropped events (with their
        # idempotency keys — dedup-safe replay). Reasons: 'retry_exhausted'
        # (network/5xx/408/429 after 3 attempts) | 'rejected' (terminal 4xx,
        # or events the ingestor refused inside a 2xx partial response) |
        # 'invalid' (failed a client-side check; never buffered or sent).
        # Exceptions raised by the hook are swallowed.
        self.on_drop = on_drop
        self._dropped = 0
        self._drop_lock = threading.Lock()
        self._truncation_warned: set = set()
        self._invalid_warned: set = set()

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

    def push(self, partial: Dict[str, Any], *, execution_status: Optional[str] = None) -> None:
        """Buffer one event built from ``partial`` (wire-named, camelCase keys).

        ``customerId`` (non-blank, at most 64 chars) and ``wsConnectionId`` are
        required. An event that fails those checks is not buffered or sent: it
        is counted in ``dropped_count``, logged at WARNING and handed to
        ``on_drop`` with reason ``"invalid"``. ``push`` does not raise for
        event content. ``productType`` optionally overrides the client default.

        ``execution_status`` (keyword-only) is the optional outcome used by
        OUTCOME_BASED pricing; ``partial["executionStatus"]`` is read when the
        keyword isn't given. Trimmed and upper-cased; blank counts as unset and
        the key is then left off the event. Accepted values: SUCCESS, PARTIAL,
        TIMEOUT, ERROR, VALIDATION_FAILED, FAILED, FAILURE, CANCELLED, PENDING,
        BLOCKED, HITL_REQUIRED -- any other value is logged and left off the event.
        """
        if not isinstance(partial, dict):
            partial = {}
        invalid = _invalid_reason(partial)
        if invalid is not None:
            partial = {**partial, "customerId": partial.get("customerId"),
                       "wsConnectionId": partial.get("wsConnectionId") or ""}
        now = datetime.now(timezone.utc)
        frame_type = str(partial.get("wsFrameType") or "TEXT").upper()
        if frame_type not in WS_FRAME_TYPES:
            frame_type = "TEXT"
        direction = str(partial.get("wsDirection") or "SERVER_TO_CLIENT").upper()
        if direction not in WS_DIRECTIONS:
            direction = "SERVER_TO_CLIENT"
        # "durationMs" is accepted for backward compatibility; the ingestor field is executionDurationMs.
        duration_ms = partial.get("executionDurationMs", partial.get("durationMs", 0))
        close_reason = partial.get("wsCloseReason")
        ev = WsUsageEvent(
            customerId=partial.get("customerId"),
            metricName="websocket_api.connection_closed" if frame_type == "CLOSE" else "websocket_api.message",
            quantity=1,
            occurredAt=now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            idempotencyKey=_cap_idempotency_key(f"ws:{self.tenant_id}:{partial['wsConnectionId']}:{frame_type}:{int(now.timestamp() * 1000)}:{uuid.uuid4().hex[:8]}"),
            productType=_normalize_product_type(partial.get("productType"), self.product_type),
            wsConnectionId=partial["wsConnectionId"],
            wsDirection=direction,
            wsFrameType=frame_type,
            messageCount=partial.get("messageCount", 1),
            dataBytes=partial.get("dataBytes", 0),
            executionDurationMs=duration_ms,
            wsCloseReason=_truncate_label(
                "wsCloseReason", str(close_reason), MAX_WS_CLOSE_REASON_LEN, self._truncation_warned,
            ) if close_reason else None,
            metadata={
                **(partial.get("metadata") or {}),
                "sdkVersion": __version__,
                "productId": self.product_id,
            },
            executionStatus=(
                normalize_execution_status(execution_status)
                or normalize_execution_status(partial.get("executionStatus"))
            ),
        )
        if invalid is not None:
            self._record_invalid(ev.to_dict(), invalid)
            return
        with self._buffer_lock:
            self._buffer.append(ev.to_dict())
            if len(self._buffer) >= self.flush_count:
                threading.Thread(target=self._flush, daemon=True).start()

    def _flush_loop(self) -> None:
        while not self._stop_event.wait(self.flush_interval_sec):
            self._flush()

    def _flush(self) -> None:
        with self._buffer_lock:
            if not self._buffer:
                return
            pending = self._buffer
            self._buffer = []

        # /v1/ingest/batch accepts at most MAX_BATCH_EVENTS per request.
        for i in range(0, len(pending), MAX_BATCH_EVENTS):
            self._send_batch(pending[i:i + MAX_BATCH_EVENTS])

    def _send_batch(self, batch: List[Dict[str, Any]]) -> None:
        # Events (and their idempotencyKeys) are built once in record/push,
        # so every retry below re-sends identical keys.
        body = {"events": batch}
        headers = {
            "Content-Type": "application/json",
            "X-API-Key": self.api_key,
            "X-Tenant-Id": self.tenant_id,
        }
        url = f"{self.ingestor_url}/v1/ingest/batch"

        for attempt in range(3):
            delay = float(2 ** attempt)
            try:
                status, retry_after, raw = _post_json(url, body, headers)
            except Exception as e:
                if attempt == 2:
                    self._record_drop(batch, "retry_exhausted")
                    self.on_error(e)
                    return
                time.sleep(delay)
                continue
            if 200 <= status < 300:
                # 202 can still carry per-event failures ({failed, errors:[{index, message}]}).
                self._report_partial_failures(batch, raw)
                return
            if 400 <= status < 500 and status not in (408, 429):
                # 400 invalid batch / 401 bad key / 422 unknown metric: retrying cannot help.
                messages = _error_messages(raw)
                self._record_drop(batch, "rejected")
                self.on_error(RuntimeError(
                    f"WebSocket metering flush rejected with HTTP {status}, not retrying "
                    f"(dropped {len(batch)} events)" + (": " + "; ".join(messages[:5]) if messages else "")
                ))
                return
            if status == 429 and retry_after:
                delay = _retry_after_seconds(retry_after, delay)
            if attempt < 2:
                time.sleep(delay)
        self._record_drop(batch, "retry_exhausted")
        self.on_error(RuntimeError(f"WebSocket metering flush failed after 3 attempts (dropped {len(batch)} events)"))

    def _report_partial_failures(self, batch: List[Dict[str, Any]], raw: bytes) -> None:
        """A 2xx batch response can refuse individual events. Those events are
        dropped with reason 'rejected'; the rest of the batch was accepted."""
        messages = _error_messages(raw)
        indexes, failed = _failed_events(raw, len(batch))
        if not messages and failed <= 0:
            return
        rejected = [batch[i] for i in indexes]
        unidentified = max(failed - len(rejected), 0)
        if rejected:
            self._record_drop(rejected, "rejected")
        if unidentified:
            # The response gave a count but no usable indexes: count the loss
            # without guessing which events it was (on_drop is not called).
            with self._drop_lock:
                self._dropped += unidentified
                total = self._dropped
            logger.warning(
                "[aforo-ws] Ingestor rejected %d event(s) it did not identify (%d total dropped).",
                unidentified, total,
            )
        self.on_error(RuntimeError(
            "WebSocket metering: ingestor rejected events: " + "; ".join(messages[:5])
            if messages else
            f"WebSocket metering: ingestor rejected {failed} event(s)"
        ))

    @property
    def dropped_count(self) -> int:
        """Total events permanently dropped (failed batches)."""
        with self._drop_lock:
            return self._dropped

    def _record_drop(self, events: List[Dict[str, Any]], reason: str) -> None:
        """Account for a permanently lost batch: bump the counter, WARN-log,
        and invoke the opt-in on_drop hook. The buffer is drained at flush
        start, so drops are bounded by flush cadence — no log throttle
        needed. The hook fires OUTSIDE all locks, so a hook that calls
        shutdown() cannot deadlock."""
        with self._drop_lock:
            self._dropped += len(events)
            dropped_total = self._dropped
        logger.warning(
            "[aforo-ws] Dropped %d event(s) — %s (%d total dropped).",
            len(events), reason, dropped_total,
        )
        if self.on_drop is not None:
            try:
                self.on_drop(events, reason)
            except Exception:
                # A hook bug must never break flushing.
                logger.debug("on_drop hook raised", exc_info=True)

    def _record_invalid(self, event: Dict[str, Any], message: str) -> None:
        """Account for an event that failed a client-side check. Never raises.
        The WARN is logged once per distinct message (bounded to 100 messages)
        so a tight loop cannot flood the log; the counter and hook always run."""
        with self._drop_lock:
            self._dropped += 1
            warn = message not in self._invalid_warned and len(self._invalid_warned) < 100
            if warn:
                self._invalid_warned.add(message)
        if warn:
            logger.warning("[aforo-ws] Dropped invalid event: %s", message)
        if self.on_drop is not None:
            try:
                self.on_drop([event], "invalid")
            except Exception:
                logger.debug("on_drop hook raised", exc_info=True)

    def shutdown(self) -> None:
        self._stop_event.set()
        # Deregister so repeated create/shutdown cycles don't accumulate
        # atexit handlers (which also pin the client from GC). Safe no-op
        # if called FROM the atexit handler itself.
        atexit.unregister(self._safe_shutdown)
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
    execution_status: Optional[str] = None,
    product_type: Optional[str] = None,
) -> Any:
    """
    Async context helper for the `websockets` library (and similar).

    Execution status is explicit only: pass ``execution_status``
    (keyword-only), or set ``tracker.execution_status`` inside the block, and
    the CONNECTION_CLOSED event carries it. Without one, no status is sent.
    Frame and CONNECTION_OPENED events carry no status.

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
            self.execution_status = execution_status
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
                            "productType": product_type,
                            "wsConnectionId": self.connection_id,
                            "wsDirection": "SERVER_TO_CLIENT",
                            "wsFrameType": "BINARY" if isinstance(data, (bytes, bytearray)) else "TEXT",
                            "messageCount": 1,
                            "dataBytes": _byte_len(data),
                            "executionDurationMs": int((time.monotonic() - self.start) * 1000),
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
                            "productType": product_type,
                            "wsConnectionId": self.connection_id,
                            "wsDirection": "CLIENT_TO_SERVER",
                            "wsFrameType": "BINARY" if isinstance(data, (bytes, bytearray)) else "TEXT",
                            "messageCount": 1,
                            "dataBytes": _byte_len(data),
                            "executionDurationMs": int((time.monotonic() - self.start) * 1000),
                            "metadata": metadata,
                        })
                    return data
                websocket.recv = _recv  # type: ignore[attr-defined]

        async def __aenter__(self):
            billing.push({
                "customerId": customer_id,
                "productType": product_type,
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
                "executionStatus": normalize_execution_status(self.execution_status),
                "customerId": customer_id,
                "productType": product_type,
                "wsConnectionId": self.connection_id,
                "wsDirection": "SERVER_TO_CLIENT",
                "wsFrameType": "CLOSE",
                "wsCloseReason": close_reason,
                "messageCount": self.sent + self.recv,
                "dataBytes": self.sent_bytes + self.recv_bytes,
                "executionDurationMs": int((time.monotonic() - self.start) * 1000),
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
    execution_status: Optional[str] = None,
    product_type: Optional[str] = None,
):
    """
    Async context helper for FastAPI / Starlette WebSocket routes.

    Execution status works as in ``track_websockets_connection``: the
    CONNECTION_CLOSED event carries ``execution_status`` or
    ``ctx.execution_status`` when set, and no status otherwise.

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
                    "productType": product_type,
                    "wsConnectionId": connection_id,
                    "wsDirection": _direction,
                    "wsFrameType": "BINARY" if _attr == "send_bytes" else "TEXT",
                    "messageCount": 1,
                    "dataBytes": _byte_len(data),
                    "executionDurationMs": int((time.monotonic() - start) * 1000),
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
                    "productType": product_type,
                    "wsConnectionId": connection_id,
                    "wsDirection": _direction,
                    "wsFrameType": _frame,
                    "messageCount": 1,
                    "dataBytes": _byte_len(data),
                    "executionDurationMs": int((time.monotonic() - start) * 1000),
                    "metadata": metadata,
                })
            return data

        setattr(websocket, attr, _wrapped)

    class _AsyncCtx:
        def __init__(self):
            self.execution_status = execution_status

        async def __aenter__(self):
            billing.push({
                "customerId": customer_id,
                "productType": product_type,
                "wsConnectionId": connection_id,
                "wsDirection": "SERVER_TO_CLIENT",
                "wsFrameType": "PING",
                "metadata": {"event": "CONNECTION_OPENED", **(metadata or {})},
            })
            return self

        async def __aexit__(self, exc_type, exc, tb):
            close_reason = "NORMAL_CLOSURE" if exc is None else "INTERNAL_ERROR"
            billing.push({
                "executionStatus": normalize_execution_status(self.execution_status),
                "customerId": customer_id,
                "productType": product_type,
                "wsConnectionId": connection_id,
                "wsDirection": "SERVER_TO_CLIENT",
                "wsFrameType": "CLOSE",
                "wsCloseReason": close_reason,
                "messageCount": counters["sent"] + counters["recv"],
                "dataBytes": counters["sent_bytes"] + counters["recv_bytes"],
                "executionDurationMs": int((time.monotonic() - start) * 1000),
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
