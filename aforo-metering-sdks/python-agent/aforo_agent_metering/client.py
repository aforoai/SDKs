"""
Aforo AI Agent Metering SDK — client.

One :class:`AforoAgentClient` instance per process is enough (thread-safe
under asyncio; not thread-safe under threading — use one per event loop).
Emits Aforo AI_AGENT events to ``/v1/ingest/batch`` (default host
``https://api.aforo.ai``, authenticated with ``X-API-Key``)
using the shared ``IngestUsageEventRequest`` DTO shape. Per-capability
billing depends on ``metadata.capability_name`` (snake_case) — that's the
key the ``ProductTypeEventExtractor`` in usage-ingestor reads to fan out
per-capability line items for ``dimensionPricing``-driven rate plans.

Drop observability mirrors ``@aforoai/agent-metering`` (Node) and
``@aforoai/mcp-metering`` (Node + Python): failed / rejected batches are
counted, WARN-logged, and handed to an OPT-IN ``on_drop`` hook. Dropped
events keep their idempotency keys so re-submitting them after recovery
is dedup-safe on the ingestor side.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Literal, Optional, Tuple

from .buffer import EventBuffer
from .transport import (
    PostFn,
    PostResult,
    error_messages,
    parse_partial_failure,
    post_batch_with_retry,
)

__version__ = "0.3.2"

logger = logging.getLogger("aforo_agent_metering")

#: The 11 canonical execution statuses the usage ingestor accepts (the same
#: set as ``contract/ingest-contract.json`` and the core SDKs). OUTCOME_BASED
#: rate plans bill each invocation at the weight set for its status. Any
#: other value would make the ingestor reject the event, so
#: :func:`normalize_execution_status` drops it.
EXECUTION_STATUSES: Tuple[str, ...] = (
    "SUCCESS",
    "PARTIAL",
    "TIMEOUT",
    "ERROR",
    "VALIDATION_FAILED",
    "FAILED",
    "FAILURE",
    "CANCELLED",
    "PENDING",
    "BLOCKED",
    "HITL_REQUIRED",
)

#: Type-checker alias for :data:`EXECUTION_STATUSES`.
ExecutionStatus = Literal[
    "SUCCESS",
    "PARTIAL",
    "TIMEOUT",
    "ERROR",
    "VALIDATION_FAILED",
    "FAILED",
    "FAILURE",
    "CANCELLED",
    "PENDING",
    "BLOCKED",
    "HITL_REQUIRED",
]


def normalize_execution_status(value: Optional[str]) -> Optional[str]:
    """Strip + upper-case, like the core SDK. Blank, non-string, or not one
    of :data:`EXECUTION_STATUSES` → ``None`` (the ``executionStatus`` key is
    then left off the event). An unknown value is logged: sent as-is, the
    ingestor would reject every event in the same batch."""
    if not isinstance(value, str):
        return None
    status = value.strip().upper()
    if not status:
        return None
    if status not in EXECUTION_STATUSES:
        logger.warning("[aforo-agent] %r is not an execution status; leaving it off the event", value)
        return None
    return status


#: Ingestor path this SDK POSTs to. Kept as a module-level constant so the
#: ingest-contract test can assert the observed URL against the shared
#: ``contract/ingest-contract.json`` fixture without going through the
#: SDK's own arithmetic.
INGEST_PATH: str = "/v1/ingest/batch"

#: Aforo's public API gateway, which fronts the usage ingestor.
DEFAULT_INGESTOR_URL = "https://api.aforo.ai"

#: The ingestor's per-request cap on POST /v1/ingest/batch (IngestBatchRequest).
MAX_BATCH_EVENTS = 1000

DEFAULT_PRODUCT_TYPE = "AI_AGENT"

#: Ingestor field limits (IngestUsageEventRequest ``@Size``). An event over one
#: of them is rejected server-side, so the SDK drops it as ``"invalid"`` before
#: buffering. Nothing passed to ``record_*`` is truncated — a shortened id bills
#: the wrong thing. The one exception is ``wrap_capability_handler``: a
#: capability name it reads from the wrapped call's ``capability_name`` kwarg is
#: cut to 64 and the event is still sent.
MAX_LENGTHS: Dict[str, int] = {
    "customerId": 64,
    "metricName": 255,
    "idempotencyKey": 255,
    "productType": 20,
    "agentId": 36,
    "sessionId": 64,
    "capabilityName": 64,
}

DropReason = str  # 'retry_exhausted' | 'rejected' | 'invalid'


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
    ``warned`` set. Non-strings pass through."""
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
            "[aforo-agent] %s taken from the request was longer than the ingestor's limit and was "
            "truncated to %d characters; the event is still sent. Logged once per field.",
            field_name, limit,
        )
    return cut


#: Field names already warned about by :func:`truncate_capability_name` (one
#: WARNING per field name per process).
_truncation_warned: set = set()


def truncate_capability_name(value: Any) -> Any:
    """Cut a capability name taken from a handler call's arguments to the
    ingestor's 64-character limit. Used by ``wrap_capability_handler`` only."""
    return _truncate_label("capabilityName", value, MAX_LENGTHS["capabilityName"], _truncation_warned)


def _normalize_product_type(product_type: Optional[str], default: str) -> str:
    """Trim + upper-case; unknown values pass through; blank → ``default``."""
    value = str(product_type).strip().upper() if product_type is not None else ""
    return value or default


def _blank(value: Any) -> bool:
    return value is None or not str(value).strip()


def _too_long(field_name: str, value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    limit = MAX_LENGTHS[field_name]
    if len(text) <= limit:
        return None
    return (
        f"{field_name} is {len(text)} characters, exceeding the ingestor's "
        f'{limit}-character limit (value starts "{text[:80]}")'
    )


def _utc_now_iso() -> str:
    """ISO-8601 instant with a ``Z`` suffix, e.g. ``2026-09-22T10:00:00.000Z``."""
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


class AforoAgentClient:
    """Aforo AI_AGENT metering client.

    Buffers events and flushes them in batches of up to ``flush_count`` or
    every ``flush_interval_sec`` seconds (whichever is first). Call
    :meth:`start` to begin the periodic flush; call :meth:`shutdown`
    before your process exits so the tail of the buffer lands in Aforo.

    Args:
        tenant_id: Aforo tenant id. Sent as the ``X-Tenant-Id`` header.
        product_id: Aforo AI_AGENT product id.
        api_key: Aforo API key. Sent as the ``X-API-Key`` header (no
            ``Authorization`` header is sent).
        ingestor_url: Base URL events are POSTed to. Defaults to
            ``https://api.aforo.ai``. Override for staging / local dev.
        default_customer_id: Optional customer id used when a per-event
            ``customer_id`` isn't supplied. If neither is set, the SDK
            falls back to ``agent_id`` (matches the python-mcp shape and
            keeps the required ``customerId`` field non-blank).
        product_type: Top-level ``productType`` on every event. Default
            ``AI_AGENT``. Trimmed and upper-cased; override per event with
            the ``product_type`` argument of the ``record_*`` methods.
        flush_count: Max events buffered before a forced flush. Default
            50 — matches ``@aforoai/agent-metering``. Clamped to 1000,
            the ingestor's per-request batch limit.
        flush_interval_sec: Max seconds an event can sit before a
            periodic flush. Default 5s — matches Node SDK reliability.
        max_retries: Retries per batch on 5xx / network error. Default 3.
        on_error: Callback for otherwise-unhandled errors (mostly
            transient POST failures during retry). Defaults to a WARN
            log. Exceptions from this hook are swallowed.
        on_drop: OPT-IN hook receiving events the SDK is about to lose
            permanently. Reasons: ``"retry_exhausted"`` (5xx, 408, 429 or
            network after 3 attempts), ``"rejected"`` (non-retryable 4xx,
            or events the ingestor rejected individually in a 2xx
            response), ``"invalid"`` (an event the ``record_*`` call
            refused before buffering). Events retain their
            idempotency keys so re-submitting them after recovery is
            dedup-safe. Exceptions from this hook are swallowed.
        post_fn: Pluggable HTTP transport for tests. Defaults to the
            module's aiohttp/httpx/urllib chain.
    """

    def __init__(
        self,
        tenant_id: str,
        product_id: str,
        api_key: str,
        ingestor_url: str = DEFAULT_INGESTOR_URL,
        *,
        default_customer_id: Optional[str] = None,
        product_type: str = DEFAULT_PRODUCT_TYPE,
        flush_count: int = 50,
        flush_interval_sec: float = 5.0,
        max_retries: int = 3,
        on_error: Optional[Callable[[Exception], None]] = None,
        on_drop: Optional[Callable[[List[Dict[str, Any]], DropReason], None]] = None,
        post_fn: Optional[PostFn] = None,
    ) -> None:
        if not tenant_id:
            raise ValueError("tenant_id is required")
        if not product_id:
            raise ValueError("product_id is required")
        if not api_key:
            raise ValueError("api_key is required")
        if not ingestor_url:
            raise ValueError("ingestor_url is required")
        if flush_count <= 0:
            raise ValueError("flush_count must be > 0")

        self.tenant_id = tenant_id
        self.product_id = product_id
        self.api_key = api_key
        self.ingestor_url = ingestor_url.rstrip("/")
        self.default_customer_id = default_customer_id
        self.product_type = _normalize_product_type(product_type, DEFAULT_PRODUCT_TYPE)
        # The ingestor rejects batches larger than 1000 events.
        self.flush_count = min(int(flush_count), MAX_BATCH_EVENTS)
        self.flush_interval_sec = flush_interval_sec
        self.max_retries = max_retries
        self.on_error = on_error or (
            lambda e: logger.warning("[aforo-agent] %s", e)
        )
        self.on_drop = on_drop
        self._post_fn = post_fn

        self._buffer = EventBuffer(max_events=self.flush_count)
        self._dropped = 0
        self._invalid_drops = 0
        self._flush_task: Optional[asyncio.Task[Any]] = None
        self._running = False

    # ────────────────────────────── public API ──────────────────────

    def record_capability(
        self,
        capability_name: str,
        agent_id: str,
        *,
        customer_id: Optional[str] = None,
        session_id: Optional[str] = None,
        input_tokens: int = 0,
        output_tokens: int = 0,
        execution_status: Optional[str] = "SUCCESS",
        execution_duration_ms: int = 0,
        metadata: Optional[Dict[str, Any]] = None,
        product_type: Optional[str] = None,
    ) -> None:
        """Record one AI_AGENT capability invocation.

        ``capability_name`` becomes ``metadata.capability_name`` on the
        wire — that's the key ``ProductTypeEventExtractor`` reads to
        derive the per-capability billing dimension.

        Never raises for event content. An event the ingestor would reject
        (blank ``capability_name`` / ``agent_id``, ``agent_id`` > 36 chars,
        ``session_id`` / ``customer_id`` / ``capability_name`` > 64 chars)
        is not buffered or sent: it is counted in :attr:`dropped_count`,
        WARN-logged and passed to ``on_drop`` with reason ``"invalid"``.
        """
        resolved_customer = customer_id or self.default_customer_id or agent_id
        event = self._build_event(
            customer_id=resolved_customer,
            metric_name="ai_agent.capability_invocations",
            agent_id=agent_id,
            session_id=session_id,
            capability_name=capability_name,
            execution_status=execution_status,
            execution_duration_ms=execution_duration_ms,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            extra_metadata=metadata,
            product_type=product_type,
        )
        problem = None
        if _blank(capability_name):
            problem = "capability_name is required (got blank)"
        self._submit(event, problem or self._invalid_reason(event, capability_name))

    def record_step(
        self,
        agent_id: str,
        session_id: str,
        step_type: str,
        *,
        customer_id: Optional[str] = None,
        capability_name: Optional[str] = None,
        input_tokens: int = 0,
        output_tokens: int = 0,
        duration_ms: int = 0,
        execution_status: Optional[str] = "SUCCESS",
        metadata: Optional[Dict[str, Any]] = None,
        product_type: Optional[str] = None,
    ) -> None:
        """Record one step in an agent's reasoning loop.

        ``step_type`` is free-form (``THOUGHT`` / ``OBSERVATION`` /
        ``TOOL_CALL`` / ``FINAL_ANSWER`` are the common values). Steps
        with a ``capability_name`` fan out into per-capability billing
        the same way :meth:`record_capability` does.

        Never raises for event content: a blank ``agent_id`` /
        ``session_id`` / ``step_type`` or an over-limit field is dropped
        with reason ``"invalid"``, as in :meth:`record_capability`.
        """
        resolved_customer = customer_id or self.default_customer_id or agent_id
        combined_meta: Dict[str, Any] = {"stepType": step_type}
        if metadata:
            combined_meta.update(metadata)
        event = self._build_event(
            customer_id=resolved_customer,
            metric_name="ai_agent.steps",
            agent_id=agent_id,
            session_id=session_id,
            capability_name=capability_name,
            execution_status=execution_status,
            execution_duration_ms=duration_ms,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            extra_metadata=combined_meta,
            product_type=product_type,
        )
        problem = None
        if _blank(session_id):
            problem = "session_id is required for a step (got blank)"
        elif _blank(step_type):
            problem = "step_type is required (got blank)"
        self._submit(event, problem or self._invalid_reason(event, capability_name))

    async def flush(self) -> None:
        """Force an immediate flush of the buffer to Aforo.

        A buffer holding more than 1000 events (possible when events were
        recorded with no running loop) is sent as several requests of at
        most 1000 — the ingestor rejects larger batches.
        """
        events = self._buffer.drain()
        for i in range(0, len(events), MAX_BATCH_EVENTS):
            await self._send_batch(events[i : i + MAX_BATCH_EVENTS])

    async def _send_batch(self, events: List[Dict[str, Any]]) -> None:
        if not events:
            return

        url = f"{self.ingestor_url}{INGEST_PATH}"
        headers = {
            "Content-Type": "application/json",
            "X-API-Key": self.api_key,
            "X-Tenant-Id": self.tenant_id,
        }
        # JSON-encode INSIDE a try/except: an event whose metadata carries
        # a non-serializable object (Decimal, uncoverted datetime, custom
        # class) would otherwise raise TypeError HERE — after drain, before
        # send — and vanish silently (bug fixed 2026-07-11: previously the
        # entire drained batch was lost with no drop hook / no counter
        # increment, so no observability signal to catch it). Classify as
        # 'rejected' (client-side payload error — retry can't fix it).
        try:
            body = json.dumps({"events": events})
        except (TypeError, ValueError) as e:
            self._safe_on_error(
                Exception(f"failed to JSON-encode {len(events)} event(s): {e}")
            )
            self._record_drop(events, "rejected")
            return

        try:
            result: PostResult = await post_batch_with_retry(
                url,
                headers,
                body,
                post_fn=self._post_fn,
                max_retries=self.max_retries,
            )
        except Exception as e:  # noqa: BLE001 — never let a transport bug break the loop
            # The retry loop already catches per-attempt exceptions, so
            # reaching here means something outside the loop failed
            # (unlikely). Treat as retry_exhausted so we don't silently
            # discard the batch.
            self._safe_on_error(e)
            self._record_drop(events, "retry_exhausted")
            return

        if result.reason == "success":
            logger.debug("[aforo-agent] flushed %d event(s)", len(events))
            # A 2xx can still reject individual events. They are lost (a
            # retry would be rejected again): count them, and name them to
            # on_drop only when the response identifies them by index.
            partial = parse_partial_failure(result.response_body, len(events))
            if partial is not None:
                failed, indices = partial
                for msg in error_messages(result.response_body)[:10]:
                    logger.warning("[aforo-agent] ingestor rejected event %s", msg)
                if failed >= len(events):
                    self._record_drop(events, "rejected")
                elif indices:
                    self._record_drop([events[i] for i in indices], "rejected")
                else:
                    self._record_drop([], "rejected", count=failed)
            return

        # rejected (non-retryable 4xx) → on_error + on_drop with 'rejected'.
        # retry_exhausted (5xx / 408 / 429 / network) → on_drop with 'retry_exhausted'.
        if result.reason == "rejected":
            details = "; ".join(error_messages(result.response_body)[:5])
            self._safe_on_error(
                Exception(
                    f"Aforo returned {result.status_code} — not retrying: "
                    f"{details or result.response_body[:200]}"
                )
            )
        self._record_drop(events, result.reason)

    async def start(self) -> None:
        """Start the periodic-flush background task.

        Idempotent — calling this more than once is a no-op.
        """
        if self._running:
            return
        self._running = True
        self._flush_task = asyncio.create_task(self._periodic_flush())

    async def shutdown(self) -> None:
        """Stop the periodic-flush task and force a final flush.

        Call this before your process exits so buffered events land in
        Aforo instead of being lost on shutdown.
        """
        self._running = False
        if self._flush_task is not None:
            self._flush_task.cancel()
            try:
                await self._flush_task
            except (asyncio.CancelledError, Exception):
                pass
            self._flush_task = None
        await self.flush()

    @property
    def dropped_count(self) -> int:
        """Total events permanently dropped since the client was created."""
        return self._dropped

    def __len__(self) -> int:
        return len(self._buffer)

    # ─────────────────────────── internals ──────────────────────────

    def _build_event(
        self,
        *,
        customer_id: str,
        metric_name: str,
        agent_id: str,
        session_id: Optional[str],
        capability_name: Optional[str],
        execution_status: Optional[str],
        execution_duration_ms: int,
        input_tokens: int,
        output_tokens: int,
        extra_metadata: Optional[Dict[str, Any]],
        product_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        # Metadata carries both snake_case and camelCase capability_name.
        # The usage-ingestor extractor reads snake_case (2026-07-11
        # `ProductTypeEventExtractor.extractAiAgentFields`); camelCase is
        # a courtesy for JS analytics consumers so the same event body
        # reads sensibly on both sides.
        metadata: Dict[str, Any] = {
            "sdkLanguage": "python",
            "sdkVersion": __version__,
            "productId": self.product_id,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "totalTokens": input_tokens + output_tokens,
        }
        if capability_name:
            metadata["capability_name"] = capability_name  # snake_case (extractor)
            metadata["capabilityName"] = capability_name  # camelCase (JS parity)
        if extra_metadata:
            metadata.update(extra_metadata)

        event: Dict[str, Any] = {
            "customerId": customer_id,
            "metricName": metric_name,
            "quantity": 1,
            "occurredAt": _utc_now_iso(),
            # 'agent:{uuid}' mirrors node-agent's key format. UUID is
            # dense enough to make a same-millisecond collision
            # astronomically unlikely (128 bits vs. the compound key
            # python-mcp uses for legacy dedup reasons), and it survives
            # replay after a drop-hook persist step.
            "idempotencyKey": f"agent:{uuid.uuid4()}",
            "productType": _normalize_product_type(product_type, self.product_type),
            "agentId": agent_id,
            "sessionId": session_id,
            "executionDurationMs": execution_duration_ms,
            "metadata": metadata,
        }
        status = normalize_execution_status(execution_status)
        if status is not None:
            event["executionStatus"] = status
        return event

    @staticmethod
    def _invalid_reason(
        event: Dict[str, Any], capability_name: Optional[str]
    ) -> Optional[str]:
        """Why the ingestor would reject this event, else ``None``."""
        if _blank(event.get("agentId")):
            return "agent_id is required for AI_AGENT (got blank)"
        if _blank(event.get("customerId")):
            return "customer_id is required (got blank)"
        return (
            _too_long("agentId", event.get("agentId"))
            or _too_long("customerId", event.get("customerId"))
            or _too_long("sessionId", event.get("sessionId"))
            or _too_long("capabilityName", capability_name)
            or _too_long("metricName", event.get("metricName"))
            or _too_long("productType", event.get("productType"))
            or _too_long("idempotencyKey", event.get("idempotencyKey"))
        )

    def _submit(self, event: Dict[str, Any], problem: Optional[str]) -> None:
        """Buffer a valid event; drop an invalid one (never raises)."""
        if problem:
            self._record_drop([event], "invalid", detail=problem)
            return
        if self._buffer.add(event):
            self._schedule_flush()

    def _schedule_flush(self) -> None:
        """Kick off a flush without blocking the caller.

        Checks for a running loop FIRST so we don't create a coroutine
        object we can't schedule — a bare
        ``asyncio.ensure_future(self.flush())`` evaluates ``self.flush()``
        (creating a coroutine) BEFORE ensure_future tries to schedule it,
        so a missing loop leaves the coroutine dangling with a
        'coroutine was never awaited' RuntimeWarning at GC. Bug fixed
        2026-07-11.

        Also attaches a done-callback that reads (and thereby "consumes")
        any exception the scheduled flush raises — otherwise asyncio
        emits 'Task exception was never retrieved' at GC even when
        flush's own try/except already handled the error.
        """
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No running event loop — caller must await flush() manually.
            logger.debug("[aforo-agent] no running loop; caller must flush()")
            return
        task = loop.create_task(self.flush())
        task.add_done_callback(self._consume_task_exception)

    @staticmethod
    def _consume_task_exception(task: "asyncio.Task[Any]") -> None:
        """Drain a task's exception so asyncio doesn't emit
        'Task exception was never retrieved' at GC. Cancellation is
        expected during shutdown and is silently absorbed."""
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            return
        if exc is not None:
            logger.debug(
                "[aforo-agent] scheduled flush raised (consumed)", exc_info=exc
            )

    async def _periodic_flush(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(self.flush_interval_sec)
            except asyncio.CancelledError:
                break
            try:
                await self.flush()
            except Exception as e:  # noqa: BLE001
                self._safe_on_error(e)

    def _record_drop(
        self,
        events: List[Dict[str, Any]],
        reason: DropReason,
        *,
        count: Optional[int] = None,
        detail: Optional[str] = None,
    ) -> None:
        """Count + WARN + fire the optional ``on_drop`` hook. A hook bug
        must never break flushing. ``"invalid"`` logs are throttled (first,
        then every 1000th) so a tight loop can't storm the log. ``count``
        overrides ``len(events)`` when the ingestor reported rejected events
        without saying which ones."""
        n = len(events) if count is None else count
        if n <= 0:
            return
        self._dropped += n
        if reason == "invalid":
            self._invalid_drops += n
            if self._invalid_drops == 1 or self._invalid_drops % 1000 == 0:
                logger.warning(
                    "[aforo-agent] invalid event not sent — %s (%d total dropped)",
                    detail or "client-side validation",
                    self._dropped,
                )
        else:
            logger.warning(
                "[aforo-agent] dropped %d event(s) — %s (%d total dropped)",
                n,
                reason,
                self._dropped,
            )
        if self.on_drop is not None and events:
            try:
                self.on_drop(events, reason)
            except Exception:
                logger.debug(
                    "[aforo-agent] on_drop hook raised", exc_info=True
                )

    def _safe_on_error(self, e: Exception) -> None:
        try:
            self.on_error(e)
        except Exception:
            logger.debug("[aforo-agent] on_error hook raised", exc_info=True)
