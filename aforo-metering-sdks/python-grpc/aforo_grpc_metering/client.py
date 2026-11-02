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

import hashlib
import inspect
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
    from grpc import aio as grpc_aio  # type: ignore
except ImportError:  # pragma: no cover
    grpc_aio = None  # type: ignore

from ._transport import (
    TransportCore,
    clean_customer_id,
    require_customer_source,
    truncate_utf16,
    utf16_length,
)
from ._transport import policy as _policy

__version__ = "2.1.0"
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


def _clip(value: Any) -> str:
    text = repr(value)
    return text if len(text) <= 80 else text[:77] + "..."


def _customer_id_problem(customer_id: Any) -> Optional[str]:
    """Why the ingestor would refuse this customerId, or None when it is usable."""
    if not isinstance(customer_id, str) or not customer_id.strip():
        return f"customerId is required (got {_clip(customer_id)})"
    if utf16_length(customer_id) > MAX_CUSTOMER_ID_LEN:
        return f"customerId exceeds {MAX_CUSTOMER_ID_LEN} chars (got {_clip(customer_id)})"
    return None


DEFAULT_PRODUCT_TYPE = "GRPC_API"
def _normalize_product_type(product_type: Any, default: str) -> str:
    """Trim + uppercase. Unknown values pass through; the ingestor is the authority."""
    value = str(product_type).strip().upper() if product_type is not None else ""
    return value or default


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
    """gRPC metering client: one bounded queue and one sender thread.

    ``record()`` only queues. One background thread sends batches every
    ``flush_interval_sec`` seconds or as soon as ``flush_count`` events are
    queued. During an ingest outage batches stay queued with the same
    idempotency keys and are retried after a pause. An event is lost only on
    queue overflow, a rejection by the ingestor, invalid input, the shutdown
    deadline, or ``record()`` after ``shutdown()`` -- each counted in
    ``dropped_count`` and passed to ``on_drop``. ``ingestor_url`` must be
    ``https://`` (plain ``http://`` only for localhost, or with
    ``allow_insecure_http=True``). ``shutdown()`` also runs at interpreter exit.
    """

    def __init__(
        self,
        tenant_id: str,
        product_id: str,
        api_key: str,
        ingestor_url: str,
        service_name: str,
        flush_interval_sec: float = 5.0,
        flush_count: int = _policy.DEFAULT_FLUSH_COUNT,
        on_error: Optional[Callable[[Exception], None]] = None,
        customer_id_extractor: Optional[Callable[[Any], Optional[str]]] = None,
        # New parameters are appended so pre-existing positional callers
        # (through customer_id_extractor) keep their bindings. Pass on_drop
        # and product_type by keyword.
        on_drop: Optional[Callable[[List[Dict[str, Any]], str], None]] = None,
        product_type: str = DEFAULT_PRODUCT_TYPE,
        *,
        max_queue_size: int = _policy.DEFAULT_QUEUE_CAPACITY,
        timeout_sec: float = _policy.REQUEST_TIMEOUT_S,
        shutdown_timeout_sec: float = _policy.SHUTDOWN_TIMEOUT_S,
        allow_insecure_http: bool = False,
        compression: str = "gzip",
        http_transport: Any = None,
        transport_options: Optional[Dict[str, Any]] = None,
        trust_customer_header: bool = False,
    ):
        """``customer_id_extractor(context) -> str | None`` is the customer
        resolver the interceptors use; it should read identity your service
        verified (an auth interceptor's result, a peer certificate). Reading the
        ``x-customer-id`` metadata the caller sends needs
        ``trust_customer_header=True``."""
        if not all([tenant_id, product_id, api_key, ingestor_url, service_name]):
            raise ValueError("tenant_id, product_id, api_key, ingestor_url and service_name are required")

        self.tenant_id = tenant_id
        self.product_id = product_id
        self.service_name = service_name
        # Top-level productType on every event; record(product_type=...) overrides per call.
        self.product_type = _normalize_product_type(product_type, DEFAULT_PRODUCT_TYPE)
        self.customer_id_extractor = customer_id_extractor
        self.trust_customer_header = trust_customer_header
        self._truncation_warned: set = set()
        self.on_error = on_error or (lambda e: logger.debug("[aforo-grpc] %s", e))
        self._core = TransportCore(
            api_key=api_key,
            base_url=ingestor_url,
            user_agent=f"aforo-grpc-metering-python/{__version__}",
            name="aforo-grpc",
            logger=logger,
            flush_count=flush_count,
            flush_interval=flush_interval_sec,
            max_queue_size=max_queue_size,
            timeout=timeout_sec,
            shutdown_timeout=shutdown_timeout_sec,
            allow_insecure_http=allow_insecure_http,
            compression=compression,
            on_drop=on_drop,
            on_error=self._safe_on_error,
            extra_headers={"X-Tenant-Id": tenant_id},
            http_transport=http_transport,
            **(transport_options or {}),
        )
        self.ingestor_url = self._core.url[: -len(_policy.INGEST_PATH)]
        self.flush_count = self._core.flush_count
        self.flush_interval_sec = flush_interval_sec

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
            self._core.report_drop([event.to_dict()], "invalid", detail=invalid)
            return
        self._core.enqueue(event.to_dict())

    # ── Flush machinery ──────────────────────────────────────────

    def dropped_count(self) -> int:
        """Total events permanently dropped (failed batches)."""
        with self._drop_lock:
            return self._dropped

    # ── Delivery (shared transport core) ─────────────────────────

    @property
    def on_drop(self) -> Optional[Callable[[List[Dict[str, Any]], str], None]]:
        """``on_drop(events, reason)``: events lost for good. Reasons:
        ``overflow``, ``rejected``, ``invalid``, ``shutdown``, ``closed``."""
        return self._core._on_drop

    @on_drop.setter
    def on_drop(self, hook: Optional[Callable[[List[Dict[str, Any]], str], None]]) -> None:
        self._core._on_drop = hook

    def _safe_on_error(self, exc: Exception) -> None:
        try:
            self.on_error(exc)
        except Exception:
            logger.debug("[aforo-grpc] on_error hook raised", exc_info=True)

    def __repr__(self) -> str:
        return f"AforoGrpcBilling(tenant_id={self.tenant_id!r}, ingestor_url={self.ingestor_url!r})"

    def flush(self, timeout: Optional[float] = None) -> int:
        """Ask the sender thread to send everything queued and wait for it.
        Returns the number of events still queued (non-zero while the
        ingestor is unreachable; they are retried after a pause)."""
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
        """Stop accepting events and flush for at most ``shutdown_timeout_sec``
        (or ``timeout``) seconds; what is still queued then is reported to
        ``on_drop`` as ``"shutdown"``. Also runs at interpreter exit."""
        self._core.close(timeout)

# ── gRPC server interceptors ────────────────────────────────────

def _customer_lookup(billing: "AforoGrpcBilling", customer_resolver: Optional[Callable[[Any], Optional[str]]],
                     trust_customer_header: Optional[bool], integration: str) -> Callable[[Any], Optional[str]]:
    """Per-call customer lookup, or ValueError when there is no source.

    ``customer_resolver`` (or the billing client's ``customer_id_extractor``)
    reads identity your service verified. Reading the ``x-customer-id``
    metadata -- which the caller sends -- needs ``trust_customer_header``.
    """
    resolver = customer_resolver if customer_resolver is not None else billing.customer_id_extractor
    trust = billing.trust_customer_header if trust_customer_header is None else trust_customer_header
    require_customer_source(resolver, trust, integration=integration,
                            untrusted_source="the x-customer-id gRPC metadata")

    def lookup(context: Any) -> Optional[str]:
        try:
            if resolver is not None:
                return clean_customer_id(resolver(context))
            return clean_customer_id(_default_customer_extractor(context))
        except Exception:
            logger.warning("[aforo-grpc] customer resolver raised; the call is not metered", exc_info=True)
            return None

    return lookup


def _call_type(handler: Any) -> str:
    if getattr(handler, "unary_unary", None):
        return "UNARY"
    if getattr(handler, "unary_stream", None):
        return "SERVER_STREAM"
    if getattr(handler, "stream_unary", None):
        return "CLIENT_STREAM"
    return "BIDI_STREAM"


def _method_name(handler_call_details: Any) -> str:
    method_full = handler_call_details.method  # "/pkg.Service/Method"
    parts = method_full.strip("/").split("/", 1)
    return parts[1] if len(parts) == 2 else method_full


def _status_from_exception(exc: BaseException) -> str:
    if grpc is not None and isinstance(exc, grpc.RpcError):
        code = exc.code() if hasattr(exc, "code") else None
        return GRPC_STATUS_LABELS.get(code.value[0] if code else 2, "UNKNOWN")
    if not isinstance(exc, Exception):  # cancelled / interrupted
        return "CANCELLED"
    return "INTERNAL"


class _CallMeter:
    """Records one event for one RPC, whatever its shape."""

    def __init__(self, billing: "AforoGrpcBilling", customer: Callable[[Any], Optional[str]],
                 status_resolver: Optional[Callable[[Any], Optional[str]]], method: str, call_type: str,
                 context: Any) -> None:
        self.billing = billing
        self.method = method
        self.call_type = call_type
        self.context = context
        self.customer_id = customer(context)
        self.status_resolver = status_resolver
        self.start = time.monotonic()
        self.messages = 0
        self.status = "OK"
        self.done = False

    def count(self) -> None:
        self.messages += 1

    def fail(self, exc: BaseException) -> None:
        self.status = _status_from_exception(exc)

    def finish(self) -> None:
        if self.done:
            return
        self.done = True
        # The status the server actually sent wins: context.abort() raises a
        # plain Exception (which would otherwise read as INTERNAL) and
        # set_code() + a normal return raises nothing.
        status = _context_status_label(self.context) or self.status
        if not self.customer_id:
            self.billing.report_invalid(f"no customer for gRPC call {self.method} "
                                        "(the customer resolver returned nothing)")
            return
        explicit: Optional[str] = None
        if self.status_resolver is not None:
            try:
                explicit = self.status_resolver(self.context)
            except Exception:
                logger.debug("aforo-grpc: execution_status_resolver raised", exc_info=True)
        self.billing.record(
            method=self.method,
            call_type=self.call_type,
            customer_id=self.customer_id,
            status=status,
            message_count=max(1, self.messages),
            duration_ms=int((time.monotonic() - self.start) * 1000),
            execution_status=explicit,
        )


class AforoGrpcInterceptor(grpc.ServerInterceptor if grpc is not None else object):  # type: ignore[misc]
    """
    Meters every RPC on a ``grpc.server``: unary-unary, server streaming,
    client streaming and bidirectional streaming. A streaming call is one
    event when it ends, with ``messageCount`` = request messages read plus
    response messages sent (at least 1).

    The customer: ``customer_resolver(context)`` here, or the billing
    client's ``customer_id_extractor``; ``trust_customer_header=True`` reads
    the ``x-customer-id`` metadata the caller sends instead. With neither,
    construction raises ValueError. A call with no customer is served
    normally and counted as an ``invalid`` drop.

    Example:
        interceptor = AforoGrpcInterceptor(billing, customer_resolver=lambda ctx: ctx.auth_context()...)
        server = grpc.server(executor, interceptors=[interceptor])

    For ``grpc.aio`` servers use :class:`AforoAioGrpcInterceptor`.
    """

    def __init__(
        self,
        billing: AforoGrpcBilling,
        *,
        execution_status_resolver: Optional[Callable[[Any], Optional[str]]] = None,
        customer_resolver: Optional[Callable[[Any], Optional[str]]] = None,
        trust_customer_header: Optional[bool] = None,
    ):
        """``execution_status_resolver`` (optional) is called with the gRPC
        context after the handler finishes; a non-blank return value is sent
        as the event's execution status instead of the one derived from the
        gRPC status code. Exceptions it raises are logged and ignored."""
        if grpc is None:
            raise RuntimeError("grpcio is not installed — install with `pip install grpcio`.")
        self.billing = billing
        self.execution_status_resolver = execution_status_resolver
        self._customer = _customer_lookup(billing, customer_resolver, trust_customer_header,
                                          "AforoGrpcInterceptor")

    def _meter(self, method: str, call_type: str, context: Any) -> _CallMeter:
        return _CallMeter(self.billing, self._customer, self.execution_status_resolver, method, call_type, context)

    def intercept_service(self, continuation, handler_call_details):  # type: ignore[override]
        handler = continuation(handler_call_details)
        if handler is None:
            return handler
        method = _method_name(handler_call_details)
        call_type = _call_type(handler)
        kwargs = {"request_deserializer": handler.request_deserializer,
                  "response_serializer": handler.response_serializer}

        if handler.unary_unary:
            def unary_unary(request, context):  # type: ignore[no-untyped-def]
                meter = self._meter(method, call_type, context)
                try:
                    return handler.unary_unary(request, context)
                except BaseException as exc:
                    meter.fail(exc)
                    raise
                finally:
                    meter.finish()
            return grpc.unary_unary_rpc_method_handler(unary_unary, **kwargs)

        if handler.unary_stream:
            def unary_stream(request, context):  # type: ignore[no-untyped-def]
                meter = self._meter(method, call_type, context)
                meter.count()
                try:
                    for response in handler.unary_stream(request, context):
                        meter.count()
                        yield response
                except BaseException as exc:
                    meter.fail(exc)
                    raise
                finally:
                    meter.finish()
            return grpc.unary_stream_rpc_method_handler(unary_stream, **kwargs)

        if handler.stream_unary:
            def stream_unary(request_iterator, context):  # type: ignore[no-untyped-def]
                meter = self._meter(method, call_type, context)
                try:
                    response = handler.stream_unary(_counting(request_iterator, meter), context)
                    meter.count()
                    return response
                except BaseException as exc:
                    meter.fail(exc)
                    raise
                finally:
                    meter.finish()
            return grpc.stream_unary_rpc_method_handler(stream_unary, **kwargs)

        def stream_stream(request_iterator, context):  # type: ignore[no-untyped-def]
            meter = self._meter(method, call_type, context)
            try:
                for response in handler.stream_stream(_counting(request_iterator, meter), context):
                    meter.count()
                    yield response
            except BaseException as exc:
                meter.fail(exc)
                raise
            finally:
                meter.finish()
        return grpc.stream_stream_rpc_method_handler(stream_stream, **kwargs)


def _counting(iterator: Any, meter: _CallMeter) -> Any:
    for item in iterator:
        meter.count()
        yield item


async def _acounting(iterator: Any, meter: _CallMeter) -> Any:
    async for item in iterator:
        meter.count()
        yield item


if grpc_aio is not None:
    _AioBase: Any = grpc_aio.ServerInterceptor
else:  # pragma: no cover
    _AioBase = object


class AforoAioGrpcInterceptor(_AioBase):  # type: ignore[misc,valid-type]
    """The same metering for ``grpc.aio`` servers, all four RPC shapes::

        server = grpc.aio.server(interceptors=[AforoAioGrpcInterceptor(billing, customer_resolver=...)])

    ``record()`` only queues, so the interceptor never blocks the event loop.
    """

    def __init__(
        self,
        billing: AforoGrpcBilling,
        *,
        execution_status_resolver: Optional[Callable[[Any], Optional[str]]] = None,
        customer_resolver: Optional[Callable[[Any], Optional[str]]] = None,
        trust_customer_header: Optional[bool] = None,
    ):
        if grpc is None or grpc_aio is None:
            raise RuntimeError("grpcio with grpc.aio is required — install with `pip install grpcio`.")
        self.billing = billing
        self.execution_status_resolver = execution_status_resolver
        self._customer = _customer_lookup(billing, customer_resolver, trust_customer_header,
                                          "AforoAioGrpcInterceptor")

    def _meter(self, method: str, call_type: str, context: Any) -> _CallMeter:
        return _CallMeter(self.billing, self._customer, self.execution_status_resolver, method, call_type, context)

    async def intercept_service(self, continuation, handler_call_details):  # type: ignore[override]
        handler = await continuation(handler_call_details)
        if handler is None:
            return handler
        method = _method_name(handler_call_details)
        call_type = _call_type(handler)
        kwargs = {"request_deserializer": handler.request_deserializer,
                  "response_serializer": handler.response_serializer}

        if handler.unary_unary:
            async def unary_unary(request, context):  # type: ignore[no-untyped-def]
                meter = self._meter(method, call_type, context)
                try:
                    result = handler.unary_unary(request, context)
                    return await result if inspect.isawaitable(result) else result
                except BaseException as exc:
                    meter.fail(exc)
                    raise
                finally:
                    meter.finish()
            return grpc.unary_unary_rpc_method_handler(unary_unary, **kwargs)

        if handler.unary_stream:
            async def unary_stream(request, context):  # type: ignore[no-untyped-def]
                meter = self._meter(method, call_type, context)
                meter.count()
                try:
                    result = handler.unary_stream(request, context)
                    if inspect.isasyncgen(result):
                        async for response in result:
                            meter.count()
                            yield response
                    elif inspect.isawaitable(result):  # writes with context.write()
                        await result
                    else:
                        for response in result:
                            meter.count()
                            yield response
                except BaseException as exc:
                    meter.fail(exc)
                    raise
                finally:
                    meter.finish()
            return grpc.unary_stream_rpc_method_handler(unary_stream, **kwargs)

        if handler.stream_unary:
            async def stream_unary(request_iterator, context):  # type: ignore[no-untyped-def]
                meter = self._meter(method, call_type, context)
                try:
                    result = handler.stream_unary(_acounting(request_iterator, meter), context)
                    response = await result if inspect.isawaitable(result) else result
                    meter.count()
                    return response
                except BaseException as exc:
                    meter.fail(exc)
                    raise
                finally:
                    meter.finish()
            return grpc.stream_unary_rpc_method_handler(stream_unary, **kwargs)

        async def stream_stream(request_iterator, context):  # type: ignore[no-untyped-def]
            meter = self._meter(method, call_type, context)
            try:
                result = handler.stream_stream(_acounting(request_iterator, meter), context)
                if inspect.isasyncgen(result):
                    async for response in result:
                        meter.count()
                        yield response
                elif inspect.isawaitable(result):
                    await result
                else:
                    for response in result:
                        meter.count()
                        yield response
            except BaseException as exc:
                meter.fail(exc)
                raise
            finally:
                meter.finish()
        return grpc.stream_stream_rpc_method_handler(stream_stream, **kwargs)


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
        logger.debug("[aforo-grpc] context.code() raised; using the status from the handler", exc_info=True)
        return None
    if not isinstance(code, grpc.StatusCode):
        return None
    return GRPC_STATUS_LABELS.get(code.value[0], "UNKNOWN")


def _default_customer_extractor(context: Any) -> Optional[str]:
    """``x-customer-id`` from the invocation metadata (only used with
    ``trust_customer_header=True``: the caller sets it)."""
    try:
        md = dict(context.invocation_metadata())
        v = md.get("x-customer-id")
        return v if isinstance(v, str) else None
    except Exception:
        logger.debug("[aforo-grpc] could not read invocation metadata", exc_info=True)
        return None
