"""Tests for the @wrap_capability_handler decorator.

The decorator wraps an async capability handler:
* Records a metering event with status SUCCESS on normal return.
* Records a metering event with status ERROR and re-raises when the
  handler raises.
* Times the handler (execution_duration_ms).
* Never swallows the underlying return value or exception.
* Sync handlers are rejected at decoration time (no silent no-op).
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Tuple

import pytest

from aforo_agent_metering import AforoAgentClient, wrap_capability_handler


def _client(**overrides: Any) -> AforoAgentClient:
    return AforoAgentClient(
        tenant_id="tenant_test",
        product_id="prod_ai_001",
        api_key="sk_agent_abc",
        ingestor_url="https://ingest.test.aforo.ai",
        flush_interval_sec=3600.0,
        **overrides,
    )


async def _null_sleep(_: float) -> None:
    return None


@pytest.mark.asyncio
async def test_decorator_records_on_success() -> None:
    captured: List[Tuple[str, Dict[str, str], str]] = []

    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        captured.append((url, headers, body))
        return 202, ""

    client = _client(post_fn=post)

    @wrap_capability_handler(client, capability_name="summarize_email")
    async def summarize(text: str, *, agent_id: str, session_id: str, customer_id: str) -> str:
        return f"summary: {text}"

    result = await summarize(
        "hello world",
        agent_id="agt_1",
        session_id="sess_1",
        customer_id="cust_1",
    )
    await client.flush()

    assert result == "summary: hello world"
    assert len(captured) == 1

    import json

    body = json.loads(captured[0][2])
    event = body["events"][0]
    assert event["metadata"]["capability_name"] == "summarize_email"
    assert event["executionStatus"] == "SUCCESS"
    assert event["agentId"] == "agt_1"
    assert event["sessionId"] == "sess_1"
    assert event["customerId"] == "cust_1"


@pytest.mark.asyncio
async def test_decorator_records_error_and_reraises() -> None:
    captured: List[Tuple[str, Dict[str, str], str]] = []

    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        captured.append((url, headers, body))
        return 202, ""

    client = _client(post_fn=post)

    @wrap_capability_handler(client, capability_name="broken")
    async def failing(*, agent_id: str, session_id: str) -> None:
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        await failing(agent_id="agt_1", session_id="sess_1")
    await client.flush()

    import json

    event = json.loads(captured[0][2])["events"][0]
    assert event["executionStatus"] == "ERROR"
    assert event["metadata"]["capability_name"] == "broken"


@pytest.mark.asyncio
async def test_decorator_measures_duration() -> None:
    captured: List[Tuple[str, Dict[str, str], str]] = []

    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        captured.append((url, headers, body))
        return 202, ""

    client = _client(post_fn=post)

    @wrap_capability_handler(client, capability_name="slow_thing")
    async def slow(*, agent_id: str, session_id: str) -> None:
        await asyncio.sleep(0.02)

    await slow(agent_id="a", session_id="s")
    await client.flush()

    import json

    event = json.loads(captured[0][2])["events"][0]
    # Duration is monotonic-clock derived; be generous to avoid CI flake.
    assert event["executionDurationMs"] >= 15


@pytest.mark.asyncio
async def test_decorator_capability_name_kwarg_fallback() -> None:
    """If the decorator arg is None, the kwarg wins."""
    captured: List[Tuple[str, Dict[str, str], str]] = []

    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        captured.append((url, headers, body))
        return 202, ""

    client = _client(post_fn=post)

    @wrap_capability_handler(client, capability_name=None)
    async def generic(**kwargs: Any) -> None:
        return None

    await generic(
        agent_id="a",
        session_id="s",
        capability_name="runtime_pick",
    )
    await client.flush()

    import json

    event = json.loads(captured[0][2])["events"][0]
    assert event["metadata"]["capability_name"] == "runtime_pick"


@pytest.mark.asyncio
async def test_decorator_capability_name_handler_name_fallback() -> None:
    """No decorator arg + no kwarg → use handler.__name__."""
    captured: List[Tuple[str, Dict[str, str], str]] = []

    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        captured.append((url, headers, body))
        return 202, ""

    client = _client(post_fn=post)

    @wrap_capability_handler(client)
    async def translate_document(**kwargs: Any) -> None:
        return None

    await translate_document(agent_id="a", session_id="s")
    await client.flush()

    import json

    event = json.loads(captured[0][2])["events"][0]
    assert event["metadata"]["capability_name"] == "translate_document"


def test_decorator_rejects_sync_handlers() -> None:
    """A sync handler slipping through would silently not-metered — catch
    the mismatch at decoration time."""
    client = _client()

    def sync_handler(**kwargs: Any) -> None:
        return None

    with pytest.raises(TypeError, match="async"):
        wrap_capability_handler(client, capability_name="x")(sync_handler)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_decorator_preserves_functools_wraps() -> None:
    """functools.wraps propagates __name__ + __doc__ — matters for
    frameworks (FastAPI, LangChain) that introspect the wrapped fn."""
    client = _client()

    @wrap_capability_handler(client, capability_name="x")
    async def documented(*, agent_id: str) -> None:
        """This is the docstring."""

    assert documented.__name__ == "documented"
    assert documented.__doc__ == "This is the docstring."


@pytest.mark.asyncio
async def test_decorator_absorbs_metering_failure() -> None:
    """If record_capability raises for any reason, the handler's return
    value must still surface — metering is best-effort."""

    class ExplodingBuffer:
        max_events = 50

        def add(self, ev: Dict[str, Any]) -> bool:
            raise RuntimeError("buffer bug")

        def drain(self) -> List[Dict[str, Any]]:
            return []

        def __len__(self) -> int:
            return 0

    client = _client()
    client._buffer = ExplodingBuffer()  # type: ignore[assignment]

    @wrap_capability_handler(client, capability_name="x")
    async def normal(*, agent_id: str) -> str:
        return "returned normally"

    result = await normal(agent_id="a")
    assert result == "returned normally"


async def _status_for(raise_exc: BaseException) -> str:
    import json

    captured: List[str] = []

    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        captured.append(body)
        return 202, ""

    client = _client(post_fn=post)

    @wrap_capability_handler(client, capability_name="c")
    async def handler(*, agent_id: str) -> None:
        raise raise_exc

    with pytest.raises(type(raise_exc)):
        await handler(agent_id="agt_1")
    await client.flush()
    return json.loads(captured[0])["events"][0]["executionStatus"]


@pytest.mark.asyncio
async def test_decorator_timeout_is_timeout() -> None:
    assert await _status_for(asyncio.TimeoutError()) == "TIMEOUT"
    assert await _status_for(TimeoutError()) == "TIMEOUT"


@pytest.mark.asyncio
async def test_decorator_cancelled_is_cancelled_not_success() -> None:
    # CancelledError is a BaseException: before 2026-09-30 it slipped past
    # ``except Exception`` and the call billed as SUCCESS.
    assert await _status_for(asyncio.CancelledError()) == "CANCELLED"
    assert await _status_for(KeyboardInterrupt()) == "CANCELLED"
