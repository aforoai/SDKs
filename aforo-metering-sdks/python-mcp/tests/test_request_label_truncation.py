"""The tool name is the ``name`` of the client's ``tools/call`` request. An
over-long one is cut to the ingestor's 64-character limit and the call is still
metered, through the decorator and through ``record_tool_invocation``. Agent and
session ids are not altered and still drop the event as ``invalid``."""

import asyncio
import json
import logging

from aforo_mcp_metering.client import (
    AforoMcpBilling,
    _fit_idempotency_key,
    _sha256_hex,
    _truncate_utf16,
    _utf16_length,
)

CFG = dict(tenant_id="t", product_id="p", api_key="k", ingestor_url="https://ingestor.example")
ASTRAL = "\U0001F600"


def _billing(**kwargs):
    billing = AforoMcpBilling(**dict(CFG, **kwargs))
    requests = []

    async def fake_post(url, headers, body):
        requests.append(json.loads(body)["events"])
        return 202, ""

    billing._do_post_with_body = fake_post
    return billing, requests


def test_truncate_utf16_never_splits_a_surrogate_pair():
    assert _truncate_utf16("a" * 63 + ASTRAL, 64) == "a" * 63
    assert _truncate_utf16("a" * 62 + ASTRAL + "z", 64) == "a" * 62 + ASTRAL


def test_over_long_tool_name_is_truncated_and_call_is_metered(caplog):
    async def scenario():
        drops = []
        billing, requests = _billing(on_drop=lambda evs, reason: drops.append(reason))

        @billing.wrap_tool_handler
        async def handler(name, arguments, **kwargs):
            return "ok"

        first = "s" * 63 + ASTRAL + "x" * 40   # a cut at 64 would split the pair
        second = "s" * 64 + "y" * 40
        with caplog.at_level(logging.WARNING, logger="aforo_mcp_metering"):
            await handler(first, {}, agent_id="agent_1")
            await handler(second, {}, agent_id="agent_1")
        await billing.shutdown()

        events = [e for r in requests for e in r]
        assert len(events) == 2 and drops == [] and billing.dropped_count == 0
        assert events[0]["toolName"] == "s" * 63
        assert events[1]["toolName"] == "s" * 64
        for e in events:
            assert _utf16_length(e["toolName"]) <= 64
            e["toolName"].encode("utf-16-le")  # no lone surrogate
        warnings = [r for r in caplog.records if "truncated" in r.getMessage()]
        assert len(warnings) == 1 and "toolName" in warnings[0].getMessage()

        for event, full in zip(events, (first, second)):
            key = event["idempotencyKey"]
            assert len(key) <= 255
            _, _, agent, session, tool_part, millis, nonce = key.split(":")
            # Built from the full name, before truncation. These names fit in
            # the key, so they appear in it in full.
            assert tool_part == full
            assert key == _fit_idempotency_key(["mcp", "sdk", agent, session, full, millis, nonce], (4,))

    asyncio.run(scenario())


def test_tool_names_sharing_the_first_64_characters_get_different_keys():
    async def scenario():
        billing, requests = _billing()

        @billing.wrap_tool_handler
        async def handler(name, arguments, **kwargs):
            return "ok"

        first, second = "s" * 64 + "a" * 300, "s" * 64 + "b" * 300
        await handler(first, {}, agent_id="agent_1")
        await handler(second, {}, agent_id="agent_1")
        await billing.shutdown()
        events = [e for r in requests for e in r]
        assert events[0]["toolName"] == events[1]["toolName"] == "s" * 64
        parts = [e["idempotencyKey"].split(":") for e in events]
        # Too long for the key: the full name goes in as its SHA-256 digest.
        assert parts[0][4] == _sha256_hex(first) and parts[1][4] == _sha256_hex(second)
        assert parts[0][4] != parts[1][4]
        assert all(len(e["idempotencyKey"]) <= 255 for e in events)

    asyncio.run(scenario())


def test_key_is_deterministic_and_unchanged_when_it_fits():
    parts = ["mcp", "sdk", "agent_1", "no-session", "search", 1700000000000, "abcd1234"]
    assert _fit_idempotency_key(parts, (4,)) == "mcp:sdk:agent_1:no-session:search:1700000000000:abcd1234"
    long = ["mcp", "sdk", "agent_1", "no-session", "s" * 400, 1, "n"]
    assert _fit_idempotency_key(long, (4,)) == _fit_idempotency_key(list(long), (4,))


def test_record_tool_invocation_truncates_the_tool_name_too():
    async def scenario():
        billing, requests = _billing()
        billing.record_tool_invocation("t" * 65, "agent_1")
        await billing.shutdown()
        (event,) = [e for r in requests for e in r]
        assert event["toolName"] == "t" * 64 and billing.dropped_count == 0
        assert event["idempotencyKey"].split(":")[4] == "t" * 65  # full name in the key

    asyncio.run(scenario())


def test_ids_still_drop_as_invalid():
    async def scenario():
        drops = []
        billing, requests = _billing(on_drop=lambda evs, reason: drops.append((evs, reason)))

        @billing.wrap_tool_handler
        async def handler(name, arguments, **kwargs):
            return "ok"

        await handler("search", {}, agent_id="a" * 37)                   # agentId
        await handler("search", {}, agent_id="c" * 65)                   # customerId (sent from agent_id)
        await handler("t" * 100, {}, agent_id="agent_1", session_id="s" * 65)
        billing.record_tool_invocation("", "agent_1")                    # blank tool name
        await billing.shutdown()
        assert requests == [] and billing.dropped_count == 4
        assert [reason for _evs, reason in drops] == ["invalid"] * 4
        assert drops[0][0][0]["agentId"] == "a" * 37  # not altered
        assert drops[1][0][0]["customerId"] == "c" * 65

    asyncio.run(scenario())
