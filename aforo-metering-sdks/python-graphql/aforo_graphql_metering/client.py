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

import asyncio
import hashlib
import json
import logging
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
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

from ._transport import (
    TransportCore,
    clean_customer_id,
    require_customer_source,
    truncate_utf16,
    utf16_length,
)
from ._transport import policy as _policy

__version__ = "2.1.0"
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


DEFAULT_PRODUCT_TYPE = "GRAPHQL_API"
def _normalize_product_type(product_type: Any, default: str) -> str:
    """Trim + uppercase. Unknown values pass through; the ingestor is the authority."""
    value = str(product_type).strip().upper() if product_type is not None else ""
    return value or default


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
    """GraphQL metering client: one bounded queue and one sender thread.

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
        schema_version: Optional[str] = None,
        flush_interval_sec: float = 5.0,
        flush_count: int = _policy.DEFAULT_FLUSH_COUNT,
        on_error: Optional[Callable[[Exception], None]] = None,
        customer_id_extractor: Optional[Callable[[Any], Optional[str]]] = None,
        complexity_scorer: Optional[Callable[["DocumentNode", Optional[str]], Tuple[int, int]]] = None,
        # New parameters are appended so pre-existing positional callers
        # (through complexity_scorer) keep their bindings. Pass on_drop and
        # product_type by keyword.
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
        resolver the integrations use (Strawberry: the execution context's
        ``context``; ASGI: ``{"request": <headers>, "scope": scope}``). Reading
        the ``x-customer-id`` header the caller sends needs
        ``trust_customer_header=True``."""
        if not all([tenant_id, product_id, api_key, ingestor_url]):
            raise ValueError("tenant_id, product_id, api_key and ingestor_url are required")

        self.tenant_id = tenant_id
        self.product_id = product_id
        # Top-level productType on every event; record(product_type=...) overrides per call.
        self.product_type = _normalize_product_type(product_type, DEFAULT_PRODUCT_TYPE)
        self.schema_version = schema_version
        self.customer_id_extractor = customer_id_extractor
        self.trust_customer_header = trust_customer_header
        self.complexity_scorer = complexity_scorer or default_complexity_scorer
        self._truncation_warned: set = set()
        self.on_error = on_error or (lambda e: logger.debug("[aforo-graphql] %s", e))
        # Thread pools the ASGI middlewares of this client parse and score
        # queries on (one per asgi_middleware() call); shut down with it.
        self._meter_executors: List[ThreadPoolExecutor] = []
        self._meter_executors_lock = threading.Lock()
        self._core = TransportCore(
            api_key=api_key,
            base_url=ingestor_url,
            user_agent=f"aforo-graphql-metering-python/{__version__}",
            name="aforo-graphql",
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
        document: Any = None,
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
        ``document`` (keyword-only): the already-parsed ``DocumentNode`` for
        ``query``, when your server has one; the query is then not parsed again.
        With none of them the event goes out without a status. Accepted
        values: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED, FAILED,
        FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED -- any other value is logged and left off the event.
        """
        if not HAS_GRAPHQL:
            return
        invalid = _customer_id_problem(customer_id)
        doc = document
        if doc is None:
            try:
                doc = parse(query)
            except Exception:
                logger.debug("[aforo-graphql] query does not parse; the operation is not metered", exc_info=True)
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
            self._core.report_drop([ev.to_dict()], "invalid", detail=invalid)
            return
        self._core.enqueue(ev.to_dict())

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
            logger.debug("[aforo-graphql] on_error hook raised", exc_info=True)

    def __repr__(self) -> str:
        return f"AforoGraphQlBilling(tenant_id={self.tenant_id!r}, ingestor_url={self.ingestor_url!r})"

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
        ``on_drop`` as ``"shutdown"``. Also runs at interpreter exit. The
        middleware's metering threads are shut down too; a request metered
        after this is counted as ``"closed"``."""
        with self._meter_executors_lock:
            executors = list(self._meter_executors)
        for executor in executors:
            executor.shutdown(wait=False)  # queued metering still runs and records
        self._core.close(timeout)

    def _new_meter_executor(self, workers: int) -> ThreadPoolExecutor:
        executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="aforo-graphql-meter")
        with self._meter_executors_lock:
            self._meter_executors.append(executor)
        return executor

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
    """``x-customer-id`` from the request headers (Starlette/ASGI/Strawberry).

    Only used with ``trust_customer_header=True``: the caller sets that header.
    """
    try:
        # Strawberry passes an object with .request; ASGI dict contexts carry
        # "request" as a key.
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


def _customer_lookup(billing: "AforoGraphQlBilling", customer_resolver: Optional[Callable[[Any], Optional[str]]],
                     trust_customer_header: Optional[bool], integration: str) -> Callable[[Any], Optional[str]]:
    """Per-operation customer lookup, or ValueError when there is no source."""
    resolver = customer_resolver if customer_resolver is not None else billing.customer_id_extractor
    trust = billing.trust_customer_header if trust_customer_header is None else trust_customer_header
    require_customer_source(resolver, trust, integration=integration,
                            untrusted_source="the x-customer-id request header")

    def lookup(context: Any) -> Optional[str]:
        try:
            if resolver is not None:
                return clean_customer_id(resolver(context))
            return clean_customer_id(_default_customer_extractor(context))
        except Exception:
            logger.warning("[aforo-graphql] customer resolver raised; the operation is not metered", exc_info=True)
            return None

    return lookup


# ── Strawberry extension ─────────────────────────────────────────

def strawberry_extension(
    billing: AforoGraphQlBilling,
    *,
    execution_status_resolver: Optional[Callable[[Any], Optional[str]]] = None,
    customer_resolver: Optional[Callable[[Any], Optional[str]]] = None,
    trust_customer_header: Optional[bool] = None,
):  # type: ignore[no-untyped-def]
    """
    Returns a Strawberry Extension class that meters every operation.

    The customer: ``customer_resolver(info_context)`` (Strawberry's
    ``context``, e.g. the user your auth dependency attached), or the billing
    client's ``customer_id_extractor``; ``trust_customer_header=True`` reads
    the ``x-customer-id`` header the caller sends instead. With neither this
    raises ValueError. An operation with no customer runs normally and is
    counted as an ``invalid`` drop. The document Strawberry already parsed is
    reused, so the query is not parsed twice.

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

    customer = _customer_lookup(billing, customer_resolver, trust_customer_header, "strawberry_extension")

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
                customer_id = customer(ctx.context) if ctx.context is not None else None
                if not customer_id:
                    billing.report_invalid("no customer for a GraphQL operation "
                                           "(the customer resolver returned nothing)")
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
                    document=getattr(ctx, "graphql_document", None),
                )
            except Exception:
                logger.debug("aforo-graphql: extension error", exc_info=True)

    return AforoStrawberryExtension


# ── ASGI middleware ──────────────────────────────────────────────

# Largest response body the middleware keeps to read the GraphQL result
# for the execution status. Bigger (or compressed / non-JSON) responses fall
# back to the HTTP status code.
_MAX_RESULT_BODY_BYTES = 1024 * 1024

#: Default cap on the request body the middleware keeps to read the query.
DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024


def asgi_middleware(
    billing: AforoGraphQlBilling,
    *,
    path: str = "/graphql",
    execution_status_resolver: Optional[Callable[[Any], Optional[str]]] = None,
    customer_resolver: Optional[Callable[[Any], Optional[str]]] = None,
    trust_customer_header: Optional[bool] = None,
    max_request_body_bytes: int = DEFAULT_MAX_REQUEST_BODY_BYTES,
    meter_workers: int = 2,
):
    """
    ASGI middleware that meters POST requests to the configured GraphQL
    path. Works with any ASGI-native GraphQL server (graphql-core HTTP,
    Graphene-ASGI, Ariadne, custom).

    The customer: ``customer_resolver(scope)`` (e.g. the user your auth
    middleware put on the scope), or the billing client's
    ``customer_id_extractor``; ``trust_customer_header=True`` reads the
    ``x-customer-id`` header instead (the caller controls it). With neither
    this raises ValueError. A request with no customer is served normally and
    counted as an ``invalid`` drop.

    The middleware keeps at most ``max_request_body_bytes`` of the request
    body (default 1 MiB) to read the query; a bigger request is served
    normally, not metered, and counted as ``invalid``. Reading the JSON,
    parsing the query and scoring it run on a small thread pool of
    ``meter_workers`` threads (default 2) owned by this middleware -- never
    on the event loop and never on the application's default executor. The
    pool is shut down by ``billing.shutdown()``.

    The execution status is derived from the JSON response body (see
    ``outcome_from_graphql_result``) when it is uncompressed and at most
    1 MiB, otherwise from the HTTP status (see ``outcome_from_http_status``).
    ``execution_status_resolver`` (optional) is called with the ASGI scope;
    a non-blank return value is sent instead of the derived one.

    Usage:
        from aforo_graphql_metering import asgi_middleware
        app = MyAsgiApp(...)
        app = asgi_middleware(billing, path="/graphql",
                              customer_resolver=lambda scope: scope["user"].customer_id)(app)
    """
    if isinstance(meter_workers, bool) or not isinstance(meter_workers, int) or meter_workers < 1:
        raise ValueError("asgi_middleware: meter_workers must be an integer >= 1")
    if customer_resolver is not None:
        scope_resolver = customer_resolver
        customer = _customer_lookup(billing, lambda ctx: scope_resolver(ctx["scope"]), None, "asgi_middleware")
    else:
        customer = _customer_lookup(billing, None, trust_customer_header, "asgi_middleware")
    executor = billing._new_meter_executor(meter_workers)

    def meter(scope: Any, raw: bytes, status: int, result: Any, duration_ms: int) -> None:
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            logger.debug("[aforo-graphql] request body is not JSON; not metered")
            return
        query = parsed.get("query") if isinstance(parsed, dict) else None
        if not query:
            return
        headers_map = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        customer_id = customer({"request": _HeadersShim(headers_map), "scope": scope})
        if not customer_id:
            billing.report_invalid("no customer for a GraphQL request (the customer resolver returned nothing)")
            return
        billing.record(
            customer_id=customer_id,
            query=query,
            operation_name=parsed.get("operationName"),
            duration_ms=duration_ms,
            has_errors=status >= 400,
            execution_status=_resolve_explicit_status(execution_status_resolver, scope),
            result=_parse_result_body(result) if result is not None else None,
            http_status=status,
        )

    def factory(app):
        async def mw(scope, receive, send):
            if scope["type"] != "http" or scope.get("path") != path or scope.get("method") != "POST":
                return await app(scope, receive, send)

            start = time.monotonic()
            body_chunks: List[bytes] = []
            req_state = {"size": 0, "over": False}

            async def recv_capture():
                msg = await receive()
                if msg.get("type") == "http.request" and msg.get("body") and not req_state["over"]:
                    chunk = msg["body"]
                    req_state["size"] += len(chunk)
                    if req_state["size"] > max_request_body_bytes:
                        req_state["over"] = True
                        body_chunks.clear()
                    else:
                        body_chunks.append(chunk)
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
                        logger.debug("[aforo-graphql] unreadable response headers", exc_info=True)
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
                        logger.debug("[aforo-graphql] unreadable response body", exc_info=True)
                        resp_state["keep"] = False
                        resp_chunks.clear()
                return await send(message)

            await app(scope, recv_capture, send_capture)

            if req_state["over"]:
                billing.report_invalid(
                    f"GraphQL request body over {max_request_body_bytes} bytes; not metered "
                    "(raise max_request_body_bytes to meter it)")
                return
            raw = b"".join(body_chunks)
            if not raw:
                return
            args = (scope, raw, status_holder["status"], resp_chunks if resp_state["keep"] else None,
                    int((time.monotonic() - start) * 1000))
            try:
                future = asyncio.get_running_loop().run_in_executor(executor, meter, *args)
            except RuntimeError:
                # billing.shutdown() closed the pool: meter here, so the event
                # is still counted (as "closed") rather than vanishing.
                try:
                    meter(*args)
                except Exception:
                    logger.debug("aforo-graphql: metering after shutdown failed", exc_info=True)
                return
            try:
                await future
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
