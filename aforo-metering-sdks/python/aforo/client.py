"""AforoClient — the main entry point for the Aforo metering SDK."""

from __future__ import annotations

import logging
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Optional

from ._transport import TransportCore
from ._version import __version__
from .idempotency import generate_random_key
from .limits import describe_limit_violation
from .types import (
    DEFAULT_PRODUCT_TYPE,
    AforoOptions,
    DropReason,
    FlushResult,
    ResolvedEvent,
    TrackEvent,
    normalize_execution_status,
)

logger = logging.getLogger("aforo.client")

HEARTBEAT_METRIC = "system.session.heartbeat"
"""Metric the ingestor intercepts (before billing) as a session heartbeat."""


def _utc_now_iso() -> str:
    """Current time as an ISO-8601 instant, e.g. ``2026-09-22T10:00:00.000Z``."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _describe_invalid(event: ResolvedEvent) -> Optional[str]:
    """Why the ingestor would reject this event, or ``None`` if it would not."""
    if event.customer_id is None or not str(event.customer_id).strip():
        return "customer_id is required (got blank)"
    if event.metric_name is None or not str(event.metric_name).strip():
        return "metric_name is required (got blank)"
    quantity = event.quantity
    try:
        positive = quantity is not None and not isinstance(quantity, bool) and quantity > 0
    except TypeError:
        positive = False
    if not positive:
        return f"quantity must be > 0 (got {str(quantity)[:80]})"
    return describe_limit_violation({
        **(event.extra_fields or {}),
        "customerId": event.customer_id,
        "metricName": event.metric_name,
        "quantity": quantity,
        "idempotencyKey": event.idempotency_key,
        "occurredAt": event.occurred_at,
        "productType": event.product_type,
    })


def _normalize_product_type(product_type: Optional[str]) -> Optional[str]:
    """Trim + upper-case; unknown values pass through; blank -> ``None``."""
    if product_type is None:
        return None
    value = str(product_type).strip().upper()
    return value or None


class AforoClient:
    """Aforo usage metering client.

    ``track()`` puts events on a bounded queue and returns. One background
    thread per client sends them in batches (every ``flush_interval`` seconds,
    or as soon as ``flush_count`` events are queued). During an ingest outage
    batches stay queued and are retried after a pause; nothing is dropped
    unless the queue overflows. At interpreter exit (``atexit``), or on
    ``shutdown()``, the queue is flushed for at most ``shutdown_timeout``
    seconds. Safe to create before ``fork()`` (gunicorn ``--preload``): each
    child gets its own queue and sender.

    Example::

        client = AforoClient(api_key="your-key", product_type="API")
        client.track(customer_id="cust_1", metric_name="api_calls", quantity=1)
        client.shutdown()  # also runs automatically at interpreter exit
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        options: Optional[AforoOptions] = None,
        **kwargs,
    ) -> None:
        if options:
            opts = options
        else:
            if not api_key:
                raise ValueError("api_key is required")
            opts = AforoOptions(api_key=api_key, **kwargs)

        self._product_type = _normalize_product_type(opts.product_type) or DEFAULT_PRODUCT_TYPE
        self._core = TransportCore(
            api_key=opts.api_key,
            base_url=opts.base_url,
            user_agent=f"aforo-python/{__version__}",
            name="aforo",
            logger=logger,
            flush_count=opts.flush_count,
            flush_interval=opts.flush_interval,
            max_queue_size=opts.max_queue_size,
            timeout=opts.timeout,
            max_retries=opts.max_retries,
            retry_base=opts.retry_base_s,
            shutdown_timeout=opts.shutdown_timeout,
            allow_insecure_http=opts.allow_insecure_http,
            compression=opts.compression,
            on_drop=opts.on_drop,
            on_error=opts.on_error,
            on_accepted=opts.on_accepted,
            http_transport=opts.http_transport,
            serialize=_serialize_event,
        )

        # Session heartbeat state
        self._heartbeat_interval = opts.heartbeat_interval
        self._session_lock = threading.Lock()
        self._heartbeat_stop: Optional[threading.Event] = None
        self._heartbeat_thread: Optional[threading.Thread] = None
        self._session_id: Optional[str] = None
        self._session_customer_id = "system"
        self._session_product_type = "AI_AGENT"
        self._session_started_at = 0.0

    def __repr__(self) -> str:
        return f"AforoClient(url={self._core.url!r}, product_type={self._product_type!r})"

    # ─── Session lifecycle with heartbeats ─────────────────────────────

    def start_session(
        self,
        session_id: str,
        product_type: str = "AI_AGENT",
        customer_id: Optional[str] = None,
    ) -> None:
        """Start a session and emit ``system.session.heartbeat`` events.

        The first heartbeat is sent immediately, then every
        ``heartbeat_interval`` seconds (default 30) from a daemon thread, until
        :meth:`end_session` or :meth:`shutdown`. Each heartbeat is POSTed in its
        own ``{"events": [hb]}`` request -- never mixed into a usage batch -- so
        the ingestor always intercepts it before billing. Heartbeats carry
        ``quantity`` 1 (never billed), top-level ``sessionId`` /
        ``sessionBoundary`` / ``productType``, and ``customer_id`` (default
        ``"system"``). They are best-effort: failures are logged and never affect
        usage delivery.
        """
        if self._core.closed or not session_id:
            return
        self._stop_heartbeat()
        stop = threading.Event()
        with self._session_lock:
            self._session_id = session_id
            self._session_product_type = _normalize_product_type(product_type) or "AI_AGENT"
            cid = str(customer_id).strip() if customer_id is not None else ""
            self._session_customer_id = cid or "system"
            self._session_started_at = time.monotonic()
            self._heartbeat_stop = stop
        thread = threading.Thread(
            target=self._heartbeat_loop, args=(session_id, stop),
            name="aforo-heartbeat", daemon=True,
        )
        self._heartbeat_thread = thread
        thread.start()

    def end_session(self) -> None:
        """End the session: stop heartbeats, flush usage, then send ``SESSION_END``."""
        session_id = self._session_id
        self._stop_heartbeat()
        self.flush()
        if session_id:
            self._send_heartbeat(session_id, "SESSION_END")
        with self._session_lock:
            if self._session_id == session_id:
                self._session_id = None

    def _stop_heartbeat(self) -> None:
        stop, thread = self._heartbeat_stop, self._heartbeat_thread
        self._heartbeat_stop = None
        self._heartbeat_thread = None
        if stop is not None:
            stop.set()
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2.0)

    def _heartbeat_loop(self, session_id: str, stop: threading.Event) -> None:
        """Daemon thread: one heartbeat now, then one per interval until stopped."""
        while not stop.is_set():
            self._send_heartbeat(session_id, "HEARTBEAT")
            if stop.wait(timeout=self._heartbeat_interval):
                return

    def _build_heartbeat(self, session_id: str, boundary: str) -> ResolvedEvent:
        heartbeat_type = "SESSION_END" if boundary == "SESSION_END" else "PERIODIC"
        metadata: dict = {
            "sessionId": session_id,
            "sessionBoundary": boundary,
            "productType": self._session_product_type,
            "heartbeatType": heartbeat_type,
            "uptimeMs": int((time.monotonic() - self._session_started_at) * 1000),
            "sdkLanguage": "python",
        }
        try:
            import resource

            metadata["processMemoryMb"] = round(
                resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
            )
        except Exception:
            logger.debug("process memory not available for the heartbeat", exc_info=True)
        return ResolvedEvent(
            customer_id=self._session_customer_id,
            metric_name=HEARTBEAT_METRIC,
            # Never billed, but bean-validated: quantity must be > 0.
            quantity=1,
            idempotency_key=f"hb:{boundary.lower()}:{session_id}:{int(time.time() * 1000)}:{uuid.uuid4().hex[:8]}",
            occurred_at=_utc_now_iso(),
            metadata=metadata,
            product_type=self._session_product_type,
            extra_fields={"sessionId": session_id, "sessionBoundary": boundary},
        )

    def _send_heartbeat(self, session_id: str, boundary: str) -> Optional[dict]:
        """Best-effort: build and POST one heartbeat on its own; never raises.

        Returns the response ``data`` object (for ``killedSessionIds``) or None.
        """
        try:
            hb = self._build_heartbeat(session_id, boundary)
            return self._core.post_single({"events": [hb.to_dict()]})
        except Exception:
            logger.debug("Heartbeat for session %s failed", session_id, exc_info=True)
            return None

    # ─── Event tracking ──────────────────────────────────────────────

    def track(
        self,
        customer_id: Optional[str] = None,
        metric_name: Optional[str] = None,
        quantity: float = 1,
        idempotency_key: Optional[str] = None,
        occurred_at: Optional[str] = None,
        metadata: Optional[dict] = None,
        *,
        execution_status: Optional[str] = None,
        product_type: Optional[str] = None,
        extra_fields: Optional[dict] = None,
        event: Optional[TrackEvent] = None,
    ) -> None:
        """Queue a usage event for batched delivery. Never sends and never
        starts a thread on the calling thread.

        Can be called with keyword args or a ``TrackEvent`` dataclass.

        ``execution_status`` (keyword-only) is the optional outcome used by
        OUTCOME_BASED pricing -- see ``TrackEvent.execution_status``.

        ``product_type`` overrides the client's default ``product_type`` for this
        event only. ``extra_fields`` adds optional top-level ingest fields using
        their exact camelCase wire names (e.g. ``agentId``, ``sessionId``,
        ``endpointPath``).

        Never raises. An event the ingestor would reject -- blank
        ``customer_id`` / ``metric_name``, ``quantity`` <= 0, or a field over one
        of the ingestor's limits (counted in UTF-16 units, as the ingestor does)
        -- is not queued: it is counted in ``dropped_count``, WARN-logged with the
        field and limit, and passed to ``on_drop`` with reason ``"invalid"``. An
        event tracked after ``shutdown()`` is dropped with reason ``"closed"``.
        """
        if event:
            customer_id = event.customer_id
            metric_name = event.metric_name
            quantity = event.quantity
            idempotency_key = event.idempotency_key
            occurred_at = event.occurred_at
            metadata = event.metadata
            execution_status = event.execution_status
            product_type = event.product_type
            extra_fields = event.extra_fields

        if occurred_at is None:
            occurred_at = _utc_now_iso()

        # Minted once, here, when the event is created -- never at flush/retry
        # time, so a retried batch (or an on_drop replay) carries the same key
        # and the ingestor deduplicates it. A caller-supplied key is passed
        # through verbatim; otherwise each event gets its own random UUID.
        if idempotency_key is None:
            idempotency_key = generate_random_key()

        resolved_product_type = _normalize_product_type(product_type) or self._product_type

        resolved = ResolvedEvent(
            customer_id=customer_id,
            metric_name=metric_name,
            quantity=quantity,
            idempotency_key=idempotency_key,
            occurred_at=occurred_at,
            metadata=metadata,
            execution_status=normalize_execution_status(execution_status),
            product_type=resolved_product_type,
            extra_fields=dict(extra_fields) if extra_fields else None,
        )

        # Checked before the event enters the queue: an event that breaks one of
        # the ingestor's compiled-in constraints is rejected server-side and
        # never billed. It is dropped here (counter + WARN + on_drop "invalid")
        # rather than raised: track() sits on request hot paths, and an
        # exception there turns a metering problem into a failed request.
        if not self._core.closed:
            problem = _describe_invalid(resolved)
            if problem:
                self._core.report_drop([resolved], "invalid", detail=problem)
                return

        self._core.enqueue(resolved)

    def report_invalid(self, detail: str, events: Optional[list] = None) -> None:
        """Count an event an integration could not build (for example no
        customer for a request) as an ``"invalid"`` drop. ``on_drop`` is called
        only when ``events`` is given."""
        self._core.report_drop(events or [], "invalid", count=None if events else 1, detail=detail)

    def flush(self, timeout: Optional[float] = None) -> FlushResult:
        """Send everything queued now and wait for it (at most ``timeout``
        seconds when given). The background thread does the sending; this call
        only waits. While the ingestor is unreachable this makes one attempt;
        if it fails the events stay queued and are retried after a pause."""
        outcome = self._core.flush(timeout)
        return FlushResult(sent=outcome.sent, failed=outcome.dropped)

    def shutdown(self, timeout: Optional[float] = None) -> None:
        """Stop accepting events, flush for at most ``shutdown_timeout`` seconds
        (or ``timeout``), report what is still queued as ``"shutdown"`` drops,
        and release the HTTP client. Safe to call twice."""
        self._stop_heartbeat()
        self._core.close(timeout)

    close = shutdown

    @property
    def buffered_count(self) -> int:
        return self._core.queue_size

    @property
    def dropped_count(self) -> int:
        """Total events permanently dropped (overflow, rejected by the ingestor,
        refused as invalid, left at the shutdown deadline, tracked after shutdown)."""
        return self._core.dropped_count

    @property
    def product_type(self) -> str:
        """Default ``productType`` stamped on events that don't override it."""
        return self._product_type

    @property
    def is_shutdown(self) -> bool:
        return self._core.closed


def _serialize_event(event: ResolvedEvent) -> dict:
    return event.to_dict()
