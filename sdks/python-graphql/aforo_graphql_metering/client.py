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

__version__ = "1.0.0"
logger = logging.getLogger("aforo_graphql_metering")


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
    ):
        if not all([tenant_id, product_id, api_key, ingestor_url]):
            raise ValueError("tenant_id, product_id, api_key and ingestor_url are required")

        self.tenant_id = tenant_id
        self.product_id = product_id
        self.api_key = api_key
        self.ingestor_url = ingestor_url.rstrip("/")
        self.schema_version = schema_version
        self.flush_interval_sec = flush_interval_sec
        self.flush_count = flush_count
        self.on_error = on_error or (lambda e: logger.error(f"[aforo-graphql] {e}"))
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
    ) -> None:
        if not customer_id or not HAS_GRAPHQL:
            return
        try:
            doc = parse(query)
        except Exception:
            return

        op = _find_operation(doc, operation_name)
        if op is None:
            return

        complexity, field_count = self.complexity_scorer(doc, op.name.value if op.name else None)

        now = datetime.now(timezone.utc)
        ev = GraphQlUsageEvent(
            customerId=customer_id,
            metricName="graphql_api.operations",
            quantity=1,
            occurredAt=now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            idempotencyKey=f"gql:{self.tenant_id}:{self.product_id}:{op.name.value if op.name else 'anonymous'}:{int(now.timestamp() * 1000)}:{uuid.uuid4().hex[:8]}",
            productType="GRAPHQL_API",
            gqlOperationType=op.operation.value.upper() if hasattr(op.operation, "value") else str(op.operation).upper(),
            gqlOperationName=op.name.value if op.name else "anonymous",
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
        )
        with self._buffer_lock:
            self._buffer.append(asdict(ev))
            if len(self._buffer) >= self.flush_count:
                threading.Thread(target=self._flush, daemon=True).start()

    def _flush_loop(self) -> None:
        while not self._stop_event.wait(self.flush_interval_sec):
            self._flush()

    def _flush(self) -> None:
        with self._buffer_lock:
            if not self._buffer:
                return
            batch = self._buffer
            self._buffer = []

        body = {"events": batch}
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "X-Tenant-Id": self.tenant_id,
        }
        url = f"{self.ingestor_url}/v1/ingest/events"

        for attempt in range(3):
            try:
                if HAS_HTTPX:
                    with httpx.Client(timeout=10.0) as c:
                        r = c.post(url, json=body, headers=headers)
                        if 200 <= r.status_code < 300:
                            return
                else:
                    import urllib.request
                    req = urllib.request.Request(
                        url, data=json.dumps(body).encode("utf-8"),
                        headers=headers, method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=10.0) as resp:
                        if 200 <= resp.status < 300:
                            return
            except Exception as e:
                if attempt == 2:
                    self.on_error(e)
                    return
            time.sleep(2 ** attempt)
        self.on_error(RuntimeError(f"GraphQL metering flush failed after 3 attempts (dropped {len(batch)} events)"))

    def shutdown(self) -> None:
        self._stop_event.set()
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


def _default_customer_extractor(context: Any) -> Optional[str]:
    """Read 'x-customer-id' from request headers (Starlette/ASGI/Strawberry)."""
    try:
        req = getattr(context, "request", None) or context.get("request") if isinstance(context, dict) else None
        if req is not None:
            v = req.headers.get("x-customer-id") if hasattr(req, "headers") else None
            if v:
                return v
        if isinstance(context, dict):
            v = context.get("x-customer-id") or context.get("customer_id")
            if isinstance(v, str):
                return v
    except Exception:
        pass
    return None


# ── Strawberry extension ─────────────────────────────────────────

def strawberry_extension(billing: AforoGraphQlBilling):  # type: ignore[no-untyped-def]
    """
    Returns a Strawberry Extension class that meters every operation.

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
        def on_request_start(self):
            self._start = time.monotonic()

        def on_request_end(self):
            try:
                ctx = self.execution_context
                customer_id = billing.customer_id_extractor(ctx.context) if ctx.context else None
                if not customer_id:
                    return
                errors = ctx.result.errors if ctx.result and getattr(ctx.result, "errors", None) else []
                billing.record(
                    customer_id=customer_id,
                    query=ctx.query or "",
                    operation_name=ctx.operation_name,
                    duration_ms=int((time.monotonic() - self._start) * 1000),
                    has_errors=bool(errors),
                )
            except Exception:
                logger.debug("aforo-graphql: extension error", exc_info=True)

    return AforoStrawberryExtension


# ── ASGI middleware ──────────────────────────────────────────────

def asgi_middleware(billing: AforoGraphQlBilling, *, path: str = "/graphql"):
    """
    ASGI middleware that meters POST requests to the configured GraphQL
    path. Works with any ASGI-native GraphQL server (graphql-core HTTP,
    Graphene-ASGI, Ariadne, custom).

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

            async def send_capture(message):
                if message.get("type") == "http.response.start":
                    status_holder["status"] = message.get("status", 200)
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
                )
            except Exception:
                logger.debug("aforo-graphql: middleware error", exc_info=True)

        return mw

    return factory


class _HeadersShim:
    def __init__(self, headers: Dict[str, str]):
        self.headers = headers
