"""
Aforo MCP Billing Client — meters tool invocations and manages sessions.

Session heartbeats are sent in their own requests: see ``AforoMcpBilling.start_session``.
"""

import asyncio
import functools
import hashlib
import inspect
import json
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

from ._transport import (
    TransportCore,
    clean_customer_id,
    require_customer_source,
    truncate_utf16,
    utf16_length,
)
from ._transport import policy as _policy
from ._transport import too_long as _too_long_utf16

__version__ = "2.0.0"

logger = logging.getLogger("aforo_mcp_metering")


#: The 11 statuses the ingestor accepts; any other value rejects the event.
EXECUTION_STATUSES = frozenset({
    "SUCCESS", "PARTIAL", "TIMEOUT", "ERROR", "VALIDATION_FAILED", "FAILED",
    "FAILURE", "CANCELLED", "PENDING", "BLOCKED", "HITL_REQUIRED",
})

#: JSON-RPC error code the MCP SDKs use for a request timeout (ErrorCode.RequestTimeout).
MCP_REQUEST_TIMEOUT = -32001

#: ``status_resolver(result, error) -> Optional[str]``. ``result`` is None when
#: the handler raised; ``error`` is None when it returned. Return a canonical
#: status, or None/blank to use :func:`default_tool_status`.
ToolStatusResolver = Callable[[Any, Optional[BaseException]], Optional[str]]


def _is_error_result(result: Any) -> bool:
    """MCP tools report failure by returning a result with ``isError`` set —
    a ``CallToolResult``-style object or a plain dict. Must be literally True."""
    if isinstance(result, dict):
        return result.get("isError") is True or result.get("is_error") is True
    return getattr(result, "isError", None) is True or getattr(result, "is_error", None) is True


def _is_timeout(error: BaseException) -> bool:
    if isinstance(error, (TimeoutError, asyncio.TimeoutError)):
        return True
    code = getattr(error, "code", None)
    if code is None:
        # mcp.shared.exceptions.McpError carries the JSON-RPC error on .error
        code = getattr(getattr(error, "error", None), "code", None)
    return code == MCP_REQUEST_TIMEOUT


def default_tool_status(result: Any, error: Optional[BaseException]) -> str:
    """Default executionStatus for a wrapped tool call.

    - cancelled (``asyncio.CancelledError``) or interrupted (``KeyboardInterrupt``,
      ``SystemExit``, ``GeneratorExit`` — anything that isn't an ``Exception``) → CANCELLED
    - raised a timeout (``TimeoutError`` or an MCP error with code -32001) → TIMEOUT
    - raised anything else, including a JSON-RPC error → ERROR
    - returned a result with ``isError`` True, the normal way an MCP tool
      reports failure → ERROR
    - otherwise → SUCCESS

    ERROR rather than FAILURE for returned failures: whether a tool author
    raises or returns ``isError`` should not change the bill, and ERROR is what
    every gateway and SDK sends for a call that ran and failed.
    """
    if error is not None:
        if not isinstance(error, Exception):  # CancelledError, KeyboardInterrupt, SystemExit
            return "CANCELLED"
        if _is_timeout(error):
            return "TIMEOUT"
        return "ERROR"
    if _is_error_result(result):
        return "ERROR"
    return "SUCCESS"


# The ingestor's per-request cap on POST /v1/ingest/batch (IngestBatchRequest).
MAX_BATCH_EVENTS = _policy.MAX_BATCH_EVENTS

DEFAULT_PRODUCT_TYPE = "MCP_SERVER"
HEARTBEAT_METRIC = "system.session.heartbeat"
# Ingestor field limits (IngestUsageEventRequest @Size). An event over one of
# them is rejected server-side, so it is dropped here as "invalid" -- never
# truncated: a truncated id bills the wrong thing.
MAX_CUSTOMER_ID_LEN = 64
MAX_AGENT_ID_LEN = 36
MAX_TOOL_NAME_LEN = 64
MAX_SESSION_ID_LEN = 64
MAX_PRODUCT_TYPE_LEN = 20
MAX_IDEMPOTENCY_KEY_LEN = 255


# ── Request-derived labels ───────────────────────────────────────
# A label the SDK copies from the incoming request / message is cut to the
# ingestor's limit and the event is still sent: dropping it would let an API
# consumer avoid metering by sending an over-long name. Fields the SDK caller
# sets are never altered. The ingestor counts Java String.length(), i.e. UTF-16
# code units, so a character outside the BMP counts as 2.

_truncation_lock = threading.Lock()


_utf16_length = utf16_length
_truncate_utf16 = truncate_utf16


def _too_long(field_name: str, value: Any, limit: int) -> Optional[str]:
    """Over-limit message, counting UTF-16 units as the ingestor does."""
    return _too_long_utf16(field_name, value, limit)


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
            "[aforo-mcp] %s taken from the request was longer than the ingestor's limit and was "
            "truncated to %d characters; the event is still sent. Logged once per field.",
            field_name, limit,
        )
    return cut


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


def _fit_idempotency_key(parts: List[Any], request_derived: Tuple[int, ...]) -> str:
    """Join ``parts`` with ":" into an idempotency key of at most 255 chars.

    A key that fits is returned unchanged. Otherwise the request-derived
    components (indexes in ``request_derived``, in that order) are replaced one
    at a time by the SHA-256 hex digest of their full text until the key fits;
    if it still does not, everything after the prefix becomes the digest of the
    whole key. Nothing is cut off, so two different inputs never share a key
    and the same input always gives the same key.
    """
    parts = [str(p) for p in parts]
    full = ":".join(parts)
    if _utf16_length(full) <= MAX_IDEMPOTENCY_KEY_LEN:
        return full
    for index in request_derived:
        parts[index] = _sha256_hex(parts[index])
        key = ":".join(parts)
        if _utf16_length(key) <= MAX_IDEMPOTENCY_KEY_LEN:
            return key
    return f"{parts[0]}:{_sha256_hex(full)}"


def _utc_now_iso() -> str:
    """ISO-8601 instant, e.g. ``2026-09-22T10:00:00.000Z``."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _normalize_product_type(product_type: Optional[str], default: str) -> str:
    """Trim + upper-case; unknown values pass through; blank -> ``default``."""
    value = str(product_type).strip().upper() if product_type is not None else ""
    return value or default


def _normalize_status(value: Any) -> Optional[str]:
    """Trim + upper-case an execution status; blank -> None. A value outside
    :data:`EXECUTION_STATUSES` is WARN-logged and left off (None): the ingestor
    rejects an unknown status, which would lose that event's usage."""
    if not isinstance(value, str) or not value.strip():
        return None
    status = value.strip().upper()
    if status not in EXECUTION_STATUSES:
        logger.warning("[aforo-mcp] Ignoring unknown executionStatus %r", value[:40])
        return None
    return status


def _invalid_reason(event: Dict[str, Any]) -> Optional[str]:
    """Why the ingestor would reject this tool-invocation event, else None."""
    if not event.get("toolName"):
        return "toolName is required for MCP_SERVER (got blank)"
    if not event.get("customerId"):
        return ("customerId is required: pass customer_id, or configure customer_resolver "
                "(got none for this call)")
    if not event.get("agentId"):
        return "agentId is required for MCP_SERVER (got blank)"
    return (
        _too_long("toolName", event.get("toolName"), MAX_TOOL_NAME_LEN)
        or _too_long("agentId", event.get("agentId"), MAX_AGENT_ID_LEN)
        or _too_long("customerId", event.get("customerId"), MAX_CUSTOMER_ID_LEN)
        or _too_long("sessionId", event.get("sessionId"), MAX_SESSION_ID_LEN)
        or _too_long("productType", event.get("productType"), MAX_PRODUCT_TYPE_LEN)
    )


@dataclass
class UsageEvent:
    customer_id: str
    metric_name: str
    quantity: float
    occurred_at: str
    idempotency_key: str
    product_type: str = "MCP_SERVER"
    tool_name: str = ""
    agent_id: str = ""
    session_id: Optional[str] = None
    execution_status: str = "SUCCESS"
    execution_duration_ms: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolCall:
    """What a ``customer_resolver`` sees for one ``tools/call``."""

    name: str
    arguments: Optional[Dict[str, Any]]
    kwargs: Dict[str, Any]

    @property
    def meta(self) -> Dict[str, Any]:
        """The request's ``_meta`` object (from ``arguments`` or kwargs), if any."""
        for source in (self.kwargs.get("_meta"), (self.arguments or {}).get("_meta")):
            if isinstance(source, dict):
                return source
        return {}


#: ``customer_resolver(call) -> Optional[str]``: the customer to bill for one
#: tool call, from identity your server verified (the MCP session's
#: authenticated principal, an OAuth token subject).
CustomerResolver = Callable[[ToolCall], Optional[str]]


def _caller_supplied_customer(call: ToolCall) -> Optional[str]:
    """``customer_id`` kwarg or ``_meta.customer_id``: values the MCP client sends."""
    return clean_customer_id(call.kwargs.get("customer_id") or call.meta.get("customer_id"))


class AforoMcpBilling:
    """
    Aforo MCP Server Metering SDK.

    Wraps MCP tool handlers to automatically:
    - Record tool invocations with timing
    - Queue them (bounded) and send them in batches from one background thread
    - Keep them queued through an ingest outage and retry after a pause
    - Emit session heartbeats, each in its own request

    Every event carries ``productType`` (client option ``product_type``,
    default ``MCP_SERVER``; per-call override) plus the MCP_SERVER-required
    ``toolName`` and ``agentId``, and the ``customerId`` your
    ``customer_resolver`` returns.

    Nothing has to be started: the sender thread runs from construction and
    flushes at interpreter exit (``atexit``) within ``shutdown_timeout_sec``.
    ``record_tool_invocation`` and the wrapped handlers never block the event
    loop; ``flush()`` and ``shutdown()`` wait in a worker thread.
    """

    def __init__(
        self,
        tenant_id: str,
        product_id: str,
        api_key: str,
        ingestor_url: str,
        flush_interval_sec: float = 5.0,
        flush_count: int = _policy.DEFAULT_FLUSH_COUNT,
        on_error: Optional[Callable[[Exception], None]] = None,
        heartbeat_interval_sec: float = 30.0,
        heartbeat_enabled: bool = True,
        on_session_killed: Optional[Callable[[str, str], None]] = None,
        on_drop: Optional[Callable[[List[Dict[str, Any]], str], None]] = None,
        product_type: str = DEFAULT_PRODUCT_TYPE,
        *,
        customer_resolver: Optional[CustomerResolver] = None,
        trust_customer_header: bool = False,
        agent_resolver: Optional[Callable[[ToolCall], Optional[str]]] = None,
        max_queue_size: int = _policy.DEFAULT_QUEUE_CAPACITY,
        timeout_sec: float = _policy.REQUEST_TIMEOUT_S,
        shutdown_timeout_sec: float = _policy.SHUTDOWN_TIMEOUT_S,
        allow_insecure_http: bool = False,
        http_transport: Any = None,
        transport_options: Optional[Dict[str, Any]] = None,
    ):
        """``customer_resolver(call)`` returns the customer to bill for a tool
        call (see :class:`ToolCall`). ``trust_customer_header=True`` instead
        bills the ``customer_id`` kwarg / ``_meta.customer_id`` the MCP client
        sends -- only safe when your transport authenticates the client and
        sets it. ``wrap_tool_handler`` needs one of the two.
        ``agent_resolver(call)`` supplies ``agentId`` when a call carries no
        ``agent_id`` kwarg (for example from the MCP session's ``clientInfo``).
        ``ingestor_url`` must be ``https://`` (plain ``http://`` only for
        localhost, or with ``allow_insecure_http=True``). ``on_drop(events,
        reason)`` gets events lost for good: ``overflow``, ``rejected``,
        ``invalid``, ``shutdown``, ``closed``."""
        if not tenant_id:
            raise ValueError("tenant_id is required")
        if not product_id:
            raise ValueError("product_id is required")
        if not api_key:
            raise ValueError("api_key is required")
        if not ingestor_url:
            raise ValueError("ingestor_url is required")

        self.tenant_id = tenant_id
        self.product_id = product_id
        self.flush_interval_sec = flush_interval_sec
        self.product_type = _normalize_product_type(product_type, DEFAULT_PRODUCT_TYPE)
        self.on_error = on_error or (lambda e: logger.debug("[aforo-mcp] %s", e))
        self.customer_resolver = customer_resolver
        self.trust_customer_header = trust_customer_header
        self.agent_resolver = agent_resolver
        self._truncation_warned: set = set()
        self._core = TransportCore(
            api_key=api_key,
            base_url=ingestor_url,
            user_agent=f"aforo-mcp-metering-python/{__version__}",
            name="aforo-mcp",
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

        # Session / heartbeat state
        self._heartbeat_interval = heartbeat_interval_sec
        self._heartbeat_enabled = heartbeat_enabled
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._active_session_id: Optional[str] = None
        self._session_customer_id = "system"
        self._session_product_type = self.product_type
        self._session_started_at = 0.0
        self._on_session_killed = on_session_killed

    def __repr__(self) -> str:
        return f"AforoMcpBilling(tenant_id={self.tenant_id!r}, ingestor_url={self.ingestor_url!r})"

    @property
    def on_drop(self) -> Optional[Callable[[List[Dict[str, Any]], str], None]]:
        return self._core._on_drop

    @on_drop.setter
    def on_drop(self, hook: Optional[Callable[[List[Dict[str, Any]], str], None]]) -> None:
        self._core._on_drop = hook

    def _safe_on_error(self, exc: Exception) -> None:
        try:
            self.on_error(exc)
        except Exception:
            logger.debug("[aforo-mcp] on_error hook raised", exc_info=True)

    @property
    def _buffer(self) -> List[Dict[str, Any]]:
        """Snapshot of the queued events (for tests and debugging)."""
        return self._core.queued_items()

    # ─── Session lifecycle ───────────────────────────────────────────────
    #
    # Heartbeats are ``system.session.heartbeat`` events with quantity 1 (never
    # billed: the ingestor intercepts them before billing). Each one is POSTed in
    # its OWN ``{"events": [hb]}`` request -- never mixed into a usage batch -- so
    # it always takes the ingestor's synchronous path, where heartbeats are
    # intercepted. They are best-effort: one attempt, failures are logged and
    # never affect usage delivery.

    async def start_session(
        self,
        session_id: str,
        product_type: Optional[str] = None,
        customer_id: Optional[str] = None,
    ) -> None:
        """Start a session: heartbeat now, then every ``heartbeat_interval_sec``.

        ``product_type`` defaults to the client's; ``customer_id`` (the heartbeat's
        ``customerId``) defaults to ``"system"``.
        """
        self._stop_session()
        self._begin_session(session_id, product_type, customer_id)

    async def end_session(self) -> None:
        """End the session: stop heartbeats, flush, then send ``SESSION_END``."""
        session_id = self._active_session_id
        self._stop_session()
        await self.flush()
        if session_id:
            await self._send_heartbeat(session_id, "SESSION_END")

    def _begin_session(
        self, session_id: str, product_type: Optional[str], customer_id: Optional[str]
    ) -> None:
        self._active_session_id = session_id
        self._session_product_type = _normalize_product_type(product_type, self.product_type)
        cid = str(customer_id).strip() if customer_id is not None else ""
        self._session_customer_id = cid if cid and utf16_length(cid) <= MAX_CUSTOMER_ID_LEN else "system"
        self._session_started_at = time.monotonic()
        if self._heartbeat_enabled and session_id:
            self._heartbeat_task = asyncio.ensure_future(self._heartbeat_loop(session_id))

    def _stop_session(self) -> None:
        if self._heartbeat_task and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
        self._heartbeat_task = None
        self._active_session_id = None

    async def _heartbeat_loop(self, session_id: str) -> None:
        try:
            while self._active_session_id == session_id:
                await self._send_heartbeat(session_id, "HEARTBEAT")
                await asyncio.sleep(self._heartbeat_interval)
        except asyncio.CancelledError:
            logger.debug("[aforo-mcp] heartbeat loop for %s stopped", session_id)

    def _heartbeat_event(self, session_id: str, boundary: str) -> Dict[str, Any]:
        heartbeat_type = "SESSION_END" if boundary == "SESSION_END" else "PERIODIC"
        metadata: Dict[str, Any] = {
            "sessionId": session_id,
            "sessionBoundary": boundary,
            "productType": self._session_product_type,
            "heartbeatType": heartbeat_type,
            "uptimeMs": int((time.monotonic() - self._session_started_at) * 1000),
            "productId": self.product_id,
            "sdk": "python",
            "sdkVersion": __version__,
        }
        try:
            import resource
            metadata["processMemoryMb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)
        except Exception:
            logger.debug("[aforo-mcp] process memory not available for the heartbeat", exc_info=True)
        return {
            "customerId": self._session_customer_id,
            "metricName": HEARTBEAT_METRIC,
            "quantity": 1,  # never billed, but bean-validated: must be > 0
            "occurredAt": _utc_now_iso(),
            "idempotencyKey": f"hb:{boundary.lower()}:{session_id}:{int(time.time() * 1000)}:{uuid.uuid4().hex[:8]}",
            "productType": self._session_product_type,
            "sessionId": session_id,
            "sessionBoundary": boundary,
            "metadata": metadata,
        }

    async def _send_heartbeat(self, session_id: str, boundary: str) -> None:
        """POST one heartbeat on its own, in a worker thread. Best-effort:
        never raises, never retries, never counts as a usage drop."""
        try:
            event = self._heartbeat_event(session_id, boundary)
            data = await asyncio.get_running_loop().run_in_executor(
                None, self._core.post_single, {"events": [event]})
            if data is None:
                logger.debug("[aforo-mcp] heartbeat for %s was not accepted", session_id)
                return
            self._check_killed(data)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("[aforo-mcp] heartbeat failed", exc_info=True)

    def _check_killed(self, data: Dict[str, Any]) -> None:
        """Stop the active session if the ingestor lists it in ``killedSessionIds``."""
        if not self._active_session_id:
            return
        killed_ids = data.get("killedSessionIds") or []
        if self._active_session_id in killed_ids:
            killed_id = self._active_session_id
            self._stop_session()
            if self._on_session_killed:
                try:
                    self._on_session_killed(killed_id, "SERVER_KILL")
                except Exception as e:
                    self._safe_on_error(e)

    # ─── Tool handler wrapper ──────────────────────────────────────────

    def wrap_tool_handler(
        self,
        handler: Optional[Callable] = None,
        *,
        status_resolver: Optional[ToolStatusResolver] = None,
        customer_resolver: Optional[CustomerResolver] = None,
        trust_customer_header: Optional[bool] = None,
    ) -> Callable:
        """
        Decorator that wraps an MCP tool handler with automatic metering.
        Starts the session (and its heartbeats) on the first tool call that
        carries a ``session_id``. Optional kwargs read by the wrapper (and passed
        through to the handler): ``agent_id``, ``session_id``, ``product_type``.
        Without an ``agent_id`` kwarg the client's ``agent_resolver`` is asked;
        a call with no agent is dropped as ``"invalid"`` (never ``"unknown"``).

        The customer comes from ``customer_resolver`` (here or on the client),
        called with a :class:`ToolCall`. ``trust_customer_header=True`` bills the
        ``customer_id`` kwarg / ``_meta.customer_id`` the MCP client sends
        instead. With neither, decorating raises ValueError. A call with no
        customer still runs; its event is dropped as ``"invalid"`` and counted.

        The call's executionStatus comes from :func:`default_tool_status`
        (a returned ``isError`` result is ERROR, not SUCCESS), unless
        ``status_resolver`` returns a status.

        The tool name is the ``name`` of the incoming ``tools/call`` request. One
        longer than 64 characters is cut to 64 and the call is still metered
        (see :meth:`record_tool_invocation`). ``agent_id`` / ``session_id`` are
        never altered: an over-long one drops the event as ``"invalid"``.

        Usage:
            billing = AforoMcpBilling(..., customer_resolver=lambda call: session_user.customer_id)

            @billing.wrap_tool_handler
            async def handle_tool(name: str, arguments: dict):
                ...
        """
        resolver = customer_resolver if customer_resolver is not None else self.customer_resolver
        trust = self.trust_customer_header if trust_customer_header is None else trust_customer_header
        require_customer_source(resolver, trust, integration="AforoMcpBilling.wrap_tool_handler",
                                untrusted_source="the customer_id / _meta.customer_id the MCP client sends")
        if handler is None:
            return functools.partial(self.wrap_tool_handler, status_resolver=status_resolver,
                                     customer_resolver=customer_resolver,
                                     trust_customer_header=trust_customer_header)

        def customer_for(name: str, arguments: Any, kwargs: Dict[str, Any]) -> Optional[str]:
            call = ToolCall(name=name, arguments=arguments if isinstance(arguments, dict) else None,
                            kwargs=kwargs)
            try:
                if resolver is not None:
                    return clean_customer_id(resolver(call))
                return _caller_supplied_customer(call)
            except Exception:
                logger.warning("[aforo-mcp] customer_resolver raised; the call is not metered", exc_info=True)
                return None

        def agent_for(name: str, arguments: Any, kwargs: Dict[str, Any]) -> Optional[str]:
            explicit = clean_customer_id(kwargs.get("agent_id"))
            if explicit or self.agent_resolver is None:
                return explicit
            try:
                return clean_customer_id(self.agent_resolver(ToolCall(
                    name=name, arguments=arguments if isinstance(arguments, dict) else None, kwargs=kwargs)))
            except Exception:
                logger.warning("[aforo-mcp] agent_resolver raised", exc_info=True)
                return None

        @functools.wraps(handler)
        async def wrapper(name: str, arguments: dict = None, **kwargs):
            agent_id = agent_for(name, arguments, kwargs)
            session_id = kwargs.get("session_id")
            product_type = kwargs.get("product_type")
            customer_id = customer_for(name, arguments, kwargs)
            start_time = time.monotonic()
            result: Any = None
            error: Optional[BaseException] = None

            # Start the session on the first tool call that carries one
            if session_id and not self._active_session_id:
                self._begin_session(session_id, product_type, customer_id)

            try:
                outcome = handler(name, arguments, **kwargs)
                if inspect.isawaitable(outcome):  # async handler (sync ones work too)
                    outcome = await outcome
                result = outcome
                return result
            except BaseException as exc:  # includes asyncio.CancelledError
                error = exc
                raise
            finally:
                duration_ms = int((time.monotonic() - start_time) * 1000)
                self.record_tool_invocation(
                    tool_name=name,
                    agent_id=agent_id,
                    session_id=session_id,
                    execution_status=self._resolve_tool_status(result, error, status_resolver),
                    execution_duration_ms=duration_ms,
                    product_type=product_type,
                    customer_id=customer_id,
                )

        return wrapper

    def _resolve_tool_status(
        self,
        result: Any,
        error: Optional[BaseException],
        resolver: Optional[ToolStatusResolver],
    ) -> str:
        if resolver is not None:
            try:
                custom = resolver(result, error)
                if inspect.isawaitable(custom):
                    # An async resolver can't be awaited from the finally block
                    # without delaying the tool's result; close it so it never
                    # runs ("never awaited" warning) and use the default.
                    close = getattr(custom, "close", None)
                    if callable(close):
                        close()
                    logger.warning("[aforo-mcp] status_resolver must be synchronous; using the default status")
                elif isinstance(custom, str) and custom.strip():
                    status = custom.strip().upper()
                    if status in EXECUTION_STATUSES:
                        return status
                    logger.warning("[aforo-mcp] status_resolver returned %r, which is not an execution "
                                   "status; using the default status", custom)
            except Exception as exc:  # a broken resolver must never break metering
                logger.warning("[aforo-mcp] status_resolver raised %r; using the default status", exc)
        return default_tool_status(result, error)

    def record_tool_invocation(
        self,
        tool_name: str,
        agent_id: str,
        session_id: Optional[str] = None,
        execution_status: str = "SUCCESS",
        execution_duration_ms: int = 0,
        *,
        product_type: Optional[str] = None,
        customer_id: Optional[str] = None,
    ) -> None:
        """Queue a tool invocation event. Never blocks and never raises for
        event content.

        ``customer_id`` is the customer to bill (required; the wrapper passes
        what your ``customer_resolver`` returned). ``agent_id`` is the MCP
        client agent (required, at most 36 characters). There is no default
        for either: an event without them is dropped as ``"invalid"``.

        ``product_type`` overrides the client's ``product_type`` for this event.
        ``execution_status`` is trimmed and upper-cased; a value outside the 11
        canonical statuses is WARN-logged and left off (the event is still sent).

        An invocation the ingestor would reject (blank tool name, customer or
        agent, ``agent_id`` > 36, ``customer_id`` / ``session_id`` > 64 UTF-16
        units) is not queued: it is counted in ``dropped_count``, WARN-logged
        and passed to ``on_drop`` with reason ``"invalid"``. Those ids are never
        truncated.

        ``tool_name`` is the name from the client's ``tools/call`` request. One
        longer than 64 characters is cut to 64 and the event is still sent (a
        WARNING is logged once per client); the idempotency key is built from
        the full name.
        """
        agent_id = clean_customer_id(agent_id) or ""
        customer = clean_customer_id(customer_id) or ""
        key_tool_name = str(tool_name).strip() if tool_name is not None else ""
        tool_name = _truncate_label("toolName", key_tool_name, MAX_TOOL_NAME_LEN, self._truncation_warned)
        resolved_product_type = _normalize_product_type(product_type, self.product_type)
        event: Dict[str, Any] = {
            "customerId": customer,
            "metricName": "mcp_server.tool_invocations",
            "quantity": 1,
            "occurredAt": _utc_now_iso(),
            # Random suffix de-collides identical tool calls landing in the same
            # millisecond. Stamped once at event creation: retries stay dedup-safe.
            # A key over 255 chars would be rejected, so an over-long tool name
            # (and only then) is replaced in the key by its SHA-256 digest.
            "idempotencyKey": _fit_idempotency_key(
                ["mcp", "sdk", agent_id or "no-agent", session_id or "no-session", key_tool_name,
                 int(time.time() * 1000), uuid.uuid4().hex[:8]],
                (4,),
            ),
            "productType": resolved_product_type,
            "toolName": tool_name,
            "agentId": agent_id,
            "sessionId": session_id,
            "executionDurationMs": execution_duration_ms,
            "metadata": {
                "productId": self.product_id,
                "sdk": "python",
                "sdkVersion": __version__,
            },
        }
        status = _normalize_status(execution_status)
        if status is not None:
            event["executionStatus"] = status

        problem = _invalid_reason(event)
        if problem:
            self._core.report_drop([event], "invalid", detail=problem)
            return
        self._core.enqueue(event)

    async def flush(self, timeout: Optional[float] = None) -> int:
        """Send everything queued now and wait for it (in a worker thread, so
        the event loop keeps running). Returns how many events are still
        queued -- non-zero while the ingestor is unreachable."""
        outcome = await asyncio.get_running_loop().run_in_executor(None, self._core.flush, timeout)
        return outcome.pending

    @property
    def dropped_count(self) -> int:
        """Events lost for good since creation: overflow, rejected, invalid,
        shutdown, closed."""
        return self._core.dropped_count

    async def start(self) -> None:
        """Kept for compatibility. The background sender runs from
        construction; there is nothing to start."""
        return None

    async def shutdown(self, timeout: Optional[float] = None) -> None:
        """Stop heartbeats, then flush for at most ``shutdown_timeout_sec`` (or
        ``timeout``) seconds in a worker thread. Events still queued then are
        reported to ``on_drop`` as ``"shutdown"``. The same happens at
        interpreter exit if you never call this."""
        self._stop_session()
        await asyncio.get_running_loop().run_in_executor(None, self._core.close, timeout)

    def shutdown_sync(self, timeout: Optional[float] = None) -> None:
        """``shutdown()`` for code that has no running event loop."""
        self._stop_session()
        self._core.close(timeout)
