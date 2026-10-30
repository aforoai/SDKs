"""
Aforo AI Agent Metering SDK — client.

One :class:`AforoAgentClient` instance per process is enough. It is
thread-safe and works with or without a running event loop: ``record_*``
only queue (bounded), and one background thread sends.
Emits Aforo AI_AGENT events to ``/v1/ingest/batch`` (default host
``https://api.aforo.ai``, authenticated with ``X-API-Key``)
using the shared ``IngestUsageEventRequest`` DTO shape. Per-capability
billing depends on ``metadata.capability_name`` (snake_case) — that's the
key the ``ProductTypeEventExtractor`` in usage-ingestor reads to fan out
per-capability line items for ``dimensionPricing``-driven rate plans.

Delivery uses the shared transport core (``_transport``): an outage keeps
batches queued with the same idempotency keys and retries after a pause.
Events lost for good (overflow, rejected, invalid, shutdown, closed) are
counted, WARN-logged, and handed to an OPT-IN ``on_drop`` hook. Dropped
events keep their idempotency keys so re-submitting them after recovery
is dedup-safe on the ingestor side.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Literal, Optional, Tuple

import httpx

from ._transport import (
    TransportCore,
    clean_customer_id,
    truncate_utf16,
    utf16_length,
)
from ._transport import policy as _policy

__version__ = "1.1.0"

#: Async HTTP call signature accepted by ``post_fn``: (url, headers, body) ->
#: (status, body_text) or (status, body_text, retry_after_header).
PostFn = Callable[[str, Dict[str, str], str], Awaitable[Tuple[Any, ...]]]

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
MAX_BATCH_EVENTS = _policy.MAX_BATCH_EVENTS

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

DropReason = str  # 'overflow' | 'rejected' | 'invalid' | 'shutdown' | 'closed' | 'retry_exhausted'


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
    length = utf16_length(text)
    if length <= limit:
        return None
    return (
        f"{field_name} is {length} characters (UTF-16 units), exceeding the ingestor's "
        f'{limit}-character limit (value starts "{text[:80]}")'
    )


def _utc_now_iso() -> str:
    """ISO-8601 instant with a ``Z`` suffix, e.g. ``2026-09-22T10:00:00.000Z``."""
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


class _PostFnTransport(httpx.BaseTransport):
    """httpx transport that calls an async ``post_fn(url, headers, body)``.

    For tests and custom HTTP stacks. It runs on the SDK's sender thread, in
    a private event loop, never on the application's loop.
    """

    def __init__(self, post_fn: PostFn) -> None:
        self._post_fn = post_fn

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        headers = {k.decode(): v.decode() for k, v in request.headers.raw}
        try:
            result = asyncio.run(self._post_fn(str(request.url), headers, request.content.decode("utf-8")))
        except (OSError, ConnectionError, TimeoutError) as exc:
            raise httpx.ConnectError(str(exc), request=request) from exc
        except Exception as exc:  # a failing custom transport is a network failure
            raise httpx.TransportError(f"{type(exc).__name__}: {exc}", request=request) from exc
        status, body = int(result[0]), result[1] or ""
        extra = {"Retry-After": str(result[2])} if len(result) > 2 and result[2] is not None else {}
        return httpx.Response(status, content=str(body).encode("utf-8"), headers=extra, request=request)


class AforoAgentClient:
    """Aforo AI_AGENT metering client.

    ``record_*`` put events on a bounded queue and return; they never block,
    never need a running event loop and never start a thread. One background
    thread sends batches of up to ``flush_count`` events every
    ``flush_interval_sec`` seconds, or as soon as ``flush_count`` are queued.
    Nothing has to be started; at interpreter exit (``atexit``) the queue is
    flushed for at most ``shutdown_timeout_sec`` seconds.

    Args:
        tenant_id: Aforo tenant id. Sent as the ``X-Tenant-Id`` header.
        product_id: Aforo AI_AGENT product id.
        api_key: Aforo API key. Sent only as the ``X-API-Key`` header; never
            in ``repr()`` or logs.
        ingestor_url: Base URL events are POSTed to. Defaults to
            ``https://api.aforo.ai``. Must be ``https://`` (plain ``http://``
            only for localhost, or with ``allow_insecure_http=True``).
        default_customer_id: Customer billed when a ``record_*`` call passes
            no ``customer_id`` (single-customer deployments). There is no
            other fallback: without either, the event is dropped as
            ``"invalid"``. The agent id is never used as the customer.
        product_type: Top-level ``productType`` on every event. Default
            ``AI_AGENT``.
        flush_count: Events per request (default 500, at most 1000).
        flush_interval_sec: Seconds between background sends. Default 5.
        max_retries: Retries per batch on network errors, timeouts, 408,
            429 and 5xx before the batch is requeued. Default 3.
        on_error: Called with an exception describing an outage or a
            rejection. Exceptions from this hook are caught.
        on_drop: OPT-IN hook receiving events lost for good, with a reason:
            ``"overflow"`` (queue full), ``"rejected"`` (the ingestor refused
            them), ``"invalid"`` (refused before queueing), ``"shutdown"``
            (still queued at the shutdown deadline), ``"closed"`` (recorded
            after shutdown). Events keep their idempotency keys, so
            re-submitting them is dedup-safe. Exceptions are caught.
        post_fn: Optional async ``(url, headers, body) -> (status, body[,
            retry_after])`` used instead of the built-in HTTP client (tests,
            custom stacks). It runs on the sender thread. ``body`` is the JSON
            text, so compression is off when ``post_fn`` is used.
        compression: ``"gzip"`` (default) sends batches of 1 KiB or more with
            ``Content-Encoding: gzip`` (needs usage-ingestor wave 8 or later);
            ``"none"`` always sends plain JSON.
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
        flush_count: int = _policy.DEFAULT_FLUSH_COUNT,
        flush_interval_sec: float = 5.0,
        max_retries: int = _policy.MAX_RETRIES,
        on_error: Optional[Callable[[Exception], None]] = None,
        on_drop: Optional[Callable[[List[Dict[str, Any]], DropReason], None]] = None,
        post_fn: Optional[PostFn] = None,
        max_queue_size: int = _policy.DEFAULT_QUEUE_CAPACITY,
        timeout_sec: float = _policy.REQUEST_TIMEOUT_S,
        shutdown_timeout_sec: float = _policy.SHUTDOWN_TIMEOUT_S,
        allow_insecure_http: bool = False,
        compression: str = "gzip",
        http_transport: Any = None,
        transport_options: Optional[Dict[str, Any]] = None,
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
        self.default_customer_id = clean_customer_id(default_customer_id)
        self.product_type = _normalize_product_type(product_type, DEFAULT_PRODUCT_TYPE)
        self.flush_interval_sec = flush_interval_sec
        self.max_retries = max_retries
        self.on_error = on_error or (lambda e: logger.debug("[aforo-agent] %s", e))
        via_post_fn = http_transport is None and post_fn is not None
        if via_post_fn:
            http_transport = _PostFnTransport(post_fn)
        self._core = TransportCore(
            api_key=api_key,
            base_url=ingestor_url,
            user_agent=f"aforo-agent-metering-python/{__version__}",
            name="aforo-agent",
            logger=logger,
            path=INGEST_PATH,
            flush_count=flush_count,
            flush_interval=flush_interval_sec,
            max_queue_size=max_queue_size,
            timeout=timeout_sec,
            max_retries=max_retries,
            shutdown_timeout=shutdown_timeout_sec,
            allow_insecure_http=allow_insecure_http,
            # A custom post_fn receives the JSON as text (its documented contract), so
            # it never gets gzip bytes.
            compression="none" if via_post_fn else compression,
            on_drop=on_drop,
            on_error=self._safe_on_error,
            extra_headers={"X-Tenant-Id": tenant_id},
            http_transport=http_transport,
            **(transport_options or {}),
        )
        self.ingestor_url = self._core.url[: -len(INGEST_PATH)]
        self.flush_count = self._core.flush_count

    def __repr__(self) -> str:
        return f"AforoAgentClient(tenant_id={self.tenant_id!r}, ingestor_url={self.ingestor_url!r})"

    @property
    def on_drop(self) -> Optional[Callable[[List[Dict[str, Any]], DropReason], None]]:
        return self._core._on_drop

    @on_drop.setter
    def on_drop(self, hook: Optional[Callable[[List[Dict[str, Any]], DropReason], None]]) -> None:
        self._core._on_drop = hook

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

        ``customer_id`` (or the client's ``default_customer_id``) is the
        customer billed; the agent id is never used in its place.

        Never raises for event content. An event the ingestor would reject
        (blank ``capability_name`` / ``agent_id`` / customer, ``agent_id`` > 36
        UTF-16 units, ``session_id`` / ``customer_id`` / ``capability_name`` > 64)
        is not queued: it is counted in :attr:`dropped_count`, WARN-logged and
        passed to ``on_drop`` with reason ``"invalid"``.
        """
        event = self._build_event(
            customer_id=self._customer(customer_id),
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
        ``session_id`` / ``step_type`` / customer or an over-limit field is
        dropped with reason ``"invalid"``, as in :meth:`record_capability`.
        """
        combined_meta: Dict[str, Any] = {"stepType": step_type}
        if metadata:
            combined_meta.update(metadata)
        event = self._build_event(
            customer_id=self._customer(customer_id),
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

    async def flush(self, timeout: Optional[float] = None) -> int:
        """Send everything queued now and wait for it, in a worker thread so
        the event loop keeps running. Returns how many events are still queued
        (non-zero while the ingestor is unreachable; they are retried)."""
        outcome = await asyncio.get_running_loop().run_in_executor(None, self._core.flush, timeout)
        return outcome.pending

    def flush_sync(self, timeout: Optional[float] = None) -> int:
        """:meth:`flush` for code with no running event loop."""
        return self._core.flush(timeout).pending

    async def start(self) -> None:
        """Kept for compatibility. The background sender runs from
        construction; there is nothing to start."""
        return None

    async def shutdown(self, timeout: Optional[float] = None) -> None:
        """Stop accepting events and flush for at most ``shutdown_timeout_sec``
        (or ``timeout``) seconds, in a worker thread. Events still queued then
        are reported to ``on_drop`` as ``"shutdown"``. Runs at interpreter
        exit too, so calling it is optional."""
        await asyncio.get_running_loop().run_in_executor(None, self._core.close, timeout)

    def shutdown_sync(self, timeout: Optional[float] = None) -> None:
        """:meth:`shutdown` for code with no running event loop."""
        self._core.close(timeout)

    @property
    def dropped_count(self) -> int:
        """Total events lost for good since the client was created."""
        return self._core.dropped_count

    def __len__(self) -> int:
        return self._core.queue_size

    @property
    def _buffer(self) -> List[Dict[str, Any]]:
        """Snapshot of the queued events (for tests and debugging)."""
        return self._core.queued_items()

    # ─────────────────────────── internals ──────────────────────────

    def _customer(self, customer_id: Optional[str]) -> str:
        return clean_customer_id(customer_id) or self.default_customer_id or ""

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
        # The usage-ingestor extractor reads snake_case; camelCase is a
        # courtesy for JS analytics consumers.
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
            # 'agent:{uuid}' mirrors node-agent's key format; minted once, so
            # retries and on_drop replays are dedup-safe.
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
            return ("customer_id is required: pass customer_id or set default_customer_id "
                    "(the agent id is not used as the customer)")
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
        """Queue a valid event; drop an invalid one (never raises, never blocks)."""
        if problem:
            self._core.report_drop([event], "invalid", detail=problem)
            return
        self._core.enqueue(event)

    def _safe_on_error(self, e: Exception) -> None:
        try:
            self.on_error(e)
        except Exception:
            logger.debug("[aforo-agent] on_error hook raised", exc_info=True)
