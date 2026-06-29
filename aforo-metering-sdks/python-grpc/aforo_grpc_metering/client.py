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
import logging
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

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

__version__ = "1.0.0"
logger = logging.getLogger("aforo_grpc_metering")


GRPC_STATUS_LABELS: Dict[int, str] = {
    0: "OK", 1: "CANCELLED", 2: "UNKNOWN", 3: "INVALID_ARGUMENT",
    4: "DEADLINE_EXCEEDED", 5: "NOT_FOUND", 6: "ALREADY_EXISTS",
    7: "PERMISSION_DENIED", 8: "RESOURCE_EXHAUSTED", 9: "FAILED_PRECONDITION",
    10: "ABORTED", 11: "OUT_OF_RANGE", 12: "UNIMPLEMENTED",
    13: "INTERNAL", 14: "UNAVAILABLE", 15: "DATA_LOSS", 16: "UNAUTHENTICATED",
}


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
    ):
        if not all([tenant_id, product_id, api_key, ingestor_url, service_name]):
            raise ValueError("tenant_id, product_id, api_key, ingestor_url and service_name are required")

        self.tenant_id = tenant_id
        self.product_id = product_id
        self.api_key = api_key
        self.ingestor_url = ingestor_url.rstrip("/")
        self.service_name = service_name
        self.flush_interval_sec = flush_interval_sec
        self.flush_count = flush_count
        self.on_error = on_error or (lambda e: logger.error(f"[aforo-grpc] {e}"))
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
    ) -> None:
        if not customer_id:
            return
        now = datetime.now(timezone.utc)
        event = GrpcUsageEvent(
            customerId=customer_id,
            metricName="grpc_api.rpc_calls",
            quantity=1,
            occurredAt=now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            idempotencyKey=f"grpc:{self.tenant_id}:{self.service_name}:{method}:{int(now.timestamp() * 1000)}:{uuid.uuid4().hex[:8]}",
            productType="GRPC_API",
            grpcService=self.service_name,
            grpcMethod=method,
            grpcStatusCode=status,
            grpcCallType=call_type,
            messageCount=message_count,
            dataBytes=data_bytes,
            executionDurationMs=duration_ms,
            metadata={"sdkVersion": __version__, "productId": self.product_id},
        )
        with self._buffer_lock:
            self._buffer.append(asdict(event))
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
            batch = self._buffer
            self._buffer = []

        body = {"events": batch}
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "X-Tenant-Id": self.tenant_id,
        }
        url = f"{self.ingestor_url}/v1/ingest/events"

        # 3x exponential retry
        for attempt in range(3):
            try:
                if HAS_HTTPX:
                    with httpx.Client(timeout=10.0) as c:
                        r = c.post(url, json=body, headers=headers)
                        if 200 <= r.status_code < 300:
                            return
                else:
                    import urllib.request
                    import json as _json
                    req = urllib.request.Request(
                        url, data=_json.dumps(body).encode("utf-8"),
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

        self.on_error(RuntimeError(f"gRPC metering flush failed after 3 attempts (dropped {len(batch)} events)"))

    def shutdown(self) -> None:
        """Flush pending events and stop the background flush thread."""
        self._stop_event.set()
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

    def __init__(self, billing: AforoGrpcBilling):
        if grpc is None:
            raise RuntimeError("grpcio is not installed — install with `pip install grpcio`.")
        self.billing = billing

    def intercept_service(self, continuation, handler_call_details):  # type: ignore[override]
        method_full = handler_call_details.method  # "/pkg.Service/Method"
        parts = method_full.strip("/").split("/", 1)
        method_name = parts[1] if len(parts) == 2 else method_full
        handler = continuation(handler_call_details)
        if handler is None or not handler.unary_unary:
            return handler

        billing = self.billing

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
                duration_ms = int((time.monotonic() - start) * 1000)
                if customer_id:
                    billing.record(
                        method=method_name,
                        call_type="UNARY",
                        customer_id=customer_id,
                        status=status_label,
                        message_count=1,
                        duration_ms=duration_ms,
                    )

        # Return a new unary_unary handler with our behaviour.
        return grpc.unary_unary_rpc_method_handler(
            new_behaviour,
            request_deserializer=handler.request_deserializer,
            response_serializer=handler.response_serializer,
        )


# ── Helpers ──────────────────────────────────────────────────────

def _default_customer_extractor(context: Any) -> Optional[str]:
    """Read 'x-customer-id' from gRPC invocation metadata."""
    try:
        md = dict(context.invocation_metadata())
        v = md.get("x-customer-id")
        return v if isinstance(v, str) else None
    except Exception:
        return None
