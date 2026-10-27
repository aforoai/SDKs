"""G289 (no blocking HTTP on the event loop; httpx is a dependency), G290
(customer from a resolver, never the agent id or "unknown"), G291 (shutdown
bounded and reported, atexit flush, nothing to start)."""

from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
import textwrap
import threading
from pathlib import Path

import pytest

from aforo_mcp_metering import AforoMcpBilling, ToolCall

from .fakes import ScriptedServer


def _billing(server=None, **kw):
    server = server or ScriptedServer()
    kw.setdefault("flush_interval_sec", 3600)
    return AforoMcpBilling(tenant_id="t", product_id="p", api_key="k", ingestor_url="https://ingest.example.test",
                           heartbeat_enabled=False, http_transport=server.transport(), **kw), server


def _events(server):
    return [e for r in server.requests for e in r["body"]["events"]]


def test_httpx_is_a_hard_dependency():
    setup = (Path(__file__).resolve().parents[1] / "setup.py").read_text()
    requires = re.search(r"install_requires=\[(.*?)\]", setup, re.S).group(1)
    assert "httpx" in requires


def test_flush_and_shutdown_never_send_on_the_event_loop_thread():
    billing, server = _billing(customer_resolver=lambda call: "c")
    loop_threads = []

    async def main():
        loop_threads.append(threading.current_thread())

        @billing.wrap_tool_handler
        async def tool(name, arguments, **kwargs):
            return "ok"

        await tool("search", {}, agent_id="agent_1")
        await billing.flush()
        await billing.shutdown()

    asyncio.run(main())
    assert len(_events(server)) == 1
    assert loop_threads[0].name not in server.threads


def test_wrap_tool_handler_needs_a_customer_source():
    billing, _ = _billing()
    try:
        with pytest.raises(ValueError, match="customer_resolver"):
            @billing.wrap_tool_handler
            async def tool(name, arguments):
                return "ok"
    finally:
        billing.shutdown_sync(timeout=0)


def test_customer_comes_from_the_resolver_not_the_agent_id():
    seen = []
    billing, server = _billing(customer_resolver=lambda call: (seen.append(call), "cust_auth")[1])

    async def main():
        @billing.wrap_tool_handler
        async def tool(name, arguments, **kwargs):
            return "ok"

        await tool("search", {"q": 1, "_meta": {"customer_id": "spoofed"}}, agent_id="agent_7")
        await billing.shutdown()

    asyncio.run(main())
    (event,) = _events(server)
    assert event["customerId"] == "cust_auth" and event["agentId"] == "agent_7"
    assert isinstance(seen[0], ToolCall) and seen[0].name == "search"


def test_trusting_meta_customer_id_is_an_explicit_opt_in():
    billing, server = _billing(trust_customer_header=True)

    async def main():
        @billing.wrap_tool_handler
        async def tool(name, arguments, **kwargs):
            return "ok"

        await tool("search", {"_meta": {"customer_id": "cust_meta"}}, agent_id="agent_1")
        await tool("search", {}, agent_id="agent_1")  # no customer: still served, dropped as invalid
        await billing.shutdown()

    asyncio.run(main())
    assert [e["customerId"] for e in _events(server)] == ["cust_meta"]
    assert billing.dropped_count == 1


def test_no_unknown_agent_or_customer_defaults():
    drops = []
    billing, server = _billing(customer_resolver=lambda call: "c",
                               on_drop=lambda events, reason: drops.append((reason, events[0])))

    async def main():
        @billing.wrap_tool_handler
        async def tool(name, arguments, **kwargs):
            return "ok"

        assert await tool("search", {}) == "ok"  # no agent id anywhere
        await billing.shutdown()

    asyncio.run(main())
    assert _events(server) == []
    assert drops[0][0] == "invalid" and drops[0][1]["agentId"] == ""


def test_events_are_sent_without_calling_start():
    billing, server = _billing(customer_resolver=lambda call: "c", flush_count=1)
    billing.record_tool_invocation("search", "agent_1", customer_id="c")
    from .mock_ingestor import wait_until

    wait_until(lambda: len(_events(server)) == 1)
    billing.shutdown_sync()


def test_shutdown_during_a_hung_send_is_bounded_and_reported(mock_ingestor):
    mock_ingestor.faults({"hang": True, "times": -1})
    drops = []
    billing = AforoMcpBilling(tenant_id="t", product_id="p", api_key="k", ingestor_url=mock_ingestor.url,
                              heartbeat_enabled=False, flush_interval_sec=3600, flush_count=1,
                              shutdown_timeout_sec=0.5, on_drop=lambda events, reason: drops.append(reason))
    billing.record_tool_invocation("search", "agent_1", customer_id="c")
    mock_ingestor.wait_for(lambda s: [r["status"] for r in s["requests"]] == [-2])

    async def main():
        start = asyncio.get_running_loop().time()
        await billing.shutdown()
        return asyncio.get_running_loop().time() - start

    assert asyncio.run(main()) < 2.0
    assert drops == ["shutdown"]


def test_interpreter_exit_flushes(mock_ingestor):
    script = textwrap.dedent(f"""
        from aforo_mcp_metering import AforoMcpBilling
        b = AforoMcpBilling(tenant_id="t", product_id="p", api_key="k", ingestor_url={mock_ingestor.url!r},
                            heartbeat_enabled=False, flush_interval_sec=3600)
        b.record_tool_invocation("search", "agent_1", customer_id="cust_exit")
        # no shutdown(), no start(): the atexit hook must flush
    """)
    subprocess.run([sys.executable, "-c", script], check=True, timeout=30,
                   cwd=os.path.dirname(os.path.dirname(__file__)))
    assert [e["customerId"] for e in mock_ingestor.state()["events"]] == ["cust_exit"]
