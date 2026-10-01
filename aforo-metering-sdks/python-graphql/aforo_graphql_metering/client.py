"""
Aforo GraphQL Billing Client — records every GraphQL operation with
AST-accurate complexity scoring, then ships to Aforo's usage ingestor.

Integration surfaces:
  - Strawberry extension (GraphQL over Starlette/FastAPI/ASGI)
  - ASGI middleware (for graphql-core, Graphene-over-ASGI, Ariadne)
  - Low-level record() for custom servers

Complexity scoring uses graphql-core's visit() on the parsed document:
  default score = field_count + 5 * max_depth
"""

from __future__ import annotations

import atexit
import hashlib
import json
import logging
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

try:
    from graphql import parse, Visitor, visit
    from graphql.language.ast import DocumentNode, FieldNode, OperationDefinitionNode
    HAS_GRAPHQL = True
except ImportError:  # pragma: no cover
    HAS_GRAPHQL = False
    DocumentNode = Any  # type: ignore
    OperationDefinitionNode = Any  # type: ignore

try:
    import httpx  # type: ignore
    HAS_HTTPX = True
except ImportError:  # pragma: no cover
    HAS_HTTPX = False

__version__ = "1.2.2"
logger = logging.getLogger("aforo_graphql_metering")

# POST /v1/ingest/batch takes 1..1000 events per request.
MAX_BATCH_EVENTS = 1000
MAX_CUSTOMER_ID_LEN = 64
MAX_IDEMPOTENCY_KEY_LEN = 255
MAX_GQL_OPERATION_NAME_LEN = 255


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
            "[aforo-graphql] %s taken from the request was longer than the ingestor's limit and was "
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


def _unwrap_envelope(payload):
    """The ingestor wraps every 2xx JSON body in ``{success, data, meta}``.

    Returns the inner ``data`` object when present, else the payload unchanged
    (bare shape).
    """
    if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
        return payload["data"]
    return payload


def _clip(value: Any) -> str:
    text = repr(value)
    return text if len(text) <= 80 else text[:77] + "..."


def _customer_id_problem(customer_id: Any) -> Optional[str]:
    """Why the ingestor would refuse this customerId, or None when it is usable."""
    if not isinstance(customer_id, str) or not customer_id.strip():
        return f"customerId is required (got {_clip(customer_id)})"
    if len(customer_id) > MAX_CUSTOMER_ID_LEN:
        return f"customerId exceeds {MAX_CUSTOMER_ID_LEN} chars (got {_clip(customer_id)})"
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


DEFAULT_PRODUCT_TYPE = "GRAPHQL_API"
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


@dataclass
class GraphQlUsageEvent:
    customerId: str
    metricName: str
    quantity: float
    occurredAt: str
    idempotencyKey: str
    productType: str
    gqlOperationType: str
    gqlOperationName: str
    gqlComplexity: int
    gqlFieldCount: int
    gqlHasErrors: bool
    dataBytes: int = 0
    executionDurationMs: int = 0
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


_MISSING = object()


def graphql_errors_present(errors: Any) -> bool:
    """True when a GraphQL ``errors`` value counts as "has errors".

    Errors are present when the value is not None and is not an empty list --
    so a non-list value (an object, a string, ``{}``) counts as present. This
    is the same rule every Aforo GraphQL SDK applies.
    """
    return errors is not None and not (isinstance(errors, list) and len(errors) == 0)


def _all_errors_pre_execution(errors: Any) -> bool:
    """True when every error is a request error (parse / validation).

    Per the GraphQL spec, errors raised while executing a field carry a
    ``path``; parse and validation errors don't. Only a non-empty list/tuple
    whose items all have a ``path`` attribute that is None/empty qualifies.
    """
    if not isinstance(errors, (list, tuple)) or not errors:
        return False
    for err in errors:
        path = getattr(err, "path", _MISSING)
        if path is _MISSING or path:
            return False
    return True


def outcome_from_graphql_result(result: Any) -> Optional[str]:
    """Derive an execution status from a GraphQL response.

    ``result`` is a response mapping (``{"data": ..., "errors": [...]}``) or an
    object with ``.data`` / ``.errors`` attributes (graphql-core / Strawberry
    ``ExecutionResult``). Per the GraphQL spec, ``data`` is absent when the
    request failed before execution (parse / validation) and null when it
    failed during execution:

      - no errors (see ``graphql_errors_present``) -> SUCCESS
      - errors, ``data`` not None                  -> PARTIAL
      - errors, ``data`` present and None          -> ERROR
      - errors, ``data`` absent                    -> VALIDATION_FAILED

    ``ExecutionResult`` objects always have a ``data`` attribute, so for them
    a request that never executed is recognised from the errors instead:
    ``data`` None and every error without a ``path`` (parse / validation
    errors carry none) -> VALIDATION_FAILED.

    Returns None when ``result`` is None, isn't a mapping / result object, or
    is a mapping with neither key, so nothing is guessed.
    """
    if result is None:
        return None
    if isinstance(result, dict):
        if "data" not in result and "errors" not in result:
            return None
        errors = result.get("errors")
        data = result.get("data", _MISSING)
    else:
        errors = getattr(result, "errors", _MISSING)
        data = getattr(result, "data", _MISSING)
        if errors is _MISSING and data is _MISSING:
            return None
        errors = None if errors is _MISSING else errors
        if data is None and _all_errors_pre_execution(errors):
            return "VALIDATION_FAILED"
    if not graphql_errors_present(errors):
        return "SUCCESS"
    if data is _MISSING:
        return "VALIDATION_FAILED"
    return "PARTIAL" if data is not None else "ERROR"


def outcome_from_http_status(status: Optional[int]) -> Optional[str]:
    """Derive an execution status from an HTTP status code alone.

    2xx/3xx -> SUCCESS; 408/504 -> TIMEOUT; 499 -> CANCELLED;
    400/422 -> VALIDATION_FAILED; 401/403/429 -> BLOCKED; any other 4xx/5xx
    -> ERROR; anything else (None, 1xx, out of range) -> None.
    """
    if not isinstance(status, int) or isinstance(status, bool):
        return None
    if status in (408, 504):
        return "TIMEOUT"
    if status == 499:
        return "CANCELLED"
    if status in (400, 422):
        return "VALIDATION_FAILED"
    if status in (401, 403, 429):
        return "BLOCKED"
    if 200 <= status < 400:
        return "SUCCESS"
    if 400 <= status < 600:
        return "ERROR"
    return None


def default_complexity_scorer(doc: "DocumentNode", operation_name: Optional[str] = None) -> Tuple[int, int]:
    """Score = field_count + 5 * max_depth. Returns (complexity, field_count)."""
    if not HAS_GRAPHQL:
        return 0, 0

    state = {"field_count": 0, "max_depth": 0, "depth": 0}

    class _Scorer(Visitor):
        def enter_field(self, *_args, **_kwargs):  # type: ignore[override]
            state["field_count"] += 1
            state["depth"] += 1
            if state["depth"] > state["max_depth"]:
                state["max_depth"] = state["depth"]

        def leave_field(self, *_args, **_kwargs):  # type: ignore[override]
            state["depth"] -= 1

    visit(doc, _Scorer())
    return state["field_count"] + 5 * state["max_depth"], state["field_count"]


class AforoGraphQlBilling:
    """Aforo GraphQL metering client. Thread-safe, buffered, retrying."""

    def __init__(
        self,
        tenant_id: str,
        product_id: str,
        api_key: str,
        ingestor_url: str,
        schema_version: Optional[str] = None,
        flush_interval_sec: float = 5.0,
        flush_count: int = 50,
        on_error: Optional[Callable[[Exception], None]] = None,
        customer_id_extractor: Optional[Callable[[Any], Optional[str]]] = None,
        complexity_scorer: Optional[Callable[["DocumentNode", Optional[str]], Tuple[int, int]]] = None,
        # New parameters are appended so pre-existing positional callers
        # (through complexity_scorer) keep their bindings. Pass on_drop and
        # product_type by keyword.
        on_drop: Optional[Callable[[List[Dict[str, Any]], str], None]] = None,
        product_type: str = DEFAULT_PRODUCT_TYPE,
    ):
        if not all([tenant_id, product_id, api_key, ingestor_url]):
            raise ValueError("tenant_id, product_id, api_key and ingestor_url are required")

        self.tenant_id = tenant_id
        self.product_id = product_id
        self.api_key = api_key
        self.ingestor_url = ingestor_url.rstrip("/")
        # Top-level productType on every event; record(product_type=...) overrides per call.
        self.product_type = _normalize_product_type(product_type, DEFAULT_PRODUCT_TYPE)
        self.schema_version = schema_version
        self.flush_interval_sec = flush_interval_sec
        self.flush_count = flush_count
        self.on_error = on_error or (lambda e: logger.error(f"[aforo-graphql] {e}"))
        # Opt-in hook receiving permanently dropped events (with their
        # idempotency keys — dedup-safe replay). Reasons: 'retry_exhausted'
        # (network/5xx/408/429 after 3 attempts) | 'rejected' (terminal 4xx,
        # or events the ingestor refused inside a 2xx partial response) |
        # 'invalid' (failed a client-side check; never buffered or sent).
        # Exceptions raised by the hook are swallowed.
        self.on_drop = on_drop
        self._dropped = 0
        self._drop_lock = threading.Lock()
        self._invalid_warned: set = set()
        self._truncation_warned: set = set()
        self.customer_id_extractor = customer_id_extractor or _default_customer_extractor
        self.complexity_scorer = complexity_scorer or default_complexity_scorer

        self._buffer: List[Dict[str, Any]] = []
        self._buffer_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._flush_thread = threading.Thread(target=self._flush_loop, daemon=True, name="aforo-graphql-flush")
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

    def record(
        self,
        customer_id: str,
        query: str,
        operation_name: Optional[str],
        duration_ms: int,
        has_errors: bool,
        response_bytes: int = 0,
        *,
        product_type: Optional[str] = None,
        execution_status: Optional[str] = None,
        result: Any = None,
        http_status: Optional[int] = None,
    ) -> None:
        """Buffer one GraphQL operation event.

        ``customer_id`` must be non-blank and at most 64 chars. An event that
        fails that check is not buffered or sent: it is counted in
        ``dropped_count``, logged at WARNING and handed to ``on_drop`` with
        reason ``"invalid"``. ``record`` does not raise for event content.
        ``product_type`` overrides the client default for this event.

        The operation name is read from ``query`` (the client's request). One
        longer than 255 characters is cut to 255 and the event is still sent;
        a WARNING is logged once per client.

        Keyword-only outcome inputs, used by OUTCOME_BASED pricing:
          - ``execution_status``: explicit value; trimmed and upper-cased,
            blank counts as unset. Always wins when set.
          - ``result``: the GraphQL response (mapping or ExecutionResult);
            see ``outcome_from_graphql_result``.
          - ``http_status``: used only when ``result`` gives nothing; see
            ``outcome_from_http_status``.
        With none of them the event goes out without a status. Accepted
        values: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED, FAILED,
        FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED -- any other value is logged and left off the event.
        """
        if not HAS_GRAPHQL:
            return
        invalid = _customer_id_problem(customer_id)
        try:
            doc = parse(query)
        except Exception:
            return

        op = _find_operation(doc, operation_name)
        if op is None:
            return

        complexity, field_count = self.complexity_scorer(doc, op.name.value if op.name else None)

        # The operation name comes from the client's query text. An over-long
        # one is cut to the ingestor's limit and the event is still sent. The
        # idempotency key is built from the full name, before the cut.
        operation_full = op.name.value if op.name else "anonymous"
        operation_label = _truncate_label(
            "gqlOperationName", operation_full, MAX_GQL_OPERATION_NAME_LEN, self._truncation_warned,
        )

        now = datetime.now(timezone.utc)
        ev = GraphQlUsageEvent(
            customerId=customer_id,
            metricName="graphql_api.operations",
            quantity=1,
            occurredAt=now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            idempotencyKey=_fit_idempotency_key(
                ["gql", self.tenant_id, self.product_id, operation_full,
                 int(now.timestamp() * 1000), uuid.uuid4().hex[:8]],
                (3,),
            ),
            productType=_normalize_product_type(product_type, self.product_type),
            gqlOperationType=op.operation.value.upper() if hasattr(op.operation, "value") else str(op.operation).upper(),
            gqlOperationName=operation_label,
            gqlComplexity=complexity,
            gqlFieldCount=field_count,
            gqlHasErrors=has_errors,
            dataBytes=response_bytes,
            executionDurationMs=duration_ms,
            metadata={
                "sdkVersion": __version__,
                "productId": self.product_id,
                **({"schemaVersion": self.schema_version} if self.schema_version else {}),
            },
            executionStatus=(
                normalize_execution_status(execution_status)
                or outcome_from_graphql_result(result)
                or outcome_from_http_status(http_status)
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
                    f"GraphQL metering flush rejected with HTTP {status}, not retrying "
                    f"(dropped {len(batch)} events)" + (": " + "; ".join(messages[:5]) if messages else "")
                ))
                return
            if status == 429 and retry_after:
                delay = _retry_after_seconds(retry_after, delay)
            if attempt < 2:
                time.sleep(delay)
        self._record_drop(batch, "retry_exhausted")
        self.on_error(RuntimeError(f"GraphQL metering flush failed after 3 attempts (dropped {len(batch)} events)"))

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
                "[aforo-graphql] Ingestor rejected %d event(s) it did not identify (%d total dropped).",
                unidentified, total,
            )
        self.on_error(RuntimeError(
            "GraphQL metering: ingestor rejected events: " + "; ".join(messages[:5])
            if messages else
            f"GraphQL metering: ingestor rejected {failed} event(s)"
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
            "[aforo-graphql] Dropped %d event(s) — %s (%d total dropped).",
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
            logger.warning("[aforo-graphql] Dropped invalid event: %s", message)
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


def _find_operation(doc: "DocumentNode", operation_name: Optional[str]) -> Optional["OperationDefinitionNode"]:
    if not HAS_GRAPHQL:
        return None
    ops = [d for d in doc.definitions if isinstance(d, OperationDefinitionNode)]
    if operation_name:
        for o in ops:
            if o.name and o.name.value == operation_name:
                return o
    return ops[0] if ops else None


def _resolve_explicit_status(resolver: Optional[Callable[[Any], Optional[str]]], arg: Any) -> Optional[str]:
    if resolver is None:
        return None
    try:
        return resolver(arg)
    except Exception:
        logger.debug("aforo-graphql: execution_status_resolver raised", exc_info=True)
        return None


def _default_customer_extractor(context: Any) -> Optional[str]:
    """Read 'x-customer-id' from request headers (Starlette/ASGI/Strawberry)."""
    try:
        # Strawberry passes an object with .request; ASGI dict contexts carry
        # "request" as a key. (The previous one-liner parsed as
        # `(... or ...) if isinstance(context, dict) else None`, so object
        # contexts never had their headers read.)
        if isinstance(context, dict):
            req = context.get("request")
        else:
            req = getattr(context, "request", None)
        if req is not None:
            v = req.headers.get("x-customer-id") if hasattr(req, "headers") else None
            if v:
                return v
        if isinstance(context, dict):
            v = context.get("x-customer-id") or context.get("customer_id")
            if isinstance(v, str):
                return v
    except Exception:  # a broken context must never break the operation
        logger.debug("[aforo-graphql] customer id extraction failed", exc_info=True)
    return None


# ── Strawberry extension ─────────────────────────────────────────

def strawberry_extension(
    billing: AforoGraphQlBilling,
    *,
    execution_status_resolver: Optional[Callable[[Any], Optional[str]]] = None,
):  # type: ignore[no-untyped-def]
    """
    Returns a Strawberry Extension class that meters every operation.

    The execution status is derived from the operation result (see
    ``outcome_from_graphql_result``). ``execution_status_resolver``
    (optional) is called with Strawberry's execution context; a non-blank
    return value is sent instead of the derived one.

    Usage:
        import strawberry
        from aforo_graphql_metering import AforoGraphQlBilling, strawberry_extension

        billing = AforoGraphQlBilling(...)
        schema = strawberry.Schema(query=Query, extensions=[strawberry_extension(billing)])
    """
    try:
        from strawberry.extensions import SchemaExtension  # type: ignore
    except ImportError as e:  # pragma: no cover
        raise RuntimeError(
            "strawberry-graphql is not installed — `pip install aforo-graphql-metering[strawberry]`."
        ) from e

    class AforoStrawberryExtension(SchemaExtension):  # type: ignore[misc]
        # on_operation wraps the whole request (parse, validate, execute).
        # Strawberry dropped on_request_start / on_request_end, so hooks with
        # those names are never called.
        def on_operation(self):
            start = time.monotonic()
            try:
                yield
            finally:
                self._record(int((time.monotonic() - start) * 1000))

        def _record(self, duration_ms: int) -> None:
            try:
                ctx = self.execution_context
                customer_id = billing.customer_id_extractor(ctx.context) if ctx.context else None
                if not customer_id:
                    return
                result = getattr(ctx, "result", None)
                billing.record(
                    customer_id=customer_id,
                    query=ctx.query or "",
                    operation_name=ctx.operation_name,
                    duration_ms=duration_ms,
                    has_errors=graphql_errors_present(getattr(result, "errors", None)),
                    execution_status=_resolve_explicit_status(execution_status_resolver, ctx),
                    result=result,
                )
            except Exception:
                logger.debug("aforo-graphql: extension error", exc_info=True)

    return AforoStrawberryExtension


# ── ASGI middleware ──────────────────────────────────────────────

# Largest response body the middleware keeps to read the GraphQL result
# for the execution status. Bigger (or compressed / non-JSON) responses fall
# back to the HTTP status code.
_MAX_RESULT_BODY_BYTES = 1024 * 1024


def asgi_middleware(
    billing: AforoGraphQlBilling,
    *,
    path: str = "/graphql",
    execution_status_resolver: Optional[Callable[[Any], Optional[str]]] = None,
):
    """
    ASGI middleware that meters POST requests to the configured GraphQL
    path. Works with any ASGI-native GraphQL server (graphql-core HTTP,
    Graphene-ASGI, Ariadne, custom).

    The execution status is derived from the JSON response body (see
    ``outcome_from_graphql_result``) when it is uncompressed and at most
    1 MiB, otherwise from the HTTP status (see ``outcome_from_http_status``).
    ``execution_status_resolver`` (optional) is called with the ASGI scope;
    a non-blank return value is sent instead of the derived one.

    Usage:
        from aforo_graphql_metering import asgi_middleware
        app = MyAsgiApp(...)
        app = asgi_middleware(billing, path="/graphql")(app)
    """

    def factory(app):
        async def mw(scope, receive, send):
            if scope["type"] != "http" or scope.get("path") != path or scope.get("method") != "POST":
                return await app(scope, receive, send)

            start = time.monotonic()
            body_chunks: List[bytes] = []

            async def recv_capture():
                msg = await receive()
                if msg.get("type") == "http.request" and msg.get("body"):
                    body_chunks.append(msg["body"])
                return msg

            status_holder = {"status": 200}
            resp_chunks: List[bytes] = []
            resp_state = {"size": 0, "keep": True}

            async def send_capture(message):
                if message.get("type") == "http.response.start":
                    status_holder["status"] = message.get("status", 200)
                    try:
                        for k, _v in message.get("headers") or []:
                            name = k if isinstance(k, (bytes, bytearray)) else str(k).encode("latin-1")
                            if bytes(name).lower() == b"content-encoding":
                                resp_state["keep"] = False
                    except Exception:
                        # Metering must never break the response; just skip the body.
                        resp_state["keep"] = False
                elif message.get("type") == "http.response.body" and resp_state["keep"]:
                    try:
                        chunk = bytes(message.get("body") or b"")
                        resp_state["size"] += len(chunk)
                        if resp_state["size"] > _MAX_RESULT_BODY_BYTES:
                            resp_state["keep"] = False
                            resp_chunks.clear()
                        elif chunk:
                            resp_chunks.append(chunk)
                    except Exception:
                        resp_state["keep"] = False
                        resp_chunks.clear()
                return await send(message)

            await app(scope, recv_capture, send_capture)

            try:
                raw = b"".join(body_chunks)
                if not raw:
                    return
                parsed = json.loads(raw.decode("utf-8"))
                query = parsed.get("query")
                if not query:
                    return
                # Build a minimal "context" — headers map for extractor
                headers_map = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
                customer_id = billing.customer_id_extractor({"request": _HeadersShim(headers_map)})
                if not customer_id:
                    return
                billing.record(
                    customer_id=customer_id,
                    query=query,
                    operation_name=parsed.get("operationName"),
                    duration_ms=int((time.monotonic() - start) * 1000),
                    has_errors=status_holder["status"] >= 400,
                    execution_status=_resolve_explicit_status(execution_status_resolver, scope),
                    result=_parse_result_body(resp_chunks) if resp_state["keep"] else None,
                    http_status=status_holder["status"],
                )
            except Exception:
                logger.debug("aforo-graphql: middleware error", exc_info=True)

        return mw

    return factory


def _parse_result_body(chunks: List[bytes]) -> Optional[Dict[str, Any]]:
    """Parse a captured response body as a GraphQL result; None if it isn't one."""
    if not chunks:
        return None
    try:
        parsed = json.loads(b"".join(chunks).decode("utf-8"))
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


class _HeadersShim:
    def __init__(self, headers: Dict[str, str]):
        self.headers = headers
