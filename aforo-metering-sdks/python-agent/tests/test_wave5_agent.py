"""G290 (customer never defaults to the agent id), G291 (no start(), atexit
flush), G292 (a real queue bound; works with no event loop)."""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from typing import Any, Dict, List, Tuple

import pytest

from aforo_agent_metering import AforoAgentClient, wrap_capability_handler

from .fakes import ScriptedServer


def _client(server=None, **kw) -> Tuple[AforoAgentClient, ScriptedServer]:
    server = server or ScriptedServer()
    kw.setdefault("flush_interval_sec", 3600)
    return AforoAgentClient(tenant_id="t", product_id="p", api_key="k", ingestor_url="https://ingest.example.test",
                            http_transport=server.transport(), **kw), server


def _events(server):
    return [e for r in server.requests for e in r["body"]["events"]]


def test_agent_id_is_never_used_as_the_customer():
    drops: List[str] = []
    client, server = _client(on_drop=lambda events, reason: drops.append(reason))
    client.record_capability("summarize", "agent_7")  # no customer anywhere
    client.record_capability("summarize", "agent_7", customer_id="cust_9")
    client.shutdown_sync()
    assert drops == ["invalid"]
    (event,) = _events(server)
    assert event["customerId"] == "cust_9" and event["agentId"] == "agent_7"


def test_decorator_needs_a_customer_source():
    client, _ = _client()
    try:
        with pytest.raises(ValueError, match="customer_resolver"):
            wrap_capability_handler(client, capability_name="c")
    finally:
        client.shutdown_sync(timeout=0)


@pytest.mark.asyncio
async def test_decorator_customer_from_resolver_default_or_trusted_kwarg():
    client, server = _client(default_customer_id="cust_default")

    @wrap_capability_handler(client, capability_name="a")
    async def by_default(**kwargs: Any) -> str:
        return "ok"

    @wrap_capability_handler(client, capability_name="b", customer_resolver=lambda args, kwargs: "cust_auth")
    async def by_resolver(**kwargs: Any) -> str:
        return "ok"

    @wrap_capability_handler(client, capability_name="c", trust_customer_header=True)
    async def by_kwarg(**kwargs: Any) -> str:
        return "ok"

    await by_default(agent_id="ag", customer_id="spoofed")
    await by_resolver(agent_id="ag", customer_id="spoofed")
    await by_kwarg(agent_id="ag", customer_id="cust_kw")
    await client.shutdown()
    by_cap = {e["metadata"]["capability_name"]: e["customerId"] for e in _events(server)}
    assert by_cap == {"a": "cust_default", "b": "cust_auth", "c": "cust_kw"}


@pytest.mark.asyncio
async def test_decorator_call_without_agent_is_dropped_not_unknown():
    drops: List[Tuple[str, Dict[str, Any]]] = []
    client, server = _client(default_customer_id="c",
                             on_drop=lambda events, reason: drops.append((reason, events[0])))

    @wrap_capability_handler(client, capability_name="x")
    async def handler() -> str:
        return "still runs"

    assert await handler() == "still runs"
    await client.shutdown()
    assert drops[0][0] == "invalid" and drops[0][1]["agentId"] is None
    assert _events(server) == []


def test_queue_has_a_real_capacity():
    drops: List[str] = []
    client, _ = _client(default_customer_id="c", max_queue_size=3,
                        on_drop=lambda events, reason: drops.append(reason))
    for i in range(5):
        client.record_capability(f"c{i}", "a")
    assert len(client) == 3 and drops == ["overflow", "overflow"]
    client.shutdown_sync(timeout=0)


def test_max_retries_is_configurable():
    calls: List[int] = []

    async def post(url: str, headers: Dict[str, str], body: str):
        calls.append(1)
        return 503, ""

    client = AforoAgentClient(tenant_id="t", product_id="p", api_key="k", ingestor_url="https://ingest.example.test",
                              default_customer_id="c", flush_interval_sec=3600, post_fn=post, max_retries=1,
                              transport_options={"rand": lambda: 0.0, "breaker_initial": 3600, "breaker_max": 3600})
    client.record_capability("c", "a")
    client.flush_sync()
    assert len(calls) == 2
    client.shutdown_sync(timeout=0)


def test_interpreter_exit_flushes_without_start_or_shutdown(mock_ingestor):
    script = textwrap.dedent(f"""
        from aforo_agent_metering import AforoAgentClient
        c = AforoAgentClient(tenant_id="t", product_id="p", api_key="k", ingestor_url={mock_ingestor.url!r},
                             flush_interval_sec=3600)
        c.record_capability("summarize", "agent_1", customer_id="cust_exit")
    """)
    subprocess.run([sys.executable, "-c", script], check=True, timeout=30,
                   cwd=os.path.dirname(os.path.dirname(__file__)))
    assert [e["customerId"] for e in mock_ingestor.state()["events"]] == ["cust_exit"]
