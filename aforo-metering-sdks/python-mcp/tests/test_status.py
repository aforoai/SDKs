"""executionStatus for wrapped MCP tool calls (P6 item 14, 2026-09-30).

MCP tools normally report failure by RETURNING a result with ``isError``
set, not by raising — before this change those calls billed as SUCCESS.
Cancelled calls also billed as SUCCESS (``asyncio.CancelledError`` is a
BaseException and slipped past ``except Exception``).
"""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from aforo_mcp_metering import AforoMcpBilling, default_tool_status

CANONICAL = json.loads(
    (Path(__file__).resolve().parents[2] / "contract" / "ingest-contract.json").read_text()
)["endpoints"]["/v1/ingest/batch"]["eventOptionalFields"]["executionStatus"]["values"]


def _billing() -> AforoMcpBilling:
    return AforoMcpBilling(
        tenant_id="tenant_test",
        product_id="prod_test",
        api_key="test-key",
        ingestor_url="https://ingest.test.aforo.ai",
        flush_interval_sec=3600.0,
        heartbeat_enabled=False,
    )


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _statuses(billing: AforoMcpBilling):
    return [e["executionStatus"] for e in billing._buffer]


def test_normal_result_is_success():
    b = _billing()

    @b.wrap_tool_handler
    async def tool(name, arguments):
        return [{"type": "text", "text": "ok"}]

    _run(tool("search", {}))
    assert _statuses(b) == ["SUCCESS"]


@pytest.mark.parametrize(
    "result",
    [
        {"isError": True, "content": []},
        {"is_error": True},
        SimpleNamespace(isError=True, content=[]),  # CallToolResult-style object
    ],
)
def test_returned_is_error_result_is_error_and_still_returned(result):
    b = _billing()

    @b.wrap_tool_handler
    async def tool(name, arguments):
        return result

    assert _run(tool("search", {})) is result
    assert _statuses(b) == ["ERROR"]


def test_is_error_must_be_literally_true():
    b = _billing()

    @b.wrap_tool_handler
    async def tool(name, arguments):
        return {"isError": "yes"}

    _run(tool("search", {}))
    assert _statuses(b) == ["SUCCESS"]


def test_raised_error_is_error_and_re_raised():
    b = _billing()

    @b.wrap_tool_handler
    async def tool(name, arguments):
        raise ValueError("bad params")

    with pytest.raises(ValueError):
        _run(tool("search", {}))
    assert _statuses(b) == ["ERROR"]


def test_timeouts_are_timeout():
    b = _billing()
    mcp_timeout = RuntimeError("Request timed out")
    mcp_timeout.error = SimpleNamespace(code=-32001)  # McpError shape

    @b.wrap_tool_handler
    async def slow(name, arguments):
        raise asyncio.TimeoutError()

    @b.wrap_tool_handler
    async def rpc(name, arguments):
        raise mcp_timeout

    with pytest.raises(asyncio.TimeoutError):
        _run(slow("s", {}))
    with pytest.raises(RuntimeError):
        _run(rpc("s", {}))
    assert _statuses(b) == ["TIMEOUT", "TIMEOUT"]


def test_cancelled_call_is_cancelled_not_success():
    b = _billing()

    @b.wrap_tool_handler
    async def tool(name, arguments):
        raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        _run(tool("search", {}))
    assert _statuses(b) == ["CANCELLED"]


def test_status_resolver_overrides_and_is_normalized():
    b = _billing()

    @b.wrap_tool_handler(status_resolver=lambda result, error: " partial " if result.get("partial") else None)
    async def tool(name, arguments):
        return {"partial": True}

    _run(tool("search", {}))
    assert _statuses(b) == ["PARTIAL"]


def test_status_resolver_none_or_blank_falls_back_to_default():
    b = _billing()

    @b.wrap_tool_handler(status_resolver=lambda r, e: None)
    async def failing(name, arguments):
        return {"isError": True}

    @b.wrap_tool_handler(status_resolver=lambda r, e: "  ")
    async def fine(name, arguments):
        return {}

    _run(failing("a", {}))
    _run(fine("b", {}))
    assert _statuses(b) == ["ERROR", "SUCCESS"]


def test_status_resolver_receives_the_error():
    b = _billing()
    seen = []
    boom = ValueError("boom")

    def resolver(result, error):
        seen.append((result, error))
        return "FAILED"

    @b.wrap_tool_handler(status_resolver=resolver)
    async def tool(name, arguments):
        raise boom

    with pytest.raises(ValueError):
        _run(tool("search", {}))
    assert seen == [(None, boom)]
    assert _statuses(b) == ["FAILED"]


def test_raising_status_resolver_uses_default(caplog):
    b = _billing()

    def resolver(result, error):
        raise RuntimeError("resolver bug")

    @b.wrap_tool_handler(status_resolver=resolver)
    async def tool(name, arguments):
        return {"isError": True}

    with caplog.at_level("WARNING", logger="aforo_mcp_metering"):
        _run(tool("search", {}))
    assert _statuses(b) == ["ERROR"]
    assert any("status_resolver raised" in r.message for r in caplog.records)


def test_every_default_status_is_canonical():
    produced = {
        default_tool_status([], None),
        default_tool_status({"isError": True}, None),
        default_tool_status(None, ValueError()),
        default_tool_status(None, asyncio.TimeoutError()),
        default_tool_status(None, asyncio.CancelledError()),
    }
    assert produced <= set(CANONICAL)


def test_non_canonical_resolver_status_falls_back_to_default(caplog):
    # An unknown executionStatus makes the ingestor reject the event.
    b = _billing()

    @b.wrap_tool_handler(status_resolver=lambda r, e: "ok")
    async def tool(name, arguments):
        return {"isError": True}

    _run(tool("search", {}))
    assert _statuses(b) == ["ERROR"]
    assert "not an execution status" in caplog.text


def test_async_resolver_is_closed_not_awaited(caplog, recwarn):
    b = _billing()

    async def resolver(result, error):
        return "PARTIAL"

    @b.wrap_tool_handler(status_resolver=resolver)
    async def tool(name, arguments):
        return {}

    _run(tool("search", {}))
    assert _statuses(b) == ["SUCCESS"]
    assert "must be synchronous" in caplog.text
    assert not [w for w in recwarn if "never awaited" in str(w.message)]


def test_sync_handler_is_supported():
    b = _billing()

    @b.wrap_tool_handler
    def tool(name, arguments):
        return {"isError": True}

    assert _run(tool("search", {})) == {"isError": True}
    assert _statuses(b) == ["ERROR"]


def test_keyboard_interrupt_is_cancelled_and_re_raised():
    b = _billing()

    @b.wrap_tool_handler
    async def tool(name, arguments):
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        _run(tool("search", {}))
    assert _statuses(b) == ["CANCELLED"]


def test_execution_statuses_match_the_contract():
    from aforo_mcp_metering import EXECUTION_STATUSES
    assert sorted(EXECUTION_STATUSES) == sorted(CANONICAL)
