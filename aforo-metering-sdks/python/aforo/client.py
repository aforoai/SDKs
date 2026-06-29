"""AforoClient — the main entry point for the Aforo metering SDK."""

from __future__ import annotations

import atexit
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Optional

from .buffer import RingBuffer
from .idempotency import generate_idempotency_key
from .transport import Transport
from .types import AforoOptions, FlushResult, ResolvedEvent, TrackEvent

logger = logging.getLogger("aforo.client")


class AforoClient:
    """Aforo usage metering client.

    Enqueues events into a thread-safe ring buffer and flushes them
    in batches to the Aforo ingestor via a background daemon thread.

    Example::

        client = AforoClient(api_key="your-key")
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
        self._flush_count = opts.flush_count
        self._flush_interval = opts.flush_interval
        self._shutdown_timeout = opts.shutdown_timeout
        self._closed = False
        self._flush_lock = threading.Lock()

        # Heartbeat state
        self._heartbeat_stop = threading.Event()
        self._heartbeat_thread: Optional[threading.Thread] = None
        self._active_session_id: Optional[str] = None
        self._session_started_at: Optional[float] = None
        self._session_product_type: str = "AI_AGENT"

        # Background flush timer (daemon so it doesn't block exit)
        self._timer: Optional[threading.Timer] = None
        self._schedule_flush()

        # Register atexit handler for graceful shutdown
        atexit.register(self._atexit_flush)

    # ─── Session lifecycle with heartbeat ──────────────────────────────

    def start_session(self, session_id: str, product_type: str = "AI_AGENT") -> None:
        """Start a session and begin emitting periodic heartbeats (every 30s)."""
        if self._closed:
            return
        self._active_session_id = session_id
        self._session_started_at = time.monotonic()
        self._session_product_type = product_type

        # Emit first heartbeat immediately
        self._emit_session_heartbeat()

        # Start heartbeat thread
        self._heartbeat_stop.clear()
        self._heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop, daemon=True
        )
        self._heartbeat_thread.start()

    def end_session(self) -> None:
        """End the current session: emit SESSION_END, stop heartbeat, flush."""
        # Stop heartbeat thread
        self._heartbeat_stop.set()
        if self._heartbeat_thread and self._heartbeat_thread.is_alive():
            self._heartbeat_thread.join(timeout=2.0)
        self._heartbeat_thread = None

        if self._active_session_id:
            resolved = ResolvedEvent(
                customer_id="system",
                metric_name="system.session.heartbeat",
                quantity=0,
                idempotency_key=f"hb:end:{self._active_session_id}:{int(time.time() * 1000)}",
                occurred_at=datetime.now(timezone.utc).isoformat(),
                metadata={
                    "sessionId": self._active_session_id,
                    "sessionBoundary": "SESSION_END",
                    "productType": self._session_product_type,
                    "heartbeatType": "SESSION_END",
                },
            )
            self._buffer.push(resolved)

        self._active_session_id = None
        self._session_started_at = None
        self.flush()

    def _heartbeat_loop(self) -> None:
        """Background thread emitting periodic heartbeats every 30s."""
        while not self._heartbeat_stop.wait(timeout=30.0):
            self._emit_session_heartbeat()

    def _emit_session_heartbeat(self) -> None:
        """Push a heartbeat event into the buffer."""
        if not self._active_session_id or self._closed:
            return

        process_memory_mb = None
        try:
            import resource
            process_memory_mb = round(
                resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
            )
        except Exception:
            pass

        metadata: dict = {
            "sessionId": self._active_session_id,
            "sessionBoundary": "HEARTBEAT",
            "productType": self._session_product_type,
            "heartbeatType": "PERIODIC",
            "uptimeMs": int(
                (time.monotonic() - (self._session_started_at or time.monotonic()))
                * 1000
            ),
            "sdkLanguage": "python",
        }
        if process_memory_mb is not None:
            metadata["processMemoryMb"] = process_memory_mb

        resolved = ResolvedEvent(
            customer_id="system",
            metric_name="system.session.heartbeat",
            quantity=0,
            idempotency_key=f"hb:{self._active_session_id}:{int(time.time() * 1000)}",
            occurred_at=datetime.now(timezone.utc).isoformat(),
            metadata=metadata,
        )
        self._buffer.push(resolved)

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
        event: Optional[TrackEvent] = None,
    ) -> None:
        """Enqueue a usage event for batched delivery.

        Can be called with keyword args or a ``TrackEvent`` dataclass.
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

        if not customer_id or not metric_name:
            raise ValueError("customer_id and metric_name are required")

        if occurred_at is None:
            occurred_at = datetime.now(timezone.utc).isoformat()

        if idempotency_key is None:
            idempotency_key = generate_idempotency_key(
                customer_id, metric_name, quantity, occurred_at
            )

        resolved = ResolvedEvent(
            customer_id=customer_id,
            metric_name=metric_name,
            quantity=quantity,
            idempotency_key=idempotency_key,
            occurred_at=occurred_at,
            metadata=metadata,
        )

        self._buffer.push(resolved)

        # Flush if buffer threshold reached
        if self._buffer.size >= self._flush_count:
            self._do_flush_async()

    def flush(self) -> FlushResult:
        """Force-flush all buffered events synchronously."""
        return self._do_flush()

    def shutdown(self) -> None:
        """Flush remaining events and stop the client."""
        if self._closed:
            return
        self._closed = True

        # Stop heartbeat thread
        self._heartbeat_stop.set()
        if self._heartbeat_thread and self._heartbeat_thread.is_alive():
            self._heartbeat_thread.join(timeout=2.0)
        self._heartbeat_thread = None

        if self._timer:
            self._timer.cancel()
            self._timer = None

        self._do_flush()

    @property
    def buffered_count(self) -> int:
        return self._buffer.size

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
