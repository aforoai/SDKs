"""
Aforo WebSocket Billing Client — Python.

Integration surfaces:
  - track_websockets_connection(billing, ws, customer_id)   # `websockets` library
  - track_starlette_websocket(billing, ws, customer_id)     # FastAPI/Starlette
  - billing.record(...)                                      # low-level

Default billing strategy: one CONNECTION_OPENED event on entry (frame type
OPEN, metric websocket_api.connection_opened) + one CONNECTION_CLOSED event on
exit with aggregated counters/duration. Connections still open at shutdown(),
or idle past connection_idle_timeout_sec, are closed by the SDK.
Set per_frame_events=True to also emit one event per frame.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from ._transport import (
    TransportCore,
    clean_customer_id,
    require_customer_source,
    truncate_utf16,
    utf16_length,
)
from ._transport import policy as _policy

__version__ = "2.0.0"
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


_utf16_length = utf16_length
_truncate_utf16 = truncate_utf16


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



def _cap_idempotency_key(key: str) -> str:
    """Keep keys within the ingestor's 255-char limit while staying unique."""
    if utf16_length(key) <= MAX_IDEMPOTENCY_KEY_LEN:
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
    if utf16_length(customer_id) > MAX_CUSTOMER_ID_LEN:
        return f"customerId exceeds {MAX_CUSTOMER_ID_LEN} chars (got {_clip(customer_id)})"
    connection_id = partial.get("wsConnectionId")
    if connection_id is None or not str(connection_id).strip():
        return f"wsConnectionId is required (got {_clip(connection_id)})"
    return None


DEFAULT_PRODUCT_TYPE = "WEBSOCKET_API"


def _normalize_product_type(product_type: Any, default: str) -> str:
    """Trim + uppercase. Unknown values pass through; the ingestor is the authority."""
    value = str(product_type).strip().upper() if product_type is not None else ""
    return value or default


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
WS_FRAME_TYPES = ("OPEN", "TEXT", "BINARY", "PING", "PONG", "CLOSE")

#: Metric per frame type; every other frame is a message.
_FRAME_METRICS = {
    "OPEN": "websocket_api.connection_opened",
    "CLOSE": "websocket_api.connection_closed",
}

#: How long a tracked connection may go without traffic before the SDK closes
#: it (a connection the app never closed would otherwise be held forever).
DEFAULT_CONNECTION_IDLE_TIMEOUT_SEC = 3600.0


class _OpenConnection:
    """A connection opened through a helper and not closed yet."""

    __slots__ = ("close", "last_activity")

    def __init__(self, close: Callable[[str, str], None], now: float) -> None:
        self.close = close  # close(close_reason, closed_by): emits CONNECTION_CLOSED
        self.last_activity = now


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
    """WebSocket metering client: one bounded queue and one sender thread.

    ``push()`` only queues. A background thread sends batches every
    ``flush_interval_sec`` seconds or when ``flush_count`` events are queued.
    During an ingest outage batches stay queued (same idempotency keys) and are
    retried after a pause; an event is lost only on queue overflow, a rejection
    by the ingestor, an invalid event, the shutdown deadline, or ``push()``
    after ``shutdown()`` -- each is counted in ``dropped_count`` and passed to
    ``on_drop``. ``shutdown()`` runs at interpreter exit too.
    """

    def __init__(
        self,
        tenant_id: str,
        product_id: str,
        api_key: str,
        ingestor_url: str,
        flush_interval_sec: float = 3.0,
        flush_count: int = _policy.DEFAULT_FLUSH_COUNT,
        per_frame_events: bool = False,
        on_error: Optional[Callable[[Exception], None]] = None,
        on_drop: Optional[Callable[[List[Dict[str, Any]], str], None]] = None,
        product_type: str = DEFAULT_PRODUCT_TYPE,
        *,
        max_queue_size: int = _policy.DEFAULT_QUEUE_CAPACITY,
        timeout_sec: float = _policy.REQUEST_TIMEOUT_S,
        shutdown_timeout_sec: float = _policy.SHUTDOWN_TIMEOUT_S,
        allow_insecure_http: bool = False,
        http_transport: Any = None,
        transport_options: Optional[Dict[str, Any]] = None,
        connection_idle_timeout_sec: Optional[float] = DEFAULT_CONNECTION_IDLE_TIMEOUT_SEC,
    ):
        """``ingestor_url`` must be ``https://`` (plain ``http://`` only for
        localhost, or with ``allow_insecure_http=True``). ``on_drop(events,
        reason)`` receives events that are lost for good; reasons are
        ``overflow``, ``rejected``, ``invalid``, ``shutdown`` and ``closed``.
        ``http_transport`` (an ``httpx.BaseTransport``) and
        ``transport_options`` (extra transport-core settings such as
        ``max_retries``) are for tests and unusual networks.

        ``connection_idle_timeout_sec`` (default 1 hour): a connection opened
        through a helper that sees no frames for this long is closed by the SDK
        (CONNECTION_CLOSED with ``ABNORMAL_CLOSURE``, ``closedBy:
        "sdk_idle_timeout"``) and forgotten, so connections the app never
        closes do not pile up. ``None`` or 0 means the default; a negative
        value raises ValueError."""
        if not all([tenant_id, product_id, api_key, ingestor_url]):
            raise ValueError("tenant_id, product_id, api_key and ingestor_url are required")
        if connection_idle_timeout_sec is None or connection_idle_timeout_sec == 0:
            connection_idle_timeout_sec = DEFAULT_CONNECTION_IDLE_TIMEOUT_SEC
        if connection_idle_timeout_sec < 0:
            raise ValueError("connection_idle_timeout_sec must be positive (or None / 0 for the 1-hour default)")
        self.connection_idle_timeout_sec = float(connection_idle_timeout_sec)
        self._connections: Dict[str, _OpenConnection] = {}
        # Reentrant: a hook fired while an OPEN is queued may call shutdown().
        self._connections_lock = threading.RLock()
        self._next_sweep = 0.0
        self._now: Callable[[], float] = time.monotonic
        self._shutting_down = False

        self.tenant_id = tenant_id
        self.product_id = product_id
        self.per_frame_events = per_frame_events
        # Top-level productType on every event; a "productType" key in push() overrides it.
        self.product_type = _normalize_product_type(product_type, DEFAULT_PRODUCT_TYPE)
        self.on_error = on_error or (lambda e: logger.debug("[aforo-ws] %s", e))
        self._truncation_warned: set = set()
        self._core = TransportCore(
            api_key=api_key,
            base_url=ingestor_url,
            user_agent=f"aforo-ws-metering-python/{__version__}",
            name="aforo-ws",
            logger=logger,
            flush_count=flush_count,
            flush_interval=flush_interval_sec,
            max_queue_size=max_queue_size,
            timeout=timeout_sec,
            shutdown_timeout=shutdown_timeout_sec,
            allow_insecure_http=allow_insecure_http,
            on_drop=on_drop,
            on_error=self._safe_on_error,
            extra_headers={"X-Tenant-Id": tenant_id},
            http_transport=http_transport,
            **(transport_options or {}),
        )
        self.ingestor_url = self._core.url[: -len(_policy.INGEST_PATH)]
        self.flush_count = self._core.flush_count
        self.flush_interval_sec = flush_interval_sec

    @property
    def on_drop(self) -> Optional[Callable[[List[Dict[str, Any]], str], None]]:
        return self._core._on_drop

    @on_drop.setter
    def on_drop(self, hook: Optional[Callable[[List[Dict[str, Any]], str], None]]) -> None:
        self._core._on_drop = hook

    def __repr__(self) -> str:
        return f"AforoWsBilling(tenant_id={self.tenant_id!r}, ingestor_url={self.ingestor_url!r})"

    def _safe_on_error(self, exc: Exception) -> None:
        try:
            self.on_error(exc)
        except Exception:
            logger.debug("[aforo-ws] on_error hook raised", exc_info=True)

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
        ev, invalid = self._event_from(partial, execution_status)
        if invalid is not None:
            self._core.report_drop([ev], "invalid", detail=invalid)
            return
        self._core.enqueue(ev)

    def _event_from(self, partial: Any, execution_status: Optional[str]):
        """The wire event for ``partial`` and why it is invalid (or None)."""
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
            metricName=_FRAME_METRICS.get(frame_type, "websocket_api.message"),
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
        return ev.to_dict(), invalid

    def flush(self, timeout: Optional[float] = None) -> int:
        """Ask the sender thread to send everything queued and wait for it.
        Returns the number of events still queued (non-zero while the
        ingestor is unreachable)."""
        return self._core.flush(timeout).pending

    _flush = flush

    @property
    def dropped_count(self) -> int:
        """Events lost for good: overflow, rejected, invalid, shutdown, closed."""
        return self._core.dropped_count

    @property
    def queued_count(self) -> int:
        return self._core.queue_size

    def report_invalid(self, detail: str) -> None:
        """Count an event an integration could not build (no customer) as ``invalid``."""
        self._core.report_drop([], "invalid", count=1, detail=detail)

    def shutdown(self, timeout: Optional[float] = None) -> None:
        """Send CONNECTION_CLOSED (``GOING_AWAY``, ``closedBy: "sdk_shutdown"``)
        for every connection still open, stop accepting events and flush for at
        most ``shutdown_timeout_sec`` (or ``timeout``) seconds; what is still
        queued then is reported to ``on_drop`` as ``"shutdown"``. Also runs at
        interpreter exit."""
        with self._connections_lock:
            self._shutting_down = True
            still_open = list(self._connections.items())
            self._connections.clear()
        for conn_id, conn in still_open:
            self._close_connection(conn_id, conn, "GOING_AWAY", "sdk_shutdown")
        self._core.close(timeout)

    # ── open connections (used by the helpers) ─────────────────────

    @property
    def open_connections(self) -> int:
        """Connections opened through a helper and not closed yet (by the app,
        the idle sweep or ``shutdown()``)."""
        with self._connections_lock:
            return len(self._connections)

    def _open(self, conn_id: str, open_event: Dict[str, Any], close: Callable[[str, str], None]) -> bool:
        """Queue CONNECTION_OPENED and track the connection, in one step, so a
        concurrent ``shutdown()`` either sees the connection (and closes it) or
        the OPEN is reported as ``"closed"`` and never sent. True when the
        connection is tracked."""
        self.sweep_idle_if_due()
        if _invalid_reason(open_event) is not None:
            self.push(open_event)  # counted as invalid; nothing to track
            return False
        with self._connections_lock:
            if not self._shutting_down and not self._core.closed:
                self._connections[conn_id] = _OpenConnection(close, self._now())
                self.push(open_event)
                return True
        ev, invalid = self._event_from(open_event, None)
        if invalid is not None:
            self._core.report_drop([ev], "invalid", detail=invalid)
        else:
            self._core.report_drop([ev], "closed", detail="connection opened after shutdown()")
        return False

    def _touch(self, conn_id: str) -> None:
        now = self._now()
        with self._connections_lock:
            conn = self._connections.get(conn_id)
            if conn is not None:
                conn.last_activity = now
        self.sweep_idle_if_due()

    def _unregister(self, conn_id: str) -> bool:
        """True when the app's own close should emit CONNECTION_CLOSED; False
        when the SDK already closed the connection (idle sweep or shutdown)."""
        with self._connections_lock:
            return self._connections.pop(conn_id, None) is not None

    def sweep_idle_if_due(self) -> int:
        """Run ``sweep_idle()`` at most every ``min(60 s, timeout / 4)`` (at
        least 1 s apart). The helpers call this as connections open and send,
        so no extra thread is needed."""
        now = self._now()
        with self._connections_lock:
            if now < self._next_sweep:
                return 0
            every = min(60.0, max(1.0, self.connection_idle_timeout_sec / 4))
            self._next_sweep = now + every
        return self.sweep_idle()

    def sweep_idle(self) -> int:
        """Close connections idle longer than ``connection_idle_timeout_sec``
        (CONNECTION_CLOSED with ``ABNORMAL_CLOSURE``, ``closedBy:
        "sdk_idle_timeout"``). Returns how many were closed."""
        cutoff = self._now() - self.connection_idle_timeout_sec
        with self._connections_lock:
            idle = [(cid, c) for cid, c in self._connections.items() if c.last_activity <= cutoff]
            for cid, _ in idle:
                del self._connections[cid]
        for cid, conn in idle:
            self._close_connection(cid, conn, "ABNORMAL_CLOSURE", "sdk_idle_timeout")
        return len(idle)

    @staticmethod
    def _close_connection(conn_id: str, conn: _OpenConnection, reason: str, closed_by: str) -> None:
        try:
            conn.close(reason, closed_by)
        except Exception:
            logger.warning("[aforo-ws] could not report connection %s as closed", conn_id[:40], exc_info=True)


# ── Customer identity ────────────────────────────────────────────

_UNSET: Any = object()

CustomerResolver = Callable[[Any], Optional[str]]


def _handshake_header(websocket: Any, name: str) -> Optional[str]:
    """A header from the WebSocket handshake (websockets >= 13, legacy
    websockets, Starlette)."""
    for holder in (getattr(getattr(websocket, "request", None), "headers", None),
                   getattr(websocket, "request_headers", None),
                   getattr(websocket, "headers", None)):
        if holder is None:
            continue
        try:
            value = holder.get(name)
        except Exception:
            logger.debug("[aforo-ws] could not read handshake headers", exc_info=True)
            continue
        if value:
            return value
    return None


def _customer_for(websocket: Any, customer_id: Any, customer_resolver: Optional[CustomerResolver],
                  trust_customer_header: bool, integration: str) -> Optional[str]:
    """The customer to bill for this connection.

    An explicit ``customer_id`` is the value your code resolved from identity
    it verified. Otherwise ``customer_resolver(websocket)`` is called; reading
    the ``x-customer-id`` handshake header -- which the client controls --
    needs ``trust_customer_header=True``. With none of the three this raises
    ValueError. A resolver returning nothing gives None: the connection's
    events are then dropped as ``invalid`` and counted; the connection itself
    is not affected.
    """
    if customer_id is not _UNSET:
        return clean_customer_id(customer_id)
    require_customer_source(customer_resolver, trust_customer_header, integration=integration,
                            untrusted_source="the x-customer-id header of the WebSocket handshake")
    if customer_resolver is not None:
        try:
            return clean_customer_id(customer_resolver(websocket))
        except Exception:
            logger.warning("[aforo-ws] customer_resolver raised; the connection is not metered", exc_info=True)
            return None
    return clean_customer_id(_handshake_header(websocket, "x-customer-id"))


# ── `websockets` library integration ─────────────────────────────

async def track_websockets_connection(
    billing: AforoWsBilling,
    websocket: Any,
    customer_id: Any = _UNSET,
    *,
    customer_resolver: Optional[CustomerResolver] = None,
    trust_customer_header: bool = False,
    metadata: Optional[Dict[str, Any]] = None,
    execution_status: Optional[str] = None,
    product_type: Optional[str] = None,
) -> Any:
    """
    Async context helper for the `websockets` library (and similar).

    The customer: pass ``customer_id`` (resolved by your own auth), or
    ``customer_resolver=callable(websocket) -> str | None``, or
    ``trust_customer_header=True`` to read the ``x-customer-id`` handshake
    header (the client controls it). With none of them this raises
    ``ValueError``.

    Execution status is explicit only: pass ``execution_status``
    (keyword-only), or set ``tracker.execution_status`` inside the block, and
    the CONNECTION_CLOSED event carries it. Without one, no status is sent.
    Frame and CONNECTION_OPENED events carry no status.

    Usage:
        async def handler(websocket):
            customer_id = customer_for_token(websocket.request.headers["Authorization"])
            async with await track_websockets_connection(billing, websocket, customer_id):
                async for message in websocket:
                    ...  # handle frame
    """
    customer_id = _customer_for(websocket, customer_id, customer_resolver, trust_customer_header,
                                "track_websockets_connection")

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
                    # Billed only once the send returns without raising: a
                    # frame the socket refuses is not counted.
                    billing._touch(self.connection_id)
                    result = await self._orig_send(data)
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
                    return result
                websocket.send = _send  # type: ignore[attr-defined]

            if self._orig_recv is not None:
                async def _recv():
                    data = await self._orig_recv()
                    self.recv += 1
                    self.recv_bytes += _byte_len(data)
                    billing._touch(self.connection_id)
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
            self._tracked = billing._open(self.connection_id, {
                "customerId": customer_id,
                "productType": product_type,
                "wsConnectionId": self.connection_id,
                "wsDirection": "SERVER_TO_CLIENT",
                "wsFrameType": "OPEN",
                "metadata": {"event": "CONNECTION_OPENED", **(metadata or {})},
            }, self._emit_closed)
            return self

        async def __aexit__(self, exc_type, exc, tb):
            # Restore (best-effort)
            if self._orig_send is not None:
                websocket.send = self._orig_send  # type: ignore[attr-defined]
            if self._orig_recv is not None:
                websocket.recv = self._orig_recv  # type: ignore[attr-defined]
            if not billing._unregister(self.connection_id) and getattr(self, "_tracked", False):
                return  # the idle sweep or shutdown() already reported it
            self._emit_closed("NORMAL_CLOSURE" if exc is None else "INTERNAL_ERROR", None)

        def _emit_closed(self, close_reason: str, closed_by: Optional[str]) -> None:
            meta: Dict[str, Any] = {
                "event": "CONNECTION_CLOSED",
                "sentCount": self.sent, "recvCount": self.recv,
                "sentBytes": self.sent_bytes, "recvBytes": self.recv_bytes,
                **(metadata or {}),
            }
            if closed_by:
                meta["closedBy"] = closed_by
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
                "metadata": meta,
            })

    return _Tracker()


# ── FastAPI / Starlette integration ──────────────────────────────

async def track_starlette_websocket(
    billing: AforoWsBilling,
    websocket: Any,
    customer_id: Any = _UNSET,
    *,
    customer_resolver: Optional[CustomerResolver] = None,
    trust_customer_header: bool = False,
    metadata: Optional[Dict[str, Any]] = None,
    execution_status: Optional[str] = None,
    product_type: Optional[str] = None,
):
    """
    Async context helper for FastAPI / Starlette WebSocket routes.

    The customer is found as in ``track_websockets_connection``. Execution
    status works the same way too: the CONNECTION_CLOSED event carries
    ``execution_status`` or ``ctx.execution_status`` when set, and no status
    otherwise.

    Usage:
        @app.websocket("/ws")
        async def ws_handler(ws: WebSocket, user: User = Depends(current_user)):
            await ws.accept()
            async with await track_starlette_websocket(billing, ws, user.customer_id):
                while True:
                    data = await ws.receive_text()
                    await ws.send_text(f"echo: {data}")
    """
    customer_id = _customer_for(websocket, customer_id, customer_resolver, trust_customer_header,
                                "track_starlette_websocket")
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
            # Billed only once the send returns without raising.
            billing._touch(connection_id)
            result = await _orig(data)
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
            return result

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
            billing._touch(connection_id)
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
            self._tracked = billing._open(connection_id, {
                "customerId": customer_id,
                "productType": product_type,
                "wsConnectionId": connection_id,
                "wsDirection": "SERVER_TO_CLIENT",
                "wsFrameType": "OPEN",
                "metadata": {"event": "CONNECTION_OPENED", **(metadata or {})},
            }, self._emit_closed)
            return self

        async def __aexit__(self, exc_type, exc, tb):
            if not billing._unregister(connection_id) and getattr(self, "_tracked", False):
                return  # the idle sweep or shutdown() already reported it
            self._emit_closed("NORMAL_CLOSURE" if exc is None else "INTERNAL_ERROR", None)

        def _emit_closed(self, close_reason: str, closed_by: Optional[str]) -> None:
            meta: Dict[str, Any] = {
                "event": "CONNECTION_CLOSED",
                "sentCount": counters["sent"], "recvCount": counters["recv"],
                "sentBytes": counters["sent_bytes"], "recvBytes": counters["recv_bytes"],
                **(metadata or {}),
            }
            if closed_by:
                meta["closedBy"] = closed_by
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
                "metadata": meta,
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
