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
