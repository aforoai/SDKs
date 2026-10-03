"""Field limits, invalid-event handling, batch cap, productType, default host.

An event the ingestor would reject is never buffered or sent and never raises:
it is counted in ``dropped_count``, WARN-logged, and handed to ``on_drop`` with
reason ``"invalid"`` (keeping its idempotency key). Limits mirror the server's
``IngestUsageEventRequest`` and are never stricter; nothing is truncated.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Tuple

import pytest

from aforo_agent_metering import AforoAgentClient, __version__, wrap_capability_handler
from aforo_agent_metering.client import DEFAULT_INGESTOR_URL, MAX_LENGTHS


def _client(**overrides: Any) -> AforoAgentClient:
    base: Dict[str, Any] = dict(
        tenant_id="tenant_test", product_id="prod_ai_001", api_key="k",
        ingestor_url="https://ingest.test.aforo.ai",
    )
    base.update(overrides)
    return AforoAgentClient(**base)


def test_default_host_is_the_public_api_gateway() -> None:
    assert DEFAULT_INGESTOR_URL == "https://api.aforo.ai"
    client = AforoAgentClient(tenant_id="t", product_id="p", api_key="k")
    assert client.ingestor_url == "https://api.aforo.ai"


def test_limits_mirror_the_server_dto() -> None:
    assert MAX_LENGTHS == {
        "customerId": 64, "metricName": 255, "idempotencyKey": 255, "productType": 20,
        "agentId": 36, "sessionId": 64, "capabilityName": 64,
    }


@pytest.mark.parametrize(
    "kwargs,needle",
    [
        (dict(capability_name="", agent_id="a"), "capability_name"),
        (dict(capability_name="c", agent_id=""), "agent_id"),
        (dict(capability_name="c", agent_id="a" * 37), "agentId"),
        (dict(capability_name="c" * 65, agent_id="a"), "capabilityName"),
        (dict(capability_name="c", agent_id="a", session_id="s" * 65), "sessionId"),
        (dict(capability_name="c", agent_id="a", customer_id="x" * 65), "customerId"),
    ],
)
def test_invalid_capability_event_is_dropped_not_raised(kwargs, needle, caplog) -> None:
    drops: List[Tuple[List[Dict[str, Any]], str]] = []
    client = _client(on_drop=lambda evs, reason: drops.append((evs, reason)))
    with caplog.at_level("WARNING", logger="aforo_agent_metering"):
        client.record_capability(**kwargs)  # must not raise
    assert len(client) == 0
    assert client.dropped_count == 1
    assert len(drops) == 1 and drops[0][1] == "invalid"
    assert drops[0][0][0]["idempotencyKey"].startswith("agent:")
    assert needle in caplog.text


def test_values_at_the_limit_are_accepted_and_not_truncated() -> None:
    client = _client()
    client.record_capability(
        capability_name="c" * 64, agent_id="a" * 36, session_id="s" * 64, customer_id="x" * 64,
    )
    assert len(client) == 1 and client.dropped_count == 0
    event = client._buffer.drain()[0]
    assert event["agentId"] == "a" * 36 and event["customerId"] == "x" * 64
    assert event["metadata"]["capability_name"] == "c" * 64
    assert event["metadata"]["sdkVersion"] == __version__ == "0.3.2"


def test_invalid_step_is_dropped_not_raised() -> None:
    drops: List[str] = []
    client = _client(on_drop=lambda evs, reason: drops.append(reason))
    client.record_step("", "s", "THOUGHT")
    client.record_step("a", "", "THOUGHT")
    client.record_step("a", "s", "")
    client.record_step("a", "s", "THOUGHT")
    assert drops == ["invalid"] * 3
    assert len(client) == 1 and client.dropped_count == 3


def test_invalid_warning_is_throttled(caplog) -> None:
    client = _client()
    with caplog.at_level("WARNING", logger="aforo_agent_metering"):
        for _ in range(1000):
            client.record_capability(capability_name="c", agent_id="")
    assert client.dropped_count == 1000
    assert caplog.text.count("invalid event not sent") == 2  # 1st and 1000th


def test_unknown_execution_status_is_not_an_invalid_event() -> None:
    client = _client()
    client.record_capability(capability_name="c", agent_id="a", execution_status="bogus")
    assert len(client) == 1 and client.dropped_count == 0


def test_product_type_default_option_and_per_event_override() -> None:
    client = _client(product_type=" agentic_api ")
    client.record_capability(capability_name="c", agent_id="a")
    client.record_capability(capability_name="c", agent_id="a", product_type="ai_agent")
    assert [e["productType"] for e in client._buffer.drain()] == ["AGENTIC_API", "AI_AGENT"]
    assert _client().product_type == "AI_AGENT"


@pytest.mark.asyncio
async def test_decorator_with_over_limit_agent_id_does_not_break_the_handler() -> None:
    drops: List[str] = []
    client = _client(on_drop=lambda evs, reason: drops.append(reason))

    @wrap_capability_handler(client, capability_name="c")
    async def handler(*, agent_id: str) -> str:
        return "ok"

    assert await handler(agent_id="a" * 40) == "ok"
    assert drops == ["invalid"] and len(client) == 0


@pytest.mark.asyncio
async def test_flush_count_clamped_and_flush_sent_in_slices_of_1000() -> None:
    sizes: List[int] = []

    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        sizes.append(len(json.loads(body)["events"]))
        return 202, ""

    client = _client(flush_count=5000, post_fn=post)
    assert client.flush_count == 1000
    for _ in range(2500):
        client._buffer._events.append({"x": 1})
    await client.flush()
    assert sizes == [1000, 1000, 500]


@pytest.mark.asyncio
async def test_partial_rejection_drops_only_the_named_events() -> None:
    drops: List[Tuple[List[Dict[str, Any]], str]] = []
    responses = [
        (202, json.dumps({"success": True, "data": {"accepted": 2, "failed": 1, "errors": [{"index": 1, "message": "unknown metric"}]}})),
        (202, json.dumps({"accepted": 1, "failed": 1})),
    ]

    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        return responses.pop(0)

    client = _client(post_fn=post, on_drop=lambda evs, reason: drops.append((evs, reason)))
    for cap in ("a", "b", "c"):
        client.record_capability(capability_name=cap, agent_id="agt")
    await client.flush()
    assert client.dropped_count == 1
    assert [(e["metadata"]["capability_name"], r) for evs, r in drops for e in evs] == [("b", "rejected")]

    client.record_capability(capability_name="d", agent_id="agt")
    client.record_capability(capability_name="e", agent_id="agt")
    await client.flush()
    # The response did not say which event failed: counted, none named.
    assert client.dropped_count == 2 and len(drops) == 1


@pytest.mark.asyncio
async def test_rejected_4xx_error_carries_the_ingestor_message() -> None:
    errors: List[Exception] = []

    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        return 400, json.dumps({"errors": [{"index": 0, "message": "unknown metric"}]})

    client = _client(post_fn=post, on_error=errors.append)
    client.record_capability(capability_name="c", agent_id="a")
    await client.flush()
    assert "unknown metric" in str(errors[0]) and client.dropped_count == 1
