import asyncio
import json

import pytest

from aforo_mcp_metering import AforoMcpBilling

CFG = dict(tenant_id="t", product_id="p", api_key="k", ingestor_url="https://ingestor.example")


def test_requires_core_config():
    for missing in ("tenant_id", "product_id", "api_key", "ingestor_url"):
        bad = dict(CFG, **{missing: ""})
        with pytest.raises(ValueError):
            AforoMcpBilling(**bad)


def test_wrap_passes_result_through():
    async def scenario():
        billing = AforoMcpBilling(**CFG)
        calls = []

        @billing.wrap_tool_handler
        async def handler(name, arguments):
            calls.append(name)
            return [{"type": "text", "text": "ok"}]

        result = await handler("my_tool", {})

        assert result == [{"type": "text", "text": "ok"}]
        assert calls == ["my_tool"]

        # Best-effort flush against an unresolvable host (fast NXDOMAIN, swallowed).
        await billing.shutdown()

    asyncio.run(scenario())


def test_heartbeats_are_sent_alone_never_in_usage_batch():
    """Each heartbeat goes in its own single-event request (so the ingestor
    intercepts it on the synchronous path) with quantity 1 -- never mixed into
    the usage batch."""

    async def scenario():
        billing = AforoMcpBilling(**CFG)
        requests = []

        async def fake_post(url, headers, body):
            requests.append(json.loads(body)["events"])
            return 202, ""

        billing._do_post_with_body = fake_post

        @billing.wrap_tool_handler
        async def handler(name, arguments, **kwargs):
            return "ok"

        await billing.start_session("sess_1", customer_id="cust_7")
        await asyncio.sleep(0)
        await handler("search", {}, session_id="sess_1")
        await billing.end_session()
        await billing.shutdown()

        hb_requests = [r for r in requests if r[0]["metricName"] == "system.session.heartbeat"]
        usage_requests = [r for r in requests if r[0]["metricName"] != "system.session.heartbeat"]
        assert all(len(r) == 1 for r in hb_requests), "heartbeats must be sent one per request"
        assert all(e["metricName"] != "system.session.heartbeat" for r in usage_requests for e in r)
        assert [e["toolName"] for r in usage_requests for e in r] == ["search"]
        boundaries = [r[0]["sessionBoundary"] for r in hb_requests]
        assert boundaries[0] == "HEARTBEAT" and boundaries[-1] == "SESSION_END"
        for r in hb_requests:
            hb = r[0]
            assert hb["quantity"] == 1
            assert hb["customerId"] == "cust_7"
            assert hb["productType"] == "MCP_SERVER"
            assert hb["sessionId"] == "sess_1"
            assert hb["occurredAt"].endswith("Z")
            assert hb["metadata"]["sessionId"] == "sess_1"
            assert hb["metadata"]["sessionBoundary"] == hb["sessionBoundary"]
            assert hb["metadata"]["productType"] == "MCP_SERVER"
        assert hb_requests[-1][0]["metadata"]["heartbeatType"] == "SESSION_END"
        assert len({r[0]["idempotencyKey"] for r in hb_requests}) == len(hb_requests)

    asyncio.run(scenario())


def test_periodic_heartbeats_stop_on_shutdown_and_failures_are_swallowed():
    async def scenario():
        billing = AforoMcpBilling(**dict(CFG, heartbeat_interval_sec=0.01))
        calls = []

        async def failing_post(url, headers, body):
            calls.append(json.loads(body)["events"])
            raise ConnectionError("down")

        billing._do_post_with_body = failing_post
        await billing.start_session("sess_1", product_type="ai_agent")
        await asyncio.sleep(0.06)
        await billing.shutdown()
        n = len(calls)
        assert n >= 3
        assert all(len(c) == 1 and c[0]["productType"] == "AI_AGENT" for c in calls)
        assert calls[0][0]["customerId"] == "system"
        await asyncio.sleep(0.03)
        assert len(calls) == n  # stopped

    asyncio.run(scenario())


def test_killed_session_from_heartbeat_response_stops_session_and_calls_back():
    async def scenario():
        killed = []
        billing = AforoMcpBilling(**dict(CFG, on_session_killed=lambda sid, why: killed.append((sid, why))))

        async def fake_post(url, headers, body):
            return 202, json.dumps({"accepted": 0, "killedSessionIds": ["sess_1"]})

        billing._do_post_with_body = fake_post
        await billing.start_session("sess_1")
        await asyncio.sleep(0.01)
        assert killed == [("sess_1", "SERVER_KILL")]
        assert billing._active_session_id is None
        await billing.shutdown()

    asyncio.run(scenario())


def test_product_type_option_and_per_call_override():
    async def scenario():
        billing = AforoMcpBilling(**dict(CFG, product_type=" agentic_api "))
        assert billing.product_type == "AGENTIC_API"
        posted = []

        async def fake_post(url, headers, body):
            posted.extend(json.loads(body)["events"])
            return 202, ""

        billing._do_post_with_body = fake_post

        @billing.wrap_tool_handler
        async def handler(name, arguments, **kwargs):
            return "ok"

        await handler("a", {}, agent_id="agent_1")
        await handler("b", {}, agent_id="agent_1", product_type="mcp_server")
        billing.record_tool_invocation("c", "agent_1", product_type="Custom")
        await billing.flush()
        assert [e["productType"] for e in posted] == ["AGENTIC_API", "MCP_SERVER", "CUSTOM"]
        assert AforoMcpBilling(**CFG).product_type == "MCP_SERVER"

    asyncio.run(scenario())


def test_invalid_invocations_dropped_via_on_error_and_fields_capped():
    errors = []
    billing = AforoMcpBilling(**dict(CFG, on_error=errors.append))
    billing.record_tool_invocation("", "agent_1")
    billing.record_tool_invocation("t", "x" * 65)
    assert len(billing._buffer) == 0 and len(errors) == 2
    billing.record_tool_invocation("t" * 80, "a" * 50)
    billing.record_tool_invocation("t", None)
    ev, ev2 = billing._buffer
    assert len(ev["toolName"]) == 64 and len(ev["agentId"]) == 36
    assert ev["customerId"] == "a" * 50
    assert ev2["agentId"] == "unknown"


def test_retry_rules_408_429_retry_after_and_errors_message():
    async def scenario():
        errors = []
        billing = AforoMcpBilling(**dict(CFG, on_error=errors.append))
        responses = [(429, "", "0"), (408, ""), (202, json.dumps({"failed": 0}))]
        calls = []

        async def fake_post(url, headers, body):
            calls.append(1)
            return responses.pop(0)

        billing._do_post_with_body = fake_post
        billing.record_tool_invocation("t", "agent_1")
        await billing.flush()
        assert len(calls) == 3 and errors == []

        responses[:] = [(400, json.dumps({"errors": [{"index": 0, "message": "unknown metric"}]}))]
        calls.clear()
        billing.record_tool_invocation("t", "agent_1")
        await billing.flush()
        assert len(calls) == 1
        assert "unknown metric" in str(errors[0])

    asyncio.run(scenario())


def test_flush_posts_batch_contract_in_slices_of_1000():
    async def scenario():
        billing = AforoMcpBilling(**dict(CFG, flush_count=5000))
        posts = []

        async def fake_post(url, headers, body):
            posts.append((url, headers, json.loads(body)))
            return 202, ""

        billing._do_post_with_body = fake_post
        for _ in range(2500):
            billing.record_tool_invocation("search", "agent_1", "sess_1", "SUCCESS", 12)
        await billing.flush()

        assert [u for u, _, _ in posts] == ["https://ingestor.example/v1/ingest/batch"] * 3
        assert [len(b["events"]) for _, _, b in posts] == [1000, 1000, 500]
        assert posts[0][1]["X-API-Key"] == "k"
        assert "Authorization" not in posts[0][1]
        events = [e for _, _, b in posts for e in b["events"]]
        assert all("apiKey" not in e for e in events)
        e = events[0]
        assert e["customerId"] == "agent_1"
        assert e["metricName"] == "mcp_server.tool_invocations"
        assert e["quantity"] == 1
        assert e["productType"] == "MCP_SERVER"
        assert e["toolName"] == "search"
        assert e["executionDurationMs"] == 12
        # Same tool, same millisecond: keys must still differ or the ingestor
        # dedupes real invocations.
        assert len({ev["idempotencyKey"] for ev in events}) == 2500

    asyncio.run(scenario())
