"""Drop observability + opt-in on_drop hook tests for the MCP metering SDK."""

import asyncio
from unittest.mock import patch

from aforo_mcp_metering import AforoMcpBilling


def _billing(**kwargs) -> AforoMcpBilling:
    return AforoMcpBilling(
        tenant_id="tenant_test",
        product_id="prod_test",
        api_key="test-key",
        ingestor_url="https://ingest.test.aforo.ai",
        flush_interval_sec=3600.0,  # long — control flushing manually
        heartbeat_enabled=False,
        **kwargs,
    )


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_retry_exhaustion_drops_batch_counts_warns_and_fires_hook(caplog):
    drops = []
    billing = _billing(on_drop=lambda events, reason: drops.append((events, reason)))
    billing.record_tool_invocation("search", "agent_1", session_id="sess_1")

    async def scenario():
        async def failing_post(url, headers, body):
            raise OSError("connection refused")

        with patch.object(billing, "_do_post_with_body", side_effect=failing_post), \
             patch("asyncio.sleep", return_value=None):
            with caplog.at_level("WARNING", logger="aforo_mcp_metering"):
                await billing.flush()

    _run(scenario())

    assert billing.dropped_count == 1
    assert len(drops) == 1
    events, reason = drops[0]
    assert reason == "retry_exhausted"
    assert events[0]["toolName"] == "search"
    assert events[0]["idempotencyKey"]  # key preserved for dedup-safe replay
    assert any("Dropped 1 event" in r.message for r in caplog.records)


def test_5xx_exhaustion_previously_silent_now_drops_observably():
    reasons = []
    billing = _billing(on_drop=lambda events, reason: reasons.append(reason))
    billing.record_tool_invocation("search", "agent_1")

    async def scenario():
        async def post_503(url, headers, body):
            return 503, ""

        with patch.object(billing, "_do_post_with_body", side_effect=post_503), \
             patch("asyncio.sleep", return_value=None):
            await billing.flush()

    _run(scenario())

    assert billing.dropped_count == 1
    assert reasons == ["retry_exhausted"]


def test_rejected_4xx_fires_hook_with_rejected_reason():
    reasons = []
    errors = []
    billing = _billing(
        on_drop=lambda events, reason: reasons.append(reason),
        on_error=lambda e: errors.append(e),
    )
    billing.record_tool_invocation("search", "agent_1")

    async def scenario():
        async def post_400(url, headers, body):
            return 400, ""

        with patch.object(billing, "_do_post_with_body", side_effect=post_400):
            await billing.flush()

    _run(scenario())

    assert billing.dropped_count == 1
    assert reasons == ["rejected"]
    assert len(errors) == 1  # existing on_error still fires exactly once


def test_default_no_hook_counts_and_warns(caplog):
    billing = _billing()
    billing.record_tool_invocation("search", "agent_1")

    async def scenario():
        async def post_400(url, headers, body):
            return 400, ""

        with patch.object(billing, "_do_post_with_body", side_effect=post_400):
            with caplog.at_level("WARNING", logger="aforo_mcp_metering"):
                await billing.flush()

    _run(scenario())

    assert billing.dropped_count == 1
    assert any("Dropped" in r.message for r in caplog.records)


def test_raising_hook_never_breaks_flush():
    def bad_hook(events, reason):
        raise RuntimeError("hook bug")

    billing = _billing(on_drop=bad_hook)
    billing.record_tool_invocation("search", "agent_1")

    async def scenario():
        async def post_400(url, headers, body):
            return 400, ""

        with patch.object(billing, "_do_post_with_body", side_effect=post_400):
            await billing.flush()  # must not raise

    _run(scenario())
    assert billing.dropped_count == 1


def test_happy_path_unchanged_no_drops(caplog):
    calls = []
    billing = _billing(on_drop=lambda events, reason: calls.append(reason))
    billing.record_tool_invocation("search", "agent_1")

    async def scenario():
        async def post_202(url, headers, body):
            return 202, ""

        with patch.object(billing, "_do_post_with_body", side_effect=post_202):
            with caplog.at_level("WARNING", logger="aforo_mcp_metering"):
                await billing.flush()

    _run(scenario())

    assert billing.dropped_count == 0
    assert calls == []
    assert not [r for r in caplog.records if r.levelname == "WARNING"]
