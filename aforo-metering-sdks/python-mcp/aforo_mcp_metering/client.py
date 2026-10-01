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

__version__ = "1.3.2"

try:
    import aiohttp
    HAS_AIOHTTP = True
except ImportError:
    HAS_AIOHTTP = False

try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False

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


def _unwrap_envelope(payload):
    """The ingestor wraps every 2xx JSON body in ``{success, data, meta}``.

    Returns the inner ``data`` object when present, else the payload unchanged
    (bare shape).
    """
    if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
        return payload["data"]
    return payload


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
MAX_BATCH_EVENTS = 1000

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


def _too_long(field_name: str, value: Any, limit: int) -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    if len(text) <= limit:
        return None
    return (
        f"{field_name} is {len(text)} characters, exceeding the ingestor's "
        f'{limit}-character limit (value starts "{text[:80]}")'
    )


def _invalid_reason(event: Dict[str, Any]) -> Optional[str]:
    """Why the ingestor would reject this tool-invocation event, else None."""
    if not event.get("toolName"):
        return "toolName is required for MCP_SERVER (got blank)"
    return (
        _too_long("toolName", event.get("toolName"), MAX_TOOL_NAME_LEN)
        # agent_id is sent as both customerId (limit 64) and agentId (limit 36).
        or _too_long("agentId", event.get("agentId"), MAX_AGENT_ID_LEN)
        or _too_long("customerId", event.get("customerId"), MAX_CUSTOMER_ID_LEN)
        or _too_long("sessionId", event.get("sessionId"), MAX_SESSION_ID_LEN)
        or _too_long("productType", event.get("productType"), MAX_PRODUCT_TYPE_LEN)
    )


def _failed_indices(response_body: Optional[str], count: int) -> Optional[tuple]:
    """Per-event rejections in a 2xx batch response.

    Returns ``(failed, indices)`` when ``failed`` > 0 -- ``indices`` is the list
    of rejected batch positions when ``errors[].index`` accounts for every
    failed event, else None -- or None when nothing was rejected.
    """
    try:
        payload = _unwrap_envelope(json.loads(response_body) if response_body else None)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    failed = payload.get("failed")
    if not isinstance(failed, int) or isinstance(failed, bool) or failed <= 0:
        return None
    failed = min(failed, count)
    indices: List[int] = []
    errors = payload.get("errors")
    if isinstance(errors, list):
        for e in errors:
            idx = e.get("index") if isinstance(e, dict) else None
            if isinstance(idx, int) and not isinstance(idx, bool) and 0 <= idx < count and idx not in indices:
                indices.append(idx)
    return failed, (sorted(indices) if len(indices) == failed else None)


def _retry_after_s(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return None


def _error_messages(response_body: Optional[str]) -> List[str]:
    """``errors[].message`` values from an ingestor batch response."""
    try:
        payload = _unwrap_envelope(json.loads(response_body) if response_body else None)
    except (TypeError, ValueError):
        return []
    if not isinstance(payload, dict) or not isinstance(payload.get("errors"), list):
        return []
    return [
        f"[{e.get('index')}] {e.get('message')}"
        for e in payload["errors"]
        if isinstance(e, dict)
    ]



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


class AforoMcpBilling:
    """
    Aforo MCP Server Metering SDK.

    Wraps MCP tool handlers to automatically:
    - Record tool invocations with timing
    - Buffer and batch-flush events to Aforo ingestor
    - Retry on transient failures (3x exponential backoff)
    - Emit session heartbeats, each in its own request

    Every event carries ``productType`` (client option ``product_type``,
    default ``MCP_SERVER``; per-call override) plus the MCP_SERVER-required
    ``toolName`` and ``agentId``.
    """

    def __init__(
        self,
        tenant_id: str,
        product_id: str,
        api_key: str,
        ingestor_url: str,
        flush_interval_sec: float = 5.0,
        flush_count: int = 50,
        on_error: Optional[Callable[[Exception], None]] = None,
        heartbeat_interval_sec: float = 30.0,
        heartbeat_enabled: bool = True,
        on_session_killed: Optional[Callable[[str, str], None]] = None,
        on_drop: Optional[Callable[[List[Dict[str, Any]], str], None]] = None,
        product_type: str = DEFAULT_PRODUCT_TYPE,
    ):
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
        self.api_key = api_key
        self.ingestor_url = ingestor_url.rstrip("/")
        self.flush_interval_sec = flush_interval_sec
        # The ingestor rejects batches larger than 1000 events.
        try:
            self.flush_count = max(1, min(int(flush_count), MAX_BATCH_EVENTS))
        except (TypeError, ValueError):
            self.flush_count = 50
        self.product_type = _normalize_product_type(product_type, DEFAULT_PRODUCT_TYPE)
        self.on_error = on_error or (lambda e: logger.error(f"[aforo-mcp] {e}"))
        # OPT-IN hook invoked with events the SDK is about to lose permanently
        # (retry exhaustion, non-retryable rejection, or an invocation refused
        # as invalid before buffering), so the app can persist
        # / alert / replay them. Dropped events keep their idempotency keys --
        # re-sending them after recovery is dedup-safe. Default: None (drops
        # are still counted in dropped_count and WARN-logged). Exceptions
        # raised by the hook are swallowed.
        self.on_drop = on_drop
        self._dropped = 0
        self._invalid_drops = 0
        self._truncation_warned: set = set()

        self._buffer: List[Dict[str, Any]] = []
        self._flush_task: Optional[asyncio.Task] = None
        self._running = False

        # Session / heartbeat state
        self._heartbeat_interval = heartbeat_interval_sec
        self._heartbeat_enabled = heartbeat_enabled
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._active_session_id: Optional[str] = None
        self._session_customer_id = "system"
        self._session_product_type = self.product_type
        self._session_started_at = 0.0
        self._on_session_killed = on_session_killed

    # ─── Session lifecycle ───────────────────────────────────────────────
    #
    # Heartbeats are ``system.session.heartbeat`` events with quantity 1 (never
    # billed: the ingestor intercepts them before billing). Each one is POSTed in
    # its OWN ``{"events": [hb]}`` request -- never mixed into a usage batch -- so
    # it always takes the ingestor's synchronous path, where heartbeats are
    # intercepted (a large batch goes to the high-throughput engine, which does
    # not intercept them). They are best-effort: one attempt, failures are logged
    # and never affect usage delivery.

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
        self._session_customer_id = cid if cid and len(cid) <= MAX_CUSTOMER_ID_LEN else "system"
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
            pass

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
            pass
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
        """POST one heartbeat on its own. Best-effort: never raises, never retries."""
        try:
            url = f"{self.ingestor_url}/v1/ingest/batch"
            body = json.dumps({"events": [self._heartbeat_event(session_id, boundary)]})
            result = await self._do_post_with_body(url, self._headers(), body)
            status_code, response_body = result[0], result[1]
            if 200 <= status_code < 300:
                self._check_killed(response_body)
            else:
                logger.debug(f"[aforo-mcp] Heartbeat rejected: HTTP {status_code}")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.debug(f"[aforo-mcp] Heartbeat failed: {e}")

    def _check_killed(self, response_body: Optional[str]) -> None:
        """Stop the active session if the ingestor lists it in ``killedSessionIds``."""
        if not response_body or not self._active_session_id:
            return
        try:
            result = _unwrap_envelope(json.loads(response_body))
            killed_ids = result.get("killedSessionIds") or []
        except (ValueError, TypeError, AttributeError):
            return  # Best-effort — old servers return an empty 202
        if self._active_session_id in killed_ids:
            killed_id = self._active_session_id
            self._stop_session()
            if self._on_session_killed:
                try:
                    self._on_session_killed(killed_id, "SERVER_KILL")
                except Exception as e:
                    self.on_error(e)

    # ─── Tool handler wrapper ──────────────────────────────────────────

    def wrap_tool_handler(
        self,
        handler: Optional[Callable] = None,
        *,
        status_resolver: Optional[ToolStatusResolver] = None,
    ) -> Callable:
        """
        Decorator that wraps an MCP tool handler with automatic metering.
        Starts the session (and its heartbeats) on the first tool call that
        carries a ``session_id``. Optional kwargs read by the wrapper (and passed
        through to the handler): ``agent_id``, ``session_id``, ``product_type``.

        The call's executionStatus comes from :func:`default_tool_status`
        (a returned ``isError`` result is ERROR, not SUCCESS), unless
        ``status_resolver`` returns a status.

        The tool name is the ``name`` of the incoming ``tools/call`` request. One
        longer than 64 characters is cut to 64 and the call is still metered
        (see :meth:`record_tool_invocation`). ``agent_id`` / ``session_id`` are
        never altered: an over-long one drops the event as ``"invalid"``.

        Usage:
            @billing.wrap_tool_handler
            async def handle_tool(name: str, arguments: dict):
                ...

            @billing.wrap_tool_handler(status_resolver=my_resolver)
            async def handle_other(name: str, arguments: dict):
                ...
        """
        if handler is None:
            return functools.partial(self.wrap_tool_handler, status_resolver=status_resolver)

        @functools.wraps(handler)
        async def wrapper(name: str, arguments: dict = None, **kwargs):
            agent_id = kwargs.get("agent_id", "unknown")
            session_id = kwargs.get("session_id")
            product_type = kwargs.get("product_type")
            start_time = time.monotonic()
            result: Any = None
            error: Optional[BaseException] = None

            # Start the session on the first tool call that carries one
            if session_id and not self._active_session_id:
                self._begin_session(
                    session_id, product_type,
                    agent_id if agent_id and agent_id != "unknown" else None,
                )

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
    ) -> None:
        """Record a tool invocation event (buffered, flushed periodically).

        ``product_type`` overrides the client's ``product_type`` for this event.
        ``execution_status`` is trimmed and upper-cased; a value outside the 11
        canonical statuses is WARN-logged and left off (the event is still sent).

        Never raises for event content. An invocation the ingestor would reject
        (blank tool name, ``agent_id`` > 36 chars, ``session_id`` > 64 chars)
        is not buffered: it is counted in ``dropped_count``, WARN-logged and
        passed to ``on_drop`` with reason ``"invalid"``. Those ids are never
        truncated.

        ``tool_name`` is the name from the client's ``tools/call`` request. One
        longer than 64 characters is cut to 64 and the event is still sent (a
        WARNING is logged once per client); the idempotency key is built from
        the full name.
        """
        agent_id = (str(agent_id).strip() if agent_id is not None else "") or "unknown"
        key_tool_name = str(tool_name).strip() if tool_name is not None else ""
        tool_name = _truncate_label("toolName", key_tool_name, MAX_TOOL_NAME_LEN, self._truncation_warned)
        resolved_product_type = _normalize_product_type(product_type, self.product_type)
        event: Dict[str, Any] = {
            "customerId": agent_id,
            "metricName": "mcp_server.tool_invocations",
            "quantity": 1,
            "occurredAt": _utc_now_iso(),
            # Random suffix de-collides identical tool calls landing in the same
            # millisecond (same agent+session+tool) -- without it they shared a
            # key and the second dedup'd away (silent under-billing; 2026-07-05
            # fix). Stamped once at event creation: flush retries stay dedup-safe.
            # A key over 255 chars would be rejected, so an over-long tool name
            # (and only then) is replaced in the key by its SHA-256 digest.
            "idempotencyKey": _fit_idempotency_key(
                ["mcp", "sdk", agent_id, session_id or "no-session", key_tool_name,
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

        # An invocation the ingestor would reject is not buffered and not sent:
        # it is counted, WARN-logged and handed to on_drop with reason "invalid".
        # No id is truncated to fit -- a shortened id bills the wrong thing.
        problem = _invalid_reason(event)
        if problem:
            self._record_drop([event], "invalid", detail=problem)
            return

        self._buffer.append(event)

        if len(self._buffer) >= self.flush_count:
            asyncio.ensure_future(self.flush())

    async def flush(self) -> None:
        """Flush buffered events to Aforo ingestor."""
        if not self._buffer:
            return

        events = self._buffer[:]
        self._buffer.clear()

        # POST /v1/ingest/batch rejects more than MAX_BATCH_EVENTS events with 400
        # (IngestBatchRequest @Size(max = 1000)), losing every event in the batch.
        # record_tool_invocation schedules flush() rather than awaiting it, so a
        # burst can buffer more than flush_count -- send in slices.
        for i in range(0, len(events), MAX_BATCH_EVENTS):
            await self._send_batch(events[i:i + MAX_BATCH_EVENTS])

    def _headers(self) -> Dict[str, str]:
        return {
            "Content-Type": "application/json",
            "X-API-Key": self.api_key,
            "X-Tenant-Id": self.tenant_id,
        }

    async def _send_batch(self, events: List[Dict[str, Any]]) -> None:
        url = f"{self.ingestor_url}/v1/ingest/batch"
        headers = self._headers()
        body = json.dumps({"events": events})

        for attempt in range(1, 4):
            delay = float(2 ** (attempt - 1))
            try:
                result = await self._do_post_with_body(url, headers, body)
                status_code, response_body = result[0], result[1]
                retry_after = result[2] if len(result) > 2 else None
                if 200 <= status_code < 300:
                    logger.debug(f"[aforo-mcp] Flushed {len(events)} events")
                    for msg in _error_messages(response_body)[:10]:
                        logger.warning(f"[aforo-mcp] Ingestor rejected event {msg}")
                    # Events the ingestor rejected individually are lost: count
                    # them, and name them to on_drop only when the response does.
                    partial = _failed_indices(response_body, len(events))
                    if partial is not None:
                        failed, indices = partial
                        if failed >= len(events):
                            self._record_drop(events, "rejected")
                        elif indices:
                            self._record_drop([events[i] for i in indices], "rejected")
                        else:
                            self._record_drop([], "rejected", count=failed)
                    # Check for kill signals from server
                    self._check_killed(response_body)
                    return
                if 400 <= status_code < 500 and status_code not in (408, 429):
                    details = "; ".join(_error_messages(response_body)[:5])
                    self.on_error(Exception(
                        f"Aforo returned {status_code} — not retrying" + (f": {details}" if details else "")
                    ))
                    self._record_drop(events, "rejected")
                    return
                if status_code == 429:
                    ra = _retry_after_s(retry_after)
                    if ra is not None:
                        delay = ra
                logger.warning(f"[aforo-mcp] Attempt {attempt}/3 failed: HTTP {status_code}")
                if attempt == 3:
                    self.on_error(Exception(
                        f"Aforo returned {status_code} after 3 attempts (dropped {len(events)} events)"
                    ))
            except Exception as e:
                if attempt == 3:
                    self.on_error(e)
                logger.warning(f"[aforo-mcp] Attempt {attempt}/3 failed: {e}")

            if attempt < 3:
                await asyncio.sleep(delay)

        # All 3 attempts failed (5xx or network error) -- the batch was already
        # removed from the buffer, so without this it vanishes silently.
        self._record_drop(events, "retry_exhausted")

    def _record_drop(
        self,
        events: List[Dict[str, Any]],
        reason: str,
        *,
        count: Optional[int] = None,
        detail: Optional[str] = None,
    ) -> None:
        """Account for permanently lost events: bump the counter, WARN-log, and
        invoke the opt-in on_drop hook (exceptions swallowed -- a hook bug must
        never break flushing). Reasons: ``retry_exhausted``, ``rejected``,
        ``invalid``. "invalid" logs are throttled (first, then every 1000th).
        ``count`` overrides ``len(events)`` when the ingestor reported rejected
        events without saying which ones."""
        n = len(events) if count is None else count
        if n <= 0:
            return
        self._dropped += n
        if reason == "invalid":
            self._invalid_drops += n
            if self._invalid_drops == 1 or self._invalid_drops % 1000 == 0:
                logger.warning(
                    f"[aforo-mcp] Invalid tool invocation not sent — {detail or 'client-side validation'} "
                    f"({self._dropped} total dropped)."
                )
        else:
            logger.warning(
                f"[aforo-mcp] Dropped {n} event(s) — {reason} ({self._dropped} total dropped)."
            )
        if self.on_drop is not None and events:
            try:
                self.on_drop(events, reason)
            except Exception:
                logger.debug("[aforo-mcp] on_drop hook raised", exc_info=True)

    @property
    def dropped_count(self) -> int:
        """Total events permanently dropped (failed batches, events the ingestor
        rejected, and invocations refused as invalid) since creation."""
        return self._dropped

    async def _do_post_with_body(self, url: str, headers: dict, body: str) -> tuple:
        """HTTP POST with best available async client.

        Returns ``(status_code, response_body, retry_after_header)``."""
        if HAS_AIOHTTP:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, headers=headers, data=body, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    resp_body = await resp.text()
                    return resp.status, resp_body, resp.headers.get("Retry-After")
        elif HAS_HTTPX:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(url, headers=headers, content=body)
                return resp.status_code, resp.text, resp.headers.get("Retry-After")
        else:
            import urllib.error
            import urllib.request
            req = urllib.request.Request(url, data=body.encode(), headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    resp_body = resp.read().decode()
                    return resp.status, resp_body, resp.headers.get("Retry-After")
            except urllib.error.HTTPError as e:
                try:
                    err_body = e.read().decode()
                except Exception:
                    err_body = ""
                return e.code, err_body, e.headers.get("Retry-After") if e.headers else None

    async def start(self) -> None:
        """Start the periodic flush background task."""
        self._running = True
        self._flush_task = asyncio.create_task(self._periodic_flush())

    async def _periodic_flush(self) -> None:
        while self._running:
            await asyncio.sleep(self.flush_interval_sec)
            try:
                await self.flush()
            except Exception as e:
                self.on_error(e)

    async def shutdown(self) -> None:
        """Stop heartbeats and the flush timer, flush remaining events."""
        self._stop_session()
        self._running = False
        if self._flush_task:
            self._flush_task.cancel()
            self._flush_task = None
        await self.flush()
