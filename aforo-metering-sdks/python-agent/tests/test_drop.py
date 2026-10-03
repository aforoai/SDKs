"""Drop observability + opt-in on_drop hook (A+ delivery-guarantee
prompt 2 mirror).

The client sends each batch with 3× retry (5xx / network) or terminal
rejection (4xx). Failed batches are counted, WARN-logged, and handed to
the OPT-IN ``on_drop`` hook so the application can persist + replay
after recovery. Dropped events retain their idempotency keys so replay
is dedup-safe on the ingestor side.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

import pytest

from aforo_agent_metering import AforoAgentClient


def _client(**overrides: Any) -> AforoAgentClient:
    return AforoAgentClient(
        tenant_id="tenant_test",
        product_id="prod_ai_001",
        api_key="sk_agent_abc",
        ingestor_url="https://ingest.test.aforo.ai",
        flush_interval_sec=3600.0,  # long — control flush manually
        **overrides,
    )


async def _immediate_sleep(_: float) -> None:
    """asyncio.sleep replacement that returns immediately."""
    return None


async def _post_status(status: int, body: str = ""):
    """Factory that returns a post_fn that always returns ``status``."""

    async def post_fn(url: str, headers: Dict[str, str], body_arg: str) -> Tuple[int, str]:
        return status, body

    return post_fn


@pytest.mark.asyncio
async def test_network_failure_after_retries_drops_batch_and_fires_hook(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    drops: List[Tuple[List[Dict[str, Any]], str]] = []

    async def failing_post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        raise OSError("ECONNREFUSED")

    from aforo_agent_metering import transport as transport_module

    monkeypatch.setattr(transport_module.asyncio, "sleep", _immediate_sleep)

    client = _client(
        post_fn=failing_post,
        on_drop=lambda events, reason: drops.append((events, reason)),
    )
    client.record_capability(capability_name="search", agent_id="agent_1")

    with caplog.at_level("WARNING", logger="aforo_agent_metering"):
        await client.flush()

    assert client.dropped_count == 1
    assert len(drops) == 1
    events, reason = drops[0]
    assert reason == "retry_exhausted"
    assert events[0]["metadata"]["capability_name"] == "search"
    # Idempotency key preserved — dedup-safe replay after operator persists.
    assert events[0]["idempotencyKey"].startswith("agent:")
    assert any("dropped 1" in r.message.lower() for r in caplog.records)


@pytest.mark.asyncio
async def test_5xx_response_after_retries_drops_batch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reasons: List[str] = []
    from aforo_agent_metering import transport as transport_module

    monkeypatch.setattr(transport_module.asyncio, "sleep", _immediate_sleep)

    async def post_503(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        return 503, ""

    client = _client(
        post_fn=post_503,
        on_drop=lambda events, reason: reasons.append(reason),
    )
    client.record_capability(capability_name="search", agent_id="agent_1")
    await client.flush()

    assert client.dropped_count == 1
    assert reasons == ["retry_exhausted"]


@pytest.mark.asyncio
async def test_4xx_response_drops_immediately_with_rejected_reason() -> None:
    reasons: List[str] = []
    errors: List[Exception] = []

    async def post_400(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        return 400, "validation failed"

    client = _client(
        post_fn=post_400,
        on_drop=lambda events, reason: reasons.append(reason),
        on_error=lambda e: errors.append(e),
    )
    client.record_capability(capability_name="search", agent_id="agent_1")
    await client.flush()

    assert client.dropped_count == 1
    assert reasons == ["rejected"]
    assert len(errors) == 1


@pytest.mark.asyncio
async def test_default_no_hook_still_counts_and_warns(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def post_400(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        return 400, ""

    client = _client(post_fn=post_400)
    client.record_capability(capability_name="search", agent_id="agent_1")

    with caplog.at_level("WARNING", logger="aforo_agent_metering"):
        await client.flush()

    assert client.dropped_count == 1
    assert any("dropped" in r.message.lower() for r in caplog.records)


@pytest.mark.asyncio
async def test_raising_on_drop_never_breaks_flush() -> None:
    def bad_hook(events: List[Dict[str, Any]], reason: str) -> None:
        raise RuntimeError("hook bug")

    async def post_400(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        return 400, ""

    client = _client(post_fn=post_400, on_drop=bad_hook)
    client.record_capability(capability_name="search", agent_id="agent_1")
    # Must not raise.
    await client.flush()
    assert client.dropped_count == 1


@pytest.mark.asyncio
async def test_happy_path_no_drops_no_warns(caplog: pytest.LogCaptureFixture) -> None:
    dropped: List[str] = []

    async def post_202(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        return 202, ""

    client = _client(
        post_fn=post_202,
        on_drop=lambda _e, reason: dropped.append(reason),
    )
    client.record_capability(capability_name="search", agent_id="agent_1")

    with caplog.at_level("WARNING", logger="aforo_agent_metering"):
        await client.flush()

    assert client.dropped_count == 0
    assert dropped == []
    assert not [r for r in caplog.records if r.levelname == "WARNING"]


@pytest.mark.asyncio
async def test_dropped_events_preserve_idempotency_keys() -> None:
    """The whole point of the drop hook is dedup-safe replay after
    recovery. The keys must survive the drop path."""
    captured_events: List[Dict[str, Any]] = []

    async def post_400(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        return 400, ""

    def hook(events: List[Dict[str, Any]], _reason: str) -> None:
        captured_events.extend(events)

    client = _client(post_fn=post_400, on_drop=hook)
    client.record_capability(capability_name="a", agent_id="agent_1")
    client.record_capability(capability_name="b", agent_id="agent_1")
    await client.flush()

    assert len(captured_events) == 2
    for ev in captured_events:
        assert ev["idempotencyKey"].startswith("agent:")
