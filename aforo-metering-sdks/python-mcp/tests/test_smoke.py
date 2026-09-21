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


def test_sessions_never_put_heartbeats_in_usage_batch():
    """Heartbeats (quantity 0) fail the ingestor's @Positive check and take every
    real event in the same batch down with them, so none may be sent."""

    async def scenario():
        billing = AforoMcpBilling(**CFG)
        posted = []

        async def fake_post(url, headers, body):
            posted.extend(json.loads(body)["events"])
            return 202, ""

        billing._do_post_with_body = fake_post

        @billing.wrap_tool_handler
        async def handler(name, arguments, **kwargs):
            return "ok"

        await billing.start_session("sess_1")
        await asyncio.sleep(0)
        await handler("search", {}, session_id="sess_1")
        await billing.end_session()
        await billing.shutdown()

        assert posted, "expected the tool invocation to be flushed"
        assert all(e["metricName"] != "system.session.heartbeat" for e in posted)
        assert all(e["quantity"] > 0 for e in posted)

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
