"""``wrap_capability_handler`` cuts a capability name it reads from the wrapped
call's ``capability_name`` kwarg to the ingestor's 64-character limit and still
sends the event. A name given to the decorator, or to ``record_capability``, and
every id field, is not altered and still drops the event as ``invalid``."""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Tuple

import pytest

from aforo_agent_metering import AforoAgentClient, wrap_capability_handler
from aforo_agent_metering import client as mod
from aforo_agent_metering.client import _truncate_utf16, _utf16_length, truncate_capability_name

ASTRAL = "\U0001F600"


@pytest.fixture(autouse=True)
def _fresh_warnings():
    mod._truncation_warned.clear()
    yield
    mod._truncation_warned.clear()


def _client(captured: List[Dict[str, Any]], **overrides: Any) -> AforoAgentClient:
    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        captured.extend(json.loads(body)["events"])
        return 202, ""

    return AforoAgentClient(
        tenant_id="tenant_test", product_id="prod_ai_001", api_key="k",
        ingestor_url="https://ingest.test.aforo.ai", flush_interval_sec=3600.0,
        post_fn=post, **overrides,
    )


def test_truncate_utf16_never_splits_a_surrogate_pair() -> None:
    assert _truncate_utf16("a" * 63 + ASTRAL, 64) == "a" * 63
    assert _truncate_utf16("a" * 62 + ASTRAL + "z", 64) == "a" * 62 + ASTRAL
    assert truncate_capability_name(None) is None


@pytest.mark.asyncio
async def test_over_long_capability_from_call_kwargs_is_truncated_and_sent(caplog) -> None:
    sent: List[Dict[str, Any]] = []
    drops: List[str] = []
    client = _client(sent, on_drop=lambda evs, reason: drops.append(reason))

    @wrap_capability_handler(client)
    async def dispatch(*, agent_id: str, capability_name: str) -> str:
        return "ok"

    first = "c" * 63 + ASTRAL + "x" * 40  # a cut at 64 would split the pair
    second = "c" * 64 + "y" * 40
    with caplog.at_level(logging.WARNING, logger="aforo_agent_metering"):
        await dispatch(agent_id="agt_1", capability_name=first)
        await dispatch(agent_id="agt_1", capability_name=second)
    await client.flush()

    assert len(sent) == 2 and drops == [] and client.dropped_count == 0
    assert sent[0]["metadata"]["capability_name"] == "c" * 63
    assert sent[1]["metadata"]["capability_name"] == "c" * 64
    for event in sent:
        name = event["metadata"]["capability_name"]
        assert _utf16_length(name) <= 64 and event["metadata"]["capabilityName"] == name
        name.encode("utf-16-le")  # no lone surrogate
    warnings = [r for r in caplog.records if "truncated" in r.getMessage()]
    assert len(warnings) == 1 and "capabilityName" in warnings[0].getMessage()
    # The key is "agent:<uuid>", minted per event: it does not contain the
    # capability name, so truncation cannot make two calls share a key.
    keys = [e["idempotencyKey"] for e in sent]
    assert all(k.startswith("agent:") and len(k) == 42 for k in keys) and keys[0] != keys[1]


@pytest.mark.asyncio
async def test_caller_set_values_still_drop_as_invalid() -> None:
    sent: List[Dict[str, Any]] = []
    drops: List[str] = []
    client = _client(sent, on_drop=lambda evs, reason: drops.append(reason))

    @wrap_capability_handler(client, capability_name="d" * 65)  # the caller's own name
    async def fixed(*, agent_id: str) -> str:
        return "ok"

    @wrap_capability_handler(client)
    async def dispatch(*, agent_id: str, customer_id: str, capability_name: str) -> str:
        return "ok"

    await fixed(agent_id="agt_1")
    await dispatch(agent_id="agt_1", customer_id="x" * 65, capability_name="c" * 100)
    client.record_capability(capability_name="c" * 65, agent_id="agt_1")
    await client.flush()

    assert sent == [] and client.dropped_count == 3
    assert drops == ["invalid"] * 3
