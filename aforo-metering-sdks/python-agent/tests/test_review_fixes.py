"""Regression tests for the 2026-11-09 SDK review (python-agent findings 3, 4, 5, 6, 9
and rules R1-R3)."""

from __future__ import annotations

import logging
import re
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

import aforo_agent_metering.client as client_module
from aforo_agent_metering import AforoAgentClient, session_trace_id, wrap_capability_handler


def _client(**overrides: Any) -> Tuple[AforoAgentClient, List[Tuple[str, Dict[str, Any]]]]:
    drops: List[Tuple[str, Dict[str, Any]]] = []
    base: Dict[str, Any] = dict(
        tenant_id="tenant_test", product_id="prod_ai_001", api_key="sk_review_test",
        ingestor_url="https://ingest.example.test", flush_interval_sec=3600.0,
        on_drop=lambda events, reason: drops.append((reason, events[0])),
    )
    base.update(overrides)
    return AforoAgentClient(**base), drops


# ── finding 3: an AI_AGENT event needs a session ────────────────


def test_capability_without_session_is_dropped_before_queueing(caplog):
    client, drops = _client()
    with caplog.at_level(logging.WARNING, logger="aforo_agent_metering"):
        client.record_capability("summarize_email", "agt_001", customer_id="cust_42")
        client.record_capability("summarize_email", "agt_001", customer_id="cust_42", session_id="  ")
        client.record_capability("summarize_email", "agt_001", customer_id="cust_42", session_id="sess_1")
    assert len(client) == 1 and [r for r, _ in drops] == ["invalid", "invalid"]
    assert "session_id is required for AI_AGENT" in caplog.text
    client.shutdown_sync(timeout=0)


def test_other_product_types_do_not_need_a_session():
    client, drops = _client()
    client.record_capability("c", "agt", customer_id="cust", product_type="agentic_api")
    assert len(client) == 1 and drops == []
    client.shutdown_sync(timeout=0)


@pytest.mark.asyncio
async def test_decorated_call_without_session_is_dropped():
    client, drops = _client(default_customer_id="cust")

    @wrap_capability_handler(client, capability_name="summarize")
    async def summarize(text: str, *, agent_id: str) -> str:
        return "ok"

    assert await summarize("hi", agent_id="agt") == "ok"
    assert len(client) == 0 and drops[0][0] == "invalid" and drops[0][1]["sessionId"] is None
    await client.shutdown(timeout=0)


# ── finding 4: token counts never raise ─────────────────────────


@pytest.mark.parametrize("value,expected", [(None, 0), ("84", 84), (" 84 ", 84), (84.0, 84), ("84.0", 84),
                                            (Decimal("84"), 84)])
def test_token_counts_are_coerced(value, expected):
    client, drops = _client()
    client.record_capability("c", "a", customer_id="cust", session_id="s", input_tokens=value, output_tokens=value)
    (event,) = client._buffer
    meta = event["metadata"]
    assert meta["input_tokens"] == meta["output_tokens"] == meta["inputTokens"] == expected
    assert meta["totalTokens"] == 2 * expected and drops == []
    client.shutdown_sync(timeout=0)


@pytest.mark.parametrize("value", ["lots", 84.5, True, float("nan"), [1], object()])
def test_bad_token_counts_drop_the_event_and_never_raise(value):
    client, drops = _client()
    client.record_capability("c", "a", customer_id="cust", session_id="s", input_tokens=value)
    client.record_step("a", "s", "THOUGHT", customer_id="cust", output_tokens=value)
    assert len(client) == 0 and [r for r, _ in drops] == ["invalid", "invalid"]
    client.shutdown_sync(timeout=0)


# ── R2: metadata must be a dict ─────────────────────────────────


@pytest.mark.parametrize("bad", ["region=eu", [("region", "eu")], 7])
def test_metadata_that_is_not_a_dict_drops_the_event(bad, caplog):
    client, drops = _client()
    with caplog.at_level(logging.WARNING, logger="aforo_agent_metering"):
        client.record_capability("c", "a", customer_id="cust", session_id="s", metadata=bad)
        client.record_step("a", "s", "THOUGHT", customer_id="cust", metadata=bad)
    assert len(client) == 0 and [r for r, _ in drops] == ["invalid", "invalid"]
    assert "metadata must be a dict" in caplog.text
    client.shutdown_sync(timeout=0)


# ── finding 5: a failed resolver never bills the default customer ──


@pytest.mark.asyncio
async def test_resolver_that_finds_no_customer_is_not_billed_to_the_default():
    client, drops = _client(default_customer_id="cust_house")

    def resolver(args, kwargs):
        if kwargs.get("user") == "raise":
            raise LookupError("anonymous caller")
        return kwargs.get("user")

    @wrap_capability_handler(client, capability_name="summarize", customer_resolver=resolver)
    async def summarize(*, agent_id: str, session_id: str, user: Any = None) -> str:
        return "ok"

    assert await summarize(agent_id="agt", session_id="s", user="raise") == "ok"
    assert await summarize(agent_id="agt", session_id="s") == "ok"  # resolver returns None
    assert await summarize(agent_id="agt", session_id="s", user="cust_real") == "ok"
    assert [e["customerId"] for e in client._buffer] == ["cust_real"]
    assert [r for r, _ in drops] == ["invalid", "invalid"]
    await client.shutdown(timeout=0)


@pytest.mark.asyncio
async def test_default_customer_still_bills_when_no_resolver_was_given():
    client, drops = _client(default_customer_id="cust_house")

    @wrap_capability_handler(client, capability_name="summarize")
    async def summarize(*, agent_id: str, session_id: str) -> str:
        return "ok"

    await summarize(agent_id="agt", session_id="s")
    assert [e["customerId"] for e in client._buffer] == ["cust_house"] and drops == []
    await client.shutdown(timeout=0)


# ── finding 6: traceId per session and node-agent token keys ────


def test_events_of_one_session_share_a_node_style_trace_id():
    client, _ = _client()
    client.record_capability("c", "agt", customer_id="cust", session_id="sess_1", input_tokens=320, output_tokens=84)
    client.record_step("agt", "sess_1", "THOUGHT", customer_id="cust")
    client.record_capability("c", "agt", customer_id="cust", session_id="sess_2")
    client.record_capability("c", "agt", customer_id="cust", session_id="sess_3", trace_id="4bf92f3577b34da6a3ce929d0e0e4736")
    first, step, other, explicit = client._buffer
    assert re.fullmatch(r"[0-9a-f]{32}", first["traceId"])
    assert first["traceId"] == step["traceId"] == session_trace_id("prod_ai_001", "cust", "agt", "sess_1")
    assert other["traceId"] != first["traceId"]
    assert explicit["traceId"] == "4bf92f3577b34da6a3ce929d0e0e4736"
    meta = first["metadata"]
    assert meta["input_tokens"] == 320 and meta["output_tokens"] == 84  # what node-agent sends
    client.shutdown_sync(timeout=0)


def test_over_long_trace_id_is_invalid():
    client, drops = _client()
    client.record_capability("c", "agt", customer_id="cust", session_id="s", trace_id="t" * 129)
    assert len(client) == 0 and drops[0][0] == "invalid"
    client.shutdown_sync(timeout=0)


# ── R1 / R3 ─────────────────────────────────────────────────────


def test_occurred_at_has_seconds_and_z():
    client, _ = _client()
    client.record_capability("c", "agt", customer_id="cust", session_id="s")
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", client._buffer[0]["occurredAt"])
    client.shutdown_sync(timeout=0)


def test_duration_out_of_java_int_range_is_left_off_and_the_event_kept(caplog):
    client, drops = _client()
    with caplog.at_level(logging.WARNING, logger="aforo_agent_metering"):
        for value in (2 ** 31, "soon", float("inf"), 510.7, "510", 2 ** 31 - 1):
            client.record_capability("c", "agt", customer_id="cust", session_id="s", execution_duration_ms=value)
        client.record_step("agt", "s", "THOUGHT", customer_id="cust", duration_ms=-(2 ** 31) - 1)
    events = client._buffer
    assert len(events) == 7 and drops == []
    assert [e.get("executionDurationMs") for e in events] == [None, None, None, 510, 510, 2 ** 31 - 1, None]
    assert caplog.text.count("not a number a Java int can hold") == 1
    client.shutdown_sync(timeout=0)


# ── finding 9: truthiness and docs ──────────────────────────────


def test_an_idle_client_is_truthy():
    client, _ = _client()
    assert len(client) == 0 and bool(client) is True
    client.shutdown_sync(timeout=0)


def test_docs_and_metadata_name_the_real_version():
    root = Path(__file__).resolve().parents[1]
    version = client_module.__version__
    assert f'version = "{version}"' in (root / "pyproject.toml").read_text()
    assert f"version = {version}" in (root / "setup.cfg").read_text()
    for doc in ("README.md", "USER_GUIDE.md"):
        text = (root / doc).read_text()
        assert f"**Version:** {version}" in text, doc
        assert "`compression`" in text, doc
    changelog = (root / "CHANGELOG.md").read_text()
    assert "## [Unreleased]" in changelog and f"## [{version}]" in changelog
