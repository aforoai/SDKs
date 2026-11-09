"""Regression tests for the 2026-11-09 SDK review (python-mcp findings 1, 2, 7, 8, 9 and
rules R1-R3). ``mcp``'s request context is simulated with a stand-in module unless the
real ``mcp`` 1.x package is installed (then the end-to-end tests run against it too)."""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import re
import sys
import types
from pathlib import Path

import httpx
import pytest

import aforo_mcp_metering.client as client_module
from aforo_mcp_metering import AforoMcpBilling

from .fakes import ScriptedServer
from .gzip_body import request_bytes

CTX_MODULE = "mcp.server.lowlevel.server"


def _billing(server=None, **kw):
    server = server or ScriptedServer()
    kw.setdefault("flush_interval_sec", 3600)
    kw.setdefault("heartbeat_enabled", False)
    return AforoMcpBilling(tenant_id="t", product_id="p", api_key="k", ingestor_url="https://ingest.example.test",
                           http_transport=server.transport(), **kw), server


def _events(server):
    return [e for r in server.requests for e in r["body"]["events"]
            if e["metricName"] != "system.session.heartbeat"]


class _Meta:
    """Shaped like mcp.types.RequestParams.Meta (a pydantic model with extra fields)."""

    def __init__(self, **fields):
        self._fields = fields

    def model_dump(self):
        return dict(self._fields)


def _ctx(client_name=None, **meta):
    info = types.SimpleNamespace(name=client_name) if client_name is not None else None
    session = types.SimpleNamespace(client_params=types.SimpleNamespace(clientInfo=info))
    return types.SimpleNamespace(meta=_Meta(**meta) if meta else None, session=session)


@pytest.fixture
def request_ctx(monkeypatch):
    """A stand-in for mcp.server.lowlevel.server.request_ctx."""
    var = contextvars.ContextVar("request_ctx")
    module = types.ModuleType(CTX_MODULE)
    module.request_ctx = var
    monkeypatch.setitem(sys.modules, CTX_MODULE, module)
    return var


# ── finding 1: an agent without agent_id / agent_resolver ─────────


def test_agent_falls_back_to_the_mcp_client_name(request_ctx):
    billing, server = _billing(customer_resolver=lambda call: "cust_1")

    async def main():
        @billing.wrap_tool_handler
        async def tool(name, arguments):  # how mcp's @server.call_tool() calls it
            return "ok"

        request_ctx.set(_ctx(client_name="claude-ai"))
        await tool("search", {"q": 1})
        request_ctx.set(_ctx(client_name="c" * 50))  # request-derived: cut to 36, still sent
        await tool("search", {"q": 2})
        await billing.shutdown()

    asyncio.run(main())
    assert [e["agentId"] for e in _events(server)] == ["claude-ai", "c" * 36]


def test_explicit_agent_and_resolver_win_over_the_client_name(request_ctx):
    billing, server = _billing(customer_resolver=lambda call: "cust_1",
                               agent_resolver=lambda call: "from_resolver" if call.name == "r" else None)

    async def main():
        @billing.wrap_tool_handler
        async def tool(name, arguments, **kwargs):
            return "ok"

        request_ctx.set(_ctx(client_name="claude-ai"))
        await tool("x", {}, agent_id="explicit")
        await tool("r", {})
        await tool("n", {})  # resolver gives nothing: the client name
        await billing.shutdown()

    asyncio.run(main())
    assert [e["agentId"] for e in _events(server)] == ["explicit", "from_resolver", "claude-ai"]


def test_no_agent_anywhere_is_dropped_and_logged_once_at_error(caplog):
    drops = []
    billing, server = _billing(customer_resolver=lambda call: "c",
                               on_drop=lambda events, reason: drops.append(reason))

    async def main():
        @billing.wrap_tool_handler
        async def tool(name, arguments):
            return "ok"

        assert await tool("search", {}) == "ok"  # no mcp request context at all
        assert await tool("search", {}) == "ok"
        await billing.shutdown()

    with caplog.at_level(logging.WARNING, logger="aforo_mcp_metering"):
        asyncio.run(main())
    assert _events(server) == [] and drops == ["invalid", "invalid"]
    errors = [r for r in caplog.records if r.levelno == logging.ERROR and "has no agent" in r.getMessage()]
    assert len(errors) == 1 and "agent_resolver" in errors[0].getMessage()


# ── finding 2: _meta comes from params._meta, never from the arguments ──


def test_trusted_meta_is_read_from_the_request_not_the_arguments(request_ctx):
    billing, server = _billing(trust_customer_header=True)

    async def main():
        @billing.wrap_tool_handler
        async def tool(name, arguments):
            return "ok"

        request_ctx.set(_ctx(client_name="agent", customer_id="cust_authenticated"))
        await tool("search", {"_meta": {"customer_id": "cust_victim"}})
        request_ctx.set(_ctx(client_name="agent"))  # params._meta has no customer
        await tool("search", {"_meta": {"customer_id": "cust_victim"}})
        await billing.shutdown()

    asyncio.run(main())
    assert [e["customerId"] for e in _events(server)] == ["cust_authenticated"]
    assert billing.dropped_count == 1


def test_resolver_sees_the_request_context(request_ctx):
    seen = []
    billing, server = _billing(customer_resolver=lambda call: (seen.append(call), "c")[1])
    ctx = _ctx(client_name="agent", customer_id="m")

    async def main():
        @billing.wrap_tool_handler
        async def tool(name, arguments):
            return "ok"

        request_ctx.set(ctx)
        await tool("search", {"_meta": {"customer_id": "spoof"}})
        await billing.shutdown()

    asyncio.run(main())
    assert seen[0].request_context is ctx and seen[0].meta == {"customer_id": "m"}


# ── finding 7: sessions linked to tool calls; kills read from usage batches ──


def test_tool_calls_default_to_the_active_session():
    billing, server = _billing(customer_resolver=lambda call: "c")

    async def main():
        @billing.wrap_tool_handler
        async def tool(name, arguments, **kwargs):
            return "ok"

        await billing.start_session("sess_abc123", customer_id="c")
        await tool("a", {}, agent_id="agent_1")
        await tool("b", {}, agent_id="agent_1", session_id="sess_other")
        billing.record_tool_invocation("c", "agent_1", customer_id="c")
        await billing.end_session()
        billing.record_tool_invocation("d", "agent_1", customer_id="c")  # no session any more
        await billing.shutdown()

    asyncio.run(main())
    assert [e["sessionId"] for e in _events(server)] == ["sess_abc123", "sess_other", "sess_abc123", None]


def test_killed_session_in_a_usage_batch_response_stops_the_session():
    def answer(request):
        body = json.loads(request_bytes(request))
        if body["events"][0]["metricName"] == "system.session.heartbeat":
            return httpx.Response(202, json={"success": True, "data": {"accepted": 0}})
        return httpx.Response(202, json={"success": True, "data": {
            "accepted": len(body["events"]), "failed": 0, "killedSessionIds": ["sess_1"]}})

    killed, accepted = [], []
    server = ScriptedServer(default=answer)
    billing, _ = _billing(server, customer_resolver=lambda call: "c", heartbeat_enabled=True,
                          heartbeat_interval_sec=3600,
                          on_session_killed=lambda sid, why: killed.append((sid, why)),
                          transport_options={"on_accepted": lambda body, items: accepted.append(len(items))})

    async def main():
        @billing.wrap_tool_handler
        async def tool(name, arguments, **kwargs):
            return "ok"

        await tool("search", {}, agent_id="agent_1", session_id="sess_1")
        task = billing._heartbeat_task
        await billing.flush()
        await asyncio.sleep(0.01)
        assert killed == [("sess_1", "SERVER_KILL")]
        assert billing._active_session_id is None and task.done()
        await billing.shutdown()

    asyncio.run(main())
    assert accepted == [1]  # a user on_accepted still runs


# ── finding 8: heartbeat telemetry ──────────────────────────────


def test_heartbeat_reports_sdk_language():
    billing, _ = _billing(customer_resolver=lambda call: "c")
    billing._session_started_at = 0.0
    meta = billing._heartbeat_event("s", "HEARTBEAT")["metadata"]
    assert meta["sdkLanguage"] == "python"
    billing.shutdown_sync(timeout=0)


@pytest.mark.parametrize("platform,raw,expected", [("darwin", 200 * 1024 * 1024, 200), ("linux", 200 * 1024, 200)])
def test_process_memory_is_megabytes_on_every_platform(monkeypatch, platform, raw, expected):
    fake = types.SimpleNamespace(RUSAGE_SELF=0, getrusage=lambda who: types.SimpleNamespace(ru_maxrss=raw))
    monkeypatch.setitem(sys.modules, "resource", fake)
    monkeypatch.setattr(client_module.sys, "platform", platform)
    assert client_module._process_memory_mb() == expected


# ── R1 / R3: occurredAt and Java-int fields ─────────────────────


def test_occurred_at_has_seconds_and_z():
    billing, _ = _billing(customer_resolver=lambda call: "c")
    billing.record_tool_invocation("t", "agent_1", customer_id="c")
    (event,) = billing._buffer
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", event["occurredAt"])
    billing.shutdown_sync(timeout=0)


def test_out_of_range_duration_is_left_off_and_the_event_kept(caplog):
    billing, _ = _billing(customer_resolver=lambda call: "c")
    with caplog.at_level(logging.WARNING, logger="aforo_mcp_metering"):
        billing.record_tool_invocation("t", "a", execution_duration_ms=2 ** 31, customer_id="c")
        billing.record_tool_invocation("t", "a", execution_duration_ms="soon", customer_id="c")
        billing.record_tool_invocation("t", "a", execution_duration_ms=12.7, customer_id="c")
        billing.record_tool_invocation("t", "a", execution_duration_ms=2 ** 31 - 1, customer_id="c")
    events = billing._buffer
    assert len(events) == 4 and billing.dropped_count == 0
    assert [e.get("executionDurationMs") for e in events] == [None, None, 12, 2 ** 31 - 1]
    assert "executionDurationMs" not in events[0]
    assert caplog.text.count("not a whole number the ingestor can hold") == 1
    billing.shutdown_sync(timeout=0)


# ── finding 9: docs and versions ────────────────────────────────


def test_docs_name_the_real_version_and_compression():
    root = Path(__file__).resolve().parents[1]
    version = client_module.__version__
    assert f'version="{version}"' in (root / "setup.py").read_text()
    for doc in ("README.md", "USER_GUIDE.md"):
        text = (root / doc).read_text()
        assert f"**Version:** {version}" in text, doc
        assert "`compression`" in text, doc
    changelog = (root / "CHANGELOG.md").read_text()
    assert "## [Unreleased]" in changelog and f"## [{version}]" in changelog


# ── the README Quickstart against the real mcp 1.x low-level server ──


def _real_mcp():
    mcp = pytest.importorskip("mcp")
    from mcp.server.lowlevel import Server
    if not hasattr(Server, "call_tool"):
        pytest.skip("mcp 2.x has no Server.call_tool decorator")
    return mcp


def test_readme_quickstart_meters_with_the_real_mcp_server():
    _real_mcp()
    import mcp.types as mtypes
    from mcp.server.lowlevel import Server
    from mcp.shared.memory import create_connected_server_and_client_session

    billing, server = _billing(customer_resolver=lambda call: "cust_42")
    trusting, server2 = _billing(trust_customer_header=True)
    mcp_server = Server("my-tools")

    @mcp_server.list_tools()
    async def list_tools():
        return [mtypes.Tool(name="search", description="s", inputSchema={"type": "object"})]

    @mcp_server.call_tool()
    @billing.wrap_tool_handler
    async def handle_tool(name: str, arguments: dict):
        return [mtypes.TextContent(type="text", text=f"ran {name}")]

    trusted_server = Server("trusted")

    @trusted_server.list_tools()
    async def list_tools2():
        return [mtypes.Tool(name="search", description="s", inputSchema={"type": "object"})]

    @trusted_server.call_tool()
    @trusting.wrap_tool_handler
    async def handle_tool2(name: str, arguments: dict):
        return [mtypes.TextContent(type="text", text="ok")]

    async def main():
        async with create_connected_server_and_client_session(mcp_server) as client:
            result = await client.call_tool("search", {"q": "x"})
            assert result.isError is False and result.content[0].text == "ran search"
        async with create_connected_server_and_client_session(trusted_server) as client:
            await client.call_tool("search", {"q": "x", "_meta": {"customer_id": "cust_victim"}},
                                   meta={"customer_id": "cust_gateway"})
        await billing.shutdown()
        await trusting.shutdown()

    asyncio.run(main())
    (event,) = _events(server)
    assert event["customerId"] == "cust_42" and event["agentId"] == "mcp"  # mcp's default clientInfo.name
    assert [e["customerId"] for e in _events(server2)] == ["cust_gateway"]
