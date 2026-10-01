"""
Aforo gRPC Billing Client — meters every RPC call with unary/streaming
awareness, maps gRPC status codes to descriptor enum labels, and ships
events in buffered batches to Aforo's usage ingestor.

Exposes:
  - AforoGrpcBilling:    top-level client with record() + shutdown()
  - AforoGrpcInterceptor: grpc.ServerInterceptor for automatic wiring

Sync interceptor works with grpc.server (threading-based). Async support
via aiohttp / httpx is picked up automatically when those extras are
installed.
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
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

try:
    import grpc
except ImportError:  # pragma: no cover
    grpc = None  # type: ignore

try:
    import aiohttp  # type: ignore
    HAS_AIOHTTP = True
except ImportError:  # pragma: no cover
    HAS_AIOHTTP = False

try:
    import httpx  # type: ignore
    HAS_HTTPX = True
except ImportError:  # pragma: no cover
    HAS_HTTPX = False

__version__ = "1.2.2"
logger = logging.getLogger("aforo_grpc_metering")

# POST /v1/ingest/batch takes 1..1000 events per request.
MAX_BATCH_EVENTS = 1000
MAX_CUSTOMER_ID_LEN = 64
MAX_IDEMPOTENCY_KEY_LEN = 255
MAX_GRPC_METHOD_LEN = 128


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
            "[aforo-grpc] %s taken from the request was longer than the ingestor's limit and was "
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


DEFAULT_PRODUCT_TYPE = "GRPC_API"
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


GRPC_STATUS_LABELS: Dict[int, str] = {
    0: "OK", 1: "CANCELLED", 2: "UNKNOWN", 3: "INVALID_ARGUMENT",
    4: "DEADLINE_EXCEEDED", 5: "NOT_FOUND", 6: "ALREADY_EXISTS",
    7: "PERMISSION_DENIED", 8: "RESOURCE_EXHAUSTED", 9: "FAILED_PRECONDITION",
    10: "ABORTED", 11: "OUT_OF_RANGE", 12: "UNIMPLEMENTED",
    13: "INTERNAL", 14: "UNAVAILABLE", 15: "DATA_LOSS", 16: "UNAUTHENTICATED",
}

# gRPC status code -> execution status (the outcome OUTCOME_BASED pricing
# bills by). Same table the gateway plugins use (decided 2026-09-30); every
# code not listed here maps to ERROR.
_GRPC_OUTCOMES: Dict[str, str] = {
    "OK": "SUCCESS",
    "CANCELLED": "CANCELLED",
    "INVALID_ARGUMENT": "VALIDATION_FAILED",
    "FAILED_PRECONDITION": "VALIDATION_FAILED",
    "OUT_OF_RANGE": "VALIDATION_FAILED",
    "DEADLINE_EXCEEDED": "TIMEOUT",
    "PERMISSION_DENIED": "BLOCKED",
    "RESOURCE_EXHAUSTED": "BLOCKED",
    "UNAUTHENTICATED": "BLOCKED",
}
_GRPC_LABEL_TO_CODE: Dict[str, int] = {v: k for k, v in GRPC_STATUS_LABELS.items()}


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


def outcome_from_grpc_status(status: Union["grpc.StatusCode", int, str, None]) -> Optional[str]:
    """Map a gRPC status to an execution status.

    Accepts a ``grpc.StatusCode``, its integer value, or its name (e.g.
    ``"DEADLINE_EXCEEDED"``, case-insensitive). OK -> SUCCESS;
    CANCELLED -> CANCELLED; INVALID_ARGUMENT / FAILED_PRECONDITION /
    OUT_OF_RANGE -> VALIDATION_FAILED; DEADLINE_EXCEEDED -> TIMEOUT;
    PERMISSION_DENIED / RESOURCE_EXHAUSTED / UNAUTHENTICATED -> BLOCKED;
    any other code -> ERROR. Returns None when the input isn't a
    recognizable status (None, a bool, or an unknown name), so the event
    goes out without a status rather than with a guessed one.
    """
    code: Optional[int] = None
    if status is None or isinstance(status, bool):
        return None
    if grpc is not None and isinstance(status, grpc.StatusCode):
        code = status.value[0]
    elif isinstance(status, int):
        code = status
    elif isinstance(status, str):
        name = status.strip().upper()
        if name.isdigit():
            code = int(name)
        elif name in _GRPC_LABEL_TO_CODE:
            code = _GRPC_LABEL_TO_CODE[name]
        else:
            return None
    else:
        return None
    return _GRPC_OUTCOMES.get(GRPC_STATUS_LABELS.get(code, ""), "ERROR")


GRPC_CALL_TYPES = ("UNARY", "CLIENT_STREAM", "SERVER_STREAM", "BIDI_STREAM")


def _status_label(status: Any) -> str:
    """Normalise a status (int code or label) to one of the ingestor's grpcStatusCode values."""
    if isinstance(status, int):
        return GRPC_STATUS_LABELS.get(status, "UNKNOWN")
    label = str(status or "").upper()
    return label if label in GRPC_STATUS_LABELS.values() else "UNKNOWN"


@dataclass
class GrpcUsageEvent:
    customerId: str
    metricName: str
    quantity: float
    occurredAt: str
    idempotencyKey: str
    productType: str
    grpcService: str
    grpcMethod: str
    grpcStatusCode: str
    grpcCallType: str  # UNARY | CLIENT_STREAM | SERVER_STREAM | BIDI_STREAM
    messageCount: int = 1
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


class AforoGrpcBilling:
    """Aforo gRPC metering client. Thread-safe, buffered, retrying."""

    def __init__(
        self,
        tenant_id: str,
        product_id: str,
        api_key: str,
        ingestor_url: str,
        service_name: str,
        flush_interval_sec: float = 5.0,
        flush_count: int = 50,
        on_error: Optional[Callable[[Exception], None]] = None,
        customer_id_extractor: Optional[Callable[[Any], Optional[str]]] = None,
        # New parameters are appended so pre-existing positional callers
        # (through customer_id_extractor) keep their bindings. Pass on_drop
        # and product_type by keyword.
        on_drop: Optional[Callable[[List[Dict[str, Any]], str], None]] = None,
        product_type: str = DEFAULT_PRODUCT_TYPE,
    ):
        if not all([tenant_id, product_id, api_key, ingestor_url, service_name]):
            raise ValueError("tenant_id, product_id, api_key, ingestor_url and service_name are required")

        self.tenant_id = tenant_id
        self.product_id = product_id
        self.api_key = api_key
        self.ingestor_url = ingestor_url.rstrip("/")
        self.service_name = service_name
        # Top-level productType on every event; record(product_type=...) overrides per call.
        self.product_type = _normalize_product_type(product_type, DEFAULT_PRODUCT_TYPE)
        self.flush_interval_sec = flush_interval_sec
        self.flush_count = flush_count
        self.on_error = on_error or (lambda e: logger.error(f"[aforo-grpc] {e}"))
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

        self._buffer: List[Dict[str, Any]] = []
        self._buffer_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._flush_thread = threading.Thread(target=self._flush_loop, daemon=True, name="aforo-grpc-flush")
        self._flush_thread.start()

        # Safety net for normal interpreter exit. The flush thread is a
        # daemon (so it won't block process exit), which historically meant
        # any in-flight events at exit were dropped unless the user
        # explicitly called shutdown(). atexit covers the common case
        # where the user forgets — does NOT cover SIGKILL or os._exit().
        # Idempotent: shutdown() is safe to call twice (the stop event
        # is already set, the buffer drains to empty).
        atexit.register(self._safe_shutdown)

    def _safe_shutdown(self) -> None:
        """atexit-safe wrapper around shutdown(). Swallows exceptions
        so a misbehaving flush during interpreter shutdown can't break
        other atexit handlers."""
        try:
            if not self._stop_event.is_set():
                self.shutdown()
        except Exception:
            pass

    # ── Recording ────────────────────────────────────────────────

    def record(
        self,
        method: str,
        call_type: str,
        customer_id: str,
        status: str,
        message_count: int,
        duration_ms: int,
        data_bytes: int = 0,
        *,
        product_type: Optional[str] = None,
        execution_status: Optional[str] = None,
    ) -> None:
        """Buffer one RPC event.

        ``customer_id`` (non-blank, at most 64 chars) and ``method`` (non-blank)
        are required. An event that fails those checks is not buffered or sent:
        it is counted in ``dropped_count``, logged at WARNING and handed to
        ``on_drop`` with reason ``"invalid"``. ``record`` does not raise for
        event content.

        ``status`` is a ``grpc.StatusCode``, its integer value or its name.
        ``product_type`` overrides the client default for this event.

        ``execution_status`` (keyword-only) is the optional outcome used by
        OUTCOME_BASED pricing. It is trimmed and upper-cased; blank counts as
        unset. When unset, it is derived from ``status`` via
        ``outcome_from_grpc_status``; when that isn't possible the event goes
        out without one. Accepted values: SUCCESS, PARTIAL, TIMEOUT, ERROR,
        VALIDATION_FAILED, FAILED, FAILURE, CANCELLED, PENDING, BLOCKED,
        HITL_REQUIRED -- any other value is logged and left off the event.

        ``method`` is the RPC name from the client's request. One longer than
        128 characters is cut to 128 and the event is still sent (a WARNING is
        logged once per client); the idempotency key is built from the full
        name.
        """
        invalid = _customer_id_problem(customer_id)
        if invalid is None and (not isinstance(method, str) or not method.strip()):
            # grpcService + grpcMethod are required on GRPC_API events.
            invalid = f"grpcMethod is required (got {_clip(method)})"
        # Accept a grpc.StatusCode enum as well as its name or integer value:
        # the enum isn't JSON-serializable, and one unserializable event used
        # to fail the whole batch's flush.
        if not isinstance(status, (str, int)) or isinstance(status, bool):
            status = getattr(status, "name", None) or str(status)
        call_type = str(call_type or "").upper()
        if call_type not in GRPC_CALL_TYPES:
            call_type = "UNARY"
        # The method name originates from the client's request: cut an over-long
        # one to the ingestor's limit instead of losing the event. The key
        # below is built from the full name.
        method_label = _truncate_label("grpcMethod", method, MAX_GRPC_METHOD_LEN, self._truncation_warned)
        now = datetime.now(timezone.utc)
        event = GrpcUsageEvent(
            customerId=customer_id,
            metricName="grpc_api.rpc_calls",
            quantity=1,
            occurredAt=now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            idempotencyKey=_fit_idempotency_key(
                ["grpc", self.tenant_id, self.service_name, method,
                 int(now.timestamp() * 1000), uuid.uuid4().hex[:8]],
                (3,),
            ),
            productType=_normalize_product_type(product_type, self.product_type),
            grpcService=self.service_name,
            grpcMethod=method_label,
            grpcStatusCode=_status_label(status),
            grpcCallType=call_type,
            messageCount=message_count,
            dataBytes=data_bytes,
            executionDurationMs=duration_ms,
            metadata={"sdkVersion": __version__, "productId": self.product_id},
            executionStatus=normalize_execution_status(execution_status) or outcome_from_grpc_status(status),
        )
        if invalid is not None:
            self._record_invalid(event.to_dict(), invalid)
            return
        with self._buffer_lock:
            self._buffer.append(event.to_dict())
            if len(self._buffer) >= self.flush_count:
                threading.Thread(target=self._flush, daemon=True).start()

    # ── Flush machinery ──────────────────────────────────────────

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
                    f"gRPC metering flush rejected with HTTP {status}, not retrying "
                    f"(dropped {len(batch)} events)" + (": " + "; ".join(messages[:5]) if messages else "")
                ))
                return
            if status == 429 and retry_after:
                delay = _retry_after_seconds(retry_after, delay)
            if attempt < 2:
                time.sleep(delay)
        self._record_drop(batch, "retry_exhausted")
        self.on_error(RuntimeError(f"gRPC metering flush failed after 3 attempts (dropped {len(batch)} events)"))

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
                "[aforo-grpc] Ingestor rejected %d event(s) it did not identify (%d total dropped).",
                unidentified, total,
            )
        self.on_error(RuntimeError(
            "gRPC metering: ingestor rejected events: " + "; ".join(messages[:5])
            if messages else
            f"gRPC metering: ingestor rejected {failed} event(s)"
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
            "[aforo-grpc] Dropped %d event(s) — %s (%d total dropped).",
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
            logger.warning("[aforo-grpc] Dropped invalid event: %s", message)
        if self.on_drop is not None:
            try:
                self.on_drop([event], "invalid")
            except Exception:
                logger.debug("on_drop hook raised", exc_info=True)

    def shutdown(self) -> None:
        """Flush pending events and stop the background flush thread."""
        self._stop_event.set()
        # Deregister so repeated create/shutdown cycles don't accumulate
        # atexit handlers (which also pin the client from GC). Safe no-op
        # if called FROM the atexit handler itself.
        atexit.unregister(self._safe_shutdown)
        self._flush()
        if self._flush_thread.is_alive():
            self._flush_thread.join(timeout=5.0)


# ── gRPC ServerInterceptor ──────────────────────────────────────

class AforoGrpcInterceptor(grpc.ServerInterceptor if grpc is not None else object):  # type: ignore[misc]
    """
    Install on a grpc.server to automatically meter all unary-unary calls.

    Streaming RPCs (server/client/bidi) require wrapping the handler
    directly — use billing.record() from inside the handler for those.

    Example:
        interceptor = AforoGrpcInterceptor(billing)
        server = grpc.server(executor, interceptors=[interceptor])
    """

    def __init__(
        self,
        billing: AforoGrpcBilling,
        *,
        execution_status_resolver: Optional[Callable[[Any], Optional[str]]] = None,
    ):
        """``execution_status_resolver`` (optional) is called with the gRPC
        context after the handler finishes; a non-blank return value is sent
        as the event's execution status instead of the one derived from the
        gRPC status code. Exceptions it raises are logged and ignored."""
        if grpc is None:
            raise RuntimeError("grpcio is not installed — install with `pip install grpcio`.")
        self.billing = billing
        self.execution_status_resolver = execution_status_resolver

    def intercept_service(self, continuation, handler_call_details):  # type: ignore[override]
        method_full = handler_call_details.method  # "/pkg.Service/Method"
        parts = method_full.strip("/").split("/", 1)
        method_name = parts[1] if len(parts) == 2 else method_full
        handler = continuation(handler_call_details)
        if handler is None or not handler.unary_unary:
            return handler

        billing = self.billing
        resolver = self.execution_status_resolver

        def new_behaviour(request, context):  # type: ignore[no-untyped-def]
            start = time.monotonic()
            customer_id = billing.customer_id_extractor(context)
            status_label = "OK"
            try:
                response = handler.unary_unary(request, context)
                return response
            except grpc.RpcError as e:  # pragma: no cover — executes under a real gRPC error
                code = e.code() if hasattr(e, "code") else None
                status_label = GRPC_STATUS_LABELS.get(code.value[0] if code else 2, "UNKNOWN")
                raise
            except Exception:
                status_label = "INTERNAL"
                raise
            finally:
                # The status the server actually sent wins: context.abort()
                # raises a plain Exception (which would otherwise read as
                # INTERNAL) and set_code() + a normal return raises nothing.
                status_label = _context_status_label(context) or status_label
                duration_ms = int((time.monotonic() - start) * 1000)
                if customer_id:
                    explicit_status: Optional[str] = None
                    if resolver is not None:
                        try:
                            explicit_status = resolver(context)
                        except Exception:
                            logger.debug("aforo-grpc: execution_status_resolver raised", exc_info=True)
                    billing.record(
                        method=method_name,
                        call_type="UNARY",
                        customer_id=customer_id,
                        status=status_label,
                        message_count=1,
                        duration_ms=duration_ms,
                        execution_status=explicit_status,
                    )

        # Return a new unary_unary handler with our behaviour.
        return grpc.unary_unary_rpc_method_handler(
            new_behaviour,
            request_deserializer=handler.request_deserializer,
            response_serializer=handler.response_serializer,
        )


# ── Helpers ──────────────────────────────────────────────────────

def _context_status_label(context: Any) -> Optional[str]:
    """Status code set on the servicer context, as a label ("PERMISSION_DENIED").

    ``ServicerContext.code()`` exists from grpcio 1.38 and returns the code set
    by ``abort()`` / ``set_code()`` (None when neither was called). Returns
    None when the getter is missing, raises, or returns anything that is not a
    ``grpc.StatusCode`` (older grpcio, test doubles), so the caller falls back
    to the status derived from the handler's exception.
    """
    if grpc is None:
        return None
    code_fn = getattr(context, "code", None)
    if not callable(code_fn):
        return None
    try:
        code = code_fn()
    except Exception:
        return None
    if not isinstance(code, grpc.StatusCode):
        return None
    return GRPC_STATUS_LABELS.get(code.value[0], "UNKNOWN")


def _default_customer_extractor(context: Any) -> Optional[str]:
    """Read 'x-customer-id' from gRPC invocation metadata."""
    try:
        md = dict(context.invocation_metadata())
        v = md.get("x-customer-id")
        return v if isinstance(v, str) else None
    except Exception:
        return None
