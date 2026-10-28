"""Drop observability + opt-in on_drop hook tests for the MCP metering SDK.

Wave 5: an outage keeps the batch queued (retried after a pause) instead of
dropping it. Events are lost only on overflow, rejection, invalid input, the
shutdown deadline ("shutdown") or a call after shutdown ("closed")."""

import asyncio

from aforo_mcp_metering import AforoMcpBilling

from .mcp_fakes import use_fake_post


def _billing(**kwargs) -> AforoMcpBilling:
    return AforoMcpBilling(
        tenant_id="tenant_test",
        product_id="prod_test",
        api_key="test-key",
        ingestor_url="https://ingest.example.test",
        flush_interval_sec=3600.0,  # long — control flushing manually
        heartbeat_enabled=False,
        **kwargs,
    )


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _record(billing, tool="search", **kw):
    billing.record_tool_invocation(tool, "agent_1", customer_id="cust_1", **kw)


def test_network_outage_keeps_the_batch_and_shutdown_reports_it(caplog):
    drops = []
    billing = _billing(on_drop=lambda events, reason: drops.append((events, reason)), shutdown_timeout_sec=0.3)

    async def failing_post(url, headers, body):
        raise OSError("connection refused")

    use_fake_post(billing, failing_post)
    _record(billing, session_id="sess_1")

    async def scenario():
        with caplog.at_level("WARNING", logger="aforo_mcp_metering"):
            pending = await billing.flush()
        assert pending == 1 and billing.dropped_count == 0  # requeued, not dropped
        await billing.shutdown()

    _run(scenario())
    assert billing.dropped_count == 1
    events, reason = drops[0]
    assert reason == "shutdown"
    assert events[0]["toolName"] == "search"
    assert events[0]["idempotencyKey"]  # key preserved for dedup-safe replay
    assert any("unreachable" in r.message for r in caplog.records)


def test_5xx_outage_then_recovery_loses_nothing():
    responses = [(503, "")] * 4
    posts = []

    async def post(url, headers, body):
        posts.append(body)
        return responses.pop(0) if responses else (202, "")

    billing = _billing(transport_options={"breaker_initial": 0.01, "breaker_max": 0.01})
    use_fake_post(billing, post)
    _record(billing)

    async def scenario():
        await billing.flush()
        for _ in range(500):
            if len(posts) >= 5:
                break
            await asyncio.sleep(0.01)
        await billing.shutdown()

    _run(scenario())
    assert len(posts) == 5 and len(set(posts)) == 1  # same body, same key
    assert billing.dropped_count == 0


def test_rejected_4xx_fires_hook_with_rejected_reason():
    reasons = []
    billing = _billing(on_drop=lambda events, reason: reasons.append(reason))

    async def post_400(url, headers, body):
        return 400, ""

    use_fake_post(billing, post_400)
    _record(billing)
    _run(billing.flush())
    billing.shutdown_sync()
    assert billing.dropped_count == 1
    assert reasons == ["rejected"]


def test_default_no_hook_counts_and_warns(caplog):
    billing = _billing()

    async def post_400(url, headers, body):
        return 400, ""

    use_fake_post(billing, post_400)
    _record(billing)
    with caplog.at_level("WARNING", logger="aforo_mcp_metering"):
        _run(billing.flush())
    billing.shutdown_sync()
    assert billing.dropped_count == 1
    assert any("Dropped 1 event" in r.message for r in caplog.records)


def test_raising_hook_never_breaks_flush():
    def bad_hook(events, reason):
        raise RuntimeError("hook bug")

    billing = _billing(on_drop=bad_hook)

    async def post_400(url, headers, body):
        return 400, ""

    use_fake_post(billing, post_400)
    _record(billing)
    _run(billing.flush())  # must not raise
    billing.shutdown_sync()
    assert billing.dropped_count == 1


def test_happy_path_no_drops(caplog):
    hook_calls = []
    billing = _billing(on_drop=lambda e, r: hook_calls.append(r))

    async def post_202(url, headers, body):
        return 202, ""

    use_fake_post(billing, post_202)
    _record(billing)
    with caplog.at_level("WARNING", logger="aforo_mcp_metering"):
        assert _run(billing.flush()) == 0
    billing.shutdown_sync()
    assert billing.dropped_count == 0
    assert hook_calls == []


def test_call_after_shutdown_is_dropped_as_closed():
    reasons = []
    billing = _billing(on_drop=lambda e, r: reasons.append(r))
    billing.shutdown_sync(timeout=0)
    _record(billing)
    assert reasons == ["closed"]
