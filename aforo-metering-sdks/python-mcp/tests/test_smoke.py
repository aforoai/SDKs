import asyncio

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
