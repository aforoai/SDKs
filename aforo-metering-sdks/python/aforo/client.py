"""AforoClient — the main entry point for the Aforo metering SDK."""

from __future__ import annotations

import atexit
import logging
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Optional

from .buffer import RingBuffer
from .idempotency import generate_random_key
from .limits import describe_limit_violation
from .transport import Transport
from .types import (
    DEFAULT_PRODUCT_TYPE,
    MAX_BATCH_SIZE,
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

    Enqueues events into a thread-safe ring buffer and flushes them
    in batches to the Aforo ingestor via a background daemon thread.

    Example::

        client = AforoClient(api_key="your-key", product_type="API")
        client.track(customer_id="cust_1", metric_name="api_calls", quantity=1)
        # On shutdown (automatic via atexit):
        client.shutdown()
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

        self._buffer = RingBuffer(opts.max_queue_size)
        self._transport = Transport(
            base_url=opts.base_url,
            api_key=opts.api_key,
            timeout=opts.timeout,
            max_retries=opts.max_retries,
            retry_base_s=opts.retry_base_s,
        )
        # The ingestor rejects batches larger than 1000 events.
        self._flush_count = max(1, min(int(opts.flush_count), MAX_BATCH_SIZE))
        self._product_type = _normalize_product_type(opts.product_type) or DEFAULT_PRODUCT_TYPE
        self._flush_interval = opts.flush_interval
        self._shutdown_timeout = opts.shutdown_timeout
        self._closed = False
        # RLock (not Lock): _record_drop fires the customer's on_drop hook
        # while _do_flush holds this lock — a hook that synchronously calls
        # client.flush() would deadlock on a plain Lock. Reentry just drains
        # the (already-empty) buffer and returns.
        self._flush_lock = threading.RLock()

        # Drop accounting — events permanently lost (overflow eviction or failed batch)
        self._on_drop = opts.on_drop
        self._dropped = 0
        self._overflow_drops = 0
        self._invalid_drops = 0
        self._drop_lock = threading.Lock()

        # Session heartbeat state
        self._heartbeat_interval = opts.heartbeat_interval
        self._session_lock = threading.Lock()
        self._heartbeat_stop: Optional[threading.Event] = None
        self._heartbeat_thread: Optional[threading.Thread] = None
        self._session_id: Optional[str] = None
        self._session_customer_id = "system"
        self._session_product_type = "AI_AGENT"
        self._session_started_at = 0.0

        # Background flush timer (daemon so it doesn't block exit)
        self._timer: Optional[threading.Timer] = None
        self._schedule_flush()

        # Register atexit handler for graceful shutdown (unregistered in
        # shutdown() so repeated create/shutdown cycles don't accumulate
        # handlers for the life of the interpreter).
        atexit.register(self._atexit_flush)

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
        if self._closed or not session_id:
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
            pass
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

    def _send_heartbeat(self, session_id: str, boundary: str) -> None:
        """Best-effort: build and POST one heartbeat on its own; never raises."""
        try:
            self._transport.send_heartbeat(self._build_heartbeat(session_id, boundary))
        except Exception:
            logger.debug("Heartbeat for session %s failed", session_id, exc_info=True)

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
        """Enqueue a usage event for batched delivery.

        Can be called with keyword args or a ``TrackEvent`` dataclass.

        ``execution_status`` (keyword-only) is the optional outcome used by
        OUTCOME_BASED pricing -- see ``TrackEvent.execution_status``.

        ``product_type`` overrides the client's default ``product_type`` for this
        event only. ``extra_fields`` adds optional top-level ingest fields using
        their exact camelCase wire names (e.g. ``agentId``, ``sessionId``,
        ``endpointPath``).

        Never raises for event content. An event the ingestor would reject --
        blank ``customer_id`` / ``metric_name``, ``quantity`` <= 0, or a field
        over one of the ingestor's limits -- is not buffered and not sent: it is
        counted in ``dropped_count``, WARN-logged with the field and limit, and
        passed to the opt-in ``on_drop`` hook with reason ``"invalid"``.
        Raises ``RuntimeError`` only when the client is already shut down.
        """
        if self._closed:
            raise RuntimeError("AforoClient is shut down — cannot track new events")

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
        # through verbatim; otherwise each event gets its own random UUID. The
        # previous content-hash fallback silently COLLAPSED legitimately
        # distinct events recorded in the same instant -- the same bug Aforo's
        # ingest fixed server-side in April 2026 (H4 fix).
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

        # Checked before the event enters the buffer: an event that breaks one of
        # the ingestor's compiled-in constraints is rejected server-side and
        # never billed. It is dropped here (counter + WARN + on_drop "invalid")
        # rather than raised: track() sits on request hot paths, and an
        # exception there turns a metering problem into a failed request.
        problem = _describe_invalid(resolved)
        if problem:
            self._record_drop([resolved], "invalid", detail=problem)
            return

        self._enqueue(resolved)

        # Flush if buffer threshold reached
        if self._buffer.size >= self._flush_count:
            self._do_flush_async()

    def _enqueue(self, resolved: ResolvedEvent) -> None:
        """Buffer an event; surface the evicted-oldest event on overflow."""
        evicted = self._buffer.push_evict(resolved)
        if evicted is not None:
            self._record_drop([evicted], "overflow")

    def _record_drop(
        self,
        events: list[ResolvedEvent],
        reason: DropReason,
        *,
        count: Optional[int] = None,
        detail: Optional[str] = None,
    ) -> None:
        """Account for permanently lost events: bump the counter, WARN-log,
        and invoke the opt-in on_drop hook. Overflow and invalid-event logs are
        throttled (first, then every 1000th) so a tight loop can't storm the
        log; failed-batch drops log every time (bounded by flush cadence).

        ``count`` overrides ``len(events)`` when the ingestor reported rejected
        events without saying which ones: they are counted, but no event is
        handed to the hook as dropped that may in fact have been accepted.
        """
        n = len(events) if count is None else count
        if n <= 0:
            return
        with self._drop_lock:
            self._dropped += n
            dropped_total = self._dropped
            if reason == "overflow":
                self._overflow_drops += n
                should_log = self._overflow_drops == 1 or self._overflow_drops % 1000 == 0
            elif reason == "invalid":
                self._invalid_drops += n
                should_log = self._invalid_drops == 1 or self._invalid_drops % 1000 == 0
            else:
                should_log = True

        if reason == "overflow":
            if should_log:
                logger.warning(
                    "[aforo] Buffer overflow: oldest event dropped (%d total dropped). "
                    "Consider raising max_queue_size or checking ingest connectivity.",
                    dropped_total,
                )
        elif reason == "invalid":
            if should_log:
                logger.warning(
                    "[aforo] Invalid event not sent — %s (%d total dropped).",
                    detail or "rejected by client-side validation", dropped_total,
                )
        else:
            logger.warning(
                "[aforo] Dropped %d event(s) — %s (%d total dropped).",
                n, reason, dropped_total,
            )

        if self._on_drop is not None and events:
            try:
                self._on_drop(events, reason)
            except Exception:
                # A hook bug must never break tracking/flushing.
                logger.debug("on_drop hook raised", exc_info=True)

    def flush(self) -> FlushResult:
        """Force-flush all buffered events synchronously."""
        return self._do_flush()

    def shutdown(self) -> None:
        """Flush remaining events and stop the client."""
        if self._closed:
            return
        self._closed = True

        # Safe no-op if not registered (e.g. called FROM the atexit handler).
        atexit.unregister(self._atexit_flush)

        self._stop_heartbeat()

        if self._timer:
            self._timer.cancel()
            self._timer = None

        self._do_flush()

    @property
    def buffered_count(self) -> int:
        return self._buffer.size

    @property
    def dropped_count(self) -> int:
        """Total events permanently dropped (overflow, failed batches, events the
        ingestor rejected, and events track() refused as invalid)."""
        with self._drop_lock:
            return self._dropped

    @property
    def product_type(self) -> str:
        """Default ``productType`` stamped on events that don't override it."""
        return self._product_type

    @property
    def is_shutdown(self) -> bool:
        return self._closed

    def _do_flush(self) -> FlushResult:
        """Flush all buffered events (thread-safe)."""
        with self._flush_lock:
            total_sent = 0
            total_failed = 0

            while not self._buffer.is_empty:
                batch = self._buffer.drain_up_to(self._flush_count)
                if not batch:
                    break
                result = self._transport.send_sync(batch)
                total_sent += result.sent
                total_failed += result.failed

                if result.failed > 0:
                    # The batch was already drained from the buffer — without
                    # this it vanishes silently. Surface it (counter + WARN +
                    # opt-in hook).
                    reason = result.reason or "retry_exhausted"
                    if result.failed >= len(batch):
                        self._record_drop(batch, reason)
                    elif result.failed_indices:
                        # Partial response naming the rejected events.
                        self._record_drop([batch[i] for i in result.failed_indices], reason)
                    else:
                        # Partial response that does not say which events failed.
                        self._record_drop([], reason, count=result.failed)

            return FlushResult(sent=total_sent, failed=total_failed)

    def _do_flush_async(self) -> None:
        """Trigger flush in a background thread."""
        t = threading.Thread(target=self._do_flush, daemon=True)
        t.start()

    def _schedule_flush(self) -> None:
        """Schedule the next periodic flush."""
        if self._closed:
            return
        self._timer = threading.Timer(self._flush_interval, self._periodic_flush)
        self._timer.daemon = True
        self._timer.start()

    def _periodic_flush(self) -> None:
        """Called by the timer — flush then reschedule."""
        if self._closed:
            return
        try:
            self._do_flush()
        except Exception:
            logger.exception("Periodic flush failed")
        finally:
            self._schedule_flush()

    def _atexit_flush(self) -> None:
        """atexit handler — best-effort flush on interpreter shutdown."""
        try:
            if not self._closed:
                self.shutdown()
        except Exception:
            pass
