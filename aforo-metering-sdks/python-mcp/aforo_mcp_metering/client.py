"""
Aforo MCP Billing Client — meters tool invocations and manages sessions.

Session heartbeats are not sent: see ``AforoMcpBilling.start_session``.
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
        self.on_error = on_error or (lambda e: logger.error(f"[aforo-mcp] {e}"))

        self._buffer: List[Dict[str, Any]] = []
        self._flush_task: Optional[asyncio.Task] = None
        self._running = False

        # Session state. heartbeat_interval_sec / heartbeat_enabled are accepted
        # for backwards compatibility and ignored: heartbeats are not sent.
        self._active_session_id: Optional[str] = None
        self._on_session_killed = on_session_killed

    # ─── Session lifecycle ───────────────────────────────────────────────
    #
    # Session heartbeats are NOT sent. They used to be appended to the usage
    # batch as ``system.session.heartbeat`` events with quantity 0; the ingestor
    # validates every event in a batch (quantity must be positive) and rejects
    # the whole batch with 400 when one is invalid, so each heartbeat took every
    # real tool invocation batched with it down. The ingestor has no dedicated
    # heartbeat endpoint, so there is nowhere correct to send them.

    async def start_session(self, session_id: str) -> None:
        """Record the active session (used to match server kill signals)."""
        self._active_session_id = session_id

    async def end_session(self) -> None:
        """End the session and flush remaining events."""
        self._stop_session()
        await self.flush()

    def _stop_session(self) -> None:
        self._active_session_id = None

    # ─── Tool handler wrapper ──────────────────────────────────────────

    def wrap_tool_handler(self, handler: Callable) -> Callable:
        """
        Decorator that wraps an MCP tool handler with automatic metering.
        Records the session from the first tool call that carries a session_id.

        Usage:
            @billing.wrap_tool_handler
            async def handle_tool(name: str, arguments: dict):
                ...
        """
        @functools.wraps(handler)
        async def wrapper(name: str, arguments: dict = None, **kwargs):
            agent_id = kwargs.get("agent_id", "unknown")
            session_id = kwargs.get("session_id")
            start_time = time.monotonic()
            status = "SUCCESS"

            # Track the session on the first tool call that carries one
            if session_id and not self._active_session_id:
                self._active_session_id = session_id

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
                )

        return wrapper

    def record_tool_invocation(
        self,
        tool_name: str,
        agent_id: str,
        session_id: Optional[str] = None,
        execution_status: str = "SUCCESS",
        execution_duration_ms: int = 0,
    ) -> None:
        """Record a tool invocation event (buffered, flushed periodically)."""
        event = {
            "customerId": agent_id,
            "metricName": "mcp_server.tool_invocations",
            "quantity": 1,
            "occurredAt": datetime.now(timezone.utc).isoformat(),
            "idempotencyKey": f"mcp:sdk:{agent_id}:{session_id or 'no-session'}:{tool_name}:{int(time.time() * 1000)}",
            "productType": "MCP_SERVER",
            "toolName": tool_name,
            "agentId": agent_id,
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

        url = f"{self.ingestor_url}/v1/ingest/batch"
        headers = {
            "Content-Type": "application/json",
            "X-API-Key": self.api_key,
            "X-Tenant-Id": self.tenant_id,
        }
        body = json.dumps({"events": events})

        for attempt in range(1, 4):
            try:
                status_code, response_body = await self._do_post_with_body(url, headers, body)
                if 200 <= status_code < 300:
                    logger.debug(f"[aforo-mcp] Flushed {len(events)} events")
                    # Check for kill signals from server
                    if response_body and self._active_session_id:
                        try:
                            result = json.loads(response_body)
                            killed_ids = result.get("killedSessionIds") or []
                            if self._active_session_id in killed_ids:
                                killed_id = self._active_session_id
                                self._stop_session()
                                if self._on_session_killed:
                                    self._on_session_killed(killed_id, "SERVER_KILL")
                        except (json.JSONDecodeError, TypeError):
                            pass  # Best-effort — old servers return empty 202
                    return
                if 400 <= status_code < 500:
                    self.on_error(Exception(f"Aforo returned {status_code} — not retrying"))
                    return
                logger.warning(f"[aforo-mcp] Attempt {attempt}/3 failed: HTTP {status_code}")
            except Exception as e:
                if attempt == 3:
                    self.on_error(e)
                logger.warning(f"[aforo-mcp] Attempt {attempt}/3 failed: {e}")

            if attempt < 3:
                await asyncio.sleep(2 ** (attempt - 1))

    async def _do_post_with_body(self, url: str, headers: dict, body: str) -> tuple:
        """HTTP POST with best available async client. Returns (status_code, response_body)."""
        if HAS_AIOHTTP:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, headers=headers, data=body, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    resp_body = await resp.text()
                    return resp.status, resp_body
        elif HAS_HTTPX:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(url, headers=headers, content=body)
                return resp.status_code, resp.text
        else:
            import urllib.request
            req = urllib.request.Request(url, data=body.encode(), headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=10) as resp:
                resp_body = resp.read().decode()
                return resp.status, resp_body

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
        """Stop the flush timer and flush remaining events."""
        self._stop_session()
        self._running = False
        if self._flush_task:
            self._flush_task.cancel()
            self._flush_task = None
        await self.flush()
