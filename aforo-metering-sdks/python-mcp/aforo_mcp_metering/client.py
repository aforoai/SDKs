"""
Aforo MCP Billing Client — meters tool invocations and manages sessions.

Session heartbeats are sent in their own requests: see ``AforoMcpBilling.start_session``.
"""

import asyncio
import functools
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

__version__ = "1.1.0"

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


# The ingestor's per-request cap on POST /v1/ingest/batch (IngestBatchRequest).
MAX_BATCH_EVENTS = 1000

DEFAULT_PRODUCT_TYPE = "MCP_SERVER"
HEARTBEAT_METRIC = "system.session.heartbeat"
# Ingestor field limits: one oversized event fails the whole batch with 400.
MAX_CUSTOMER_ID_LEN = 64
MAX_AGENT_ID_LEN = 36
MAX_TOOL_NAME_LEN = 64


def _utc_now_iso() -> str:
    """ISO-8601 instant, e.g. ``2026-09-22T10:00:00.000Z``."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _normalize_product_type(product_type: Optional[str], default: str) -> str:
    """Trim + upper-case; unknown values pass through; blank -> ``default``."""
    value = str(product_type).strip().upper() if product_type is not None else ""
    return value or default


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
        payload = json.loads(response_body) if response_body else None
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
        self.flush_count = flush_count
        self.product_type = _normalize_product_type(product_type, DEFAULT_PRODUCT_TYPE)
        self.on_error = on_error or (lambda e: logger.error(f"[aforo-mcp] {e}"))

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
            result = json.loads(response_body)
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

    def wrap_tool_handler(self, handler: Callable) -> Callable:
        """
        Decorator that wraps an MCP tool handler with automatic metering.
        Starts the session (and its heartbeats) on the first tool call that
        carries a ``session_id``. Optional kwargs read by the wrapper (and passed
        through to the handler): ``agent_id``, ``session_id``, ``product_type``.

        Usage:
            @billing.wrap_tool_handler
            async def handle_tool(name: str, arguments: dict):
                ...
        """
        @functools.wraps(handler)
        async def wrapper(name: str, arguments: dict = None, **kwargs):
            agent_id = kwargs.get("agent_id", "unknown")
            session_id = kwargs.get("session_id")
            product_type = kwargs.get("product_type")
            start_time = time.monotonic()
            status = "SUCCESS"

            # Start the session on the first tool call that carries one
            if session_id and not self._active_session_id:
                self._begin_session(
                    session_id, product_type,
                    agent_id if agent_id and agent_id != "unknown" else None,
                )

            try:
                result = await handler(name, arguments, **kwargs)
                return result
            except Exception:
                status = "ERROR"
                raise
            finally:
                duration_ms = int((time.monotonic() - start_time) * 1000)
                self.record_tool_invocation(
                    tool_name=name,
                    agent_id=agent_id,
                    session_id=session_id,
                    execution_status=status,
                    execution_duration_ms=duration_ms,
                    product_type=product_type,
                )

        return wrapper

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
        Events the ingestor would reject (blank tool name, blank or > 64-char
        customer id) are dropped via ``on_error`` instead of failing the batch.
        """
        agent_id = (str(agent_id).strip() if agent_id is not None else "") or "unknown"
        tool_name = str(tool_name).strip() if tool_name is not None else ""
        if not tool_name:
            self.on_error(ValueError("[aforo-mcp] tool invocation dropped: toolName is required for MCP_SERVER"))
            return
        if len(agent_id) > MAX_CUSTOMER_ID_LEN:
            self.on_error(ValueError(
                f"[aforo-mcp] tool invocation dropped: customerId (agent_id) exceeds {MAX_CUSTOMER_ID_LEN} chars"
            ))
            return
        event = {
            "customerId": agent_id,
            "metricName": "mcp_server.tool_invocations",
            "quantity": 1,
            "occurredAt": _utc_now_iso(),
            # Unique per event: a millisecond timestamp alone collides for two calls
            # of the same tool in the same ms, and the ingestor dedupes the second.
            "idempotencyKey": f"mcp:sdk:{agent_id}:{session_id or 'no-session'}:{tool_name}:{int(time.time() * 1000)}:{uuid.uuid4().hex[:8]}",
            "productType": _normalize_product_type(product_type, self.product_type),
            "toolName": tool_name[:MAX_TOOL_NAME_LEN],
            "agentId": agent_id[:MAX_AGENT_ID_LEN],
            "sessionId": session_id,
            "executionStatus": execution_status,
            "executionDurationMs": execution_duration_ms,
            "metadata": {
                "productId": self.product_id,
                "sdk": "python",
                "sdkVersion": "1.0.0",
            },
        }

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
                    # Check for kill signals from server
                    self._check_killed(response_body)
                    return
                if 400 <= status_code < 500 and status_code not in (408, 429):
                    details = "; ".join(_error_messages(response_body)[:5])
                    self.on_error(Exception(
                        f"Aforo returned {status_code} — not retrying" + (f": {details}" if details else "")
                    ))
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
