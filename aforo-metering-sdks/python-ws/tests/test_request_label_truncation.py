"""``wsCloseReason`` may carry text from the peer's close frame. An over-long
one is cut to the ingestor's 32-character limit, counted in UTF-16 code units,
and the event is still sent. ``customerId`` still drops the event as invalid."""

from __future__ import annotations

import logging

import pytest

from aforo_ws_metering import client as mod
from aforo_ws_metering.client import AforoWsBilling, _truncate_utf16, _utf16_length

ASTRAL = "\U0001F600"


@pytest.fixture
def sent(monkeypatch):
    batches: list = []

    def post(url, body, headers):
        batches.append(body["events"])
        return 202, None, b""

    monkeypatch.setattr(mod, "_post_json", post)
    return batches


def _billing(**kwargs):
    return AforoWsBilling(
        tenant_id="tenant-001", product_id="prod-ws-001", api_key="k",
        ingestor_url="https://api.aforo.ai", flush_interval_sec=3600, flush_count=1000, **kwargs,
    )


def _close(reason, customer_id="cust_1", connection_id="conn-1"):
    return {"customerId": customer_id, "wsConnectionId": connection_id,
            "wsFrameType": "CLOSE", "wsCloseReason": reason}


def test_truncate_utf16_never_splits_a_surrogate_pair():
    assert _truncate_utf16("a" * 31 + ASTRAL, 32) == "a" * 31
    assert _truncate_utf16("a" * 30 + ASTRAL + "z", 32) == "a" * 30 + ASTRAL


def test_over_long_close_reason_is_truncated_and_event_is_sent(sent, caplog):
    drops: list = []
    b = _billing(on_drop=lambda evs, reason: drops.append(reason))
    with caplog.at_level(logging.WARNING, logger="aforo_ws_metering"):
        b.push(_close("r" * 31 + ASTRAL + "tail"))   # a cut at 32 would split the pair
        b.push(_close(ASTRAL * 20))                  # 20 code points, 40 UTF-16 units
        b.push(_close("NORMAL_CLOSURE"))
    b.shutdown()
    events = [e for batch in sent for e in batch]
    assert len(events) == 3 and drops == [] and b.dropped_count == 0
    assert events[0]["wsCloseReason"] == "r" * 31
    assert events[1]["wsCloseReason"] == ASTRAL * 16
    assert events[2]["wsCloseReason"] == "NORMAL_CLOSURE"
    for e in events:
        assert _utf16_length(e["wsCloseReason"]) <= 32
        e["wsCloseReason"].encode("utf-16-le")  # no lone surrogate
    warnings = [r for r in caplog.records if "truncated" in r.getMessage()]
    assert len(warnings) == 1 and "wsCloseReason" in warnings[0].getMessage()
    # The key does not contain the close reason.
    assert all(e["idempotencyKey"].startswith("ws:tenant-001:conn-1:CLOSE:") for e in events)
    assert len({e["idempotencyKey"] for e in events}) == 3


def test_over_long_customer_id_still_dropped_as_invalid(sent):
    drops: list = []
    b = _billing(on_drop=lambda evs, reason: drops.append((evs, reason)))
    b.push(_close("r" * 100, customer_id="c" * 65))
    b.shutdown()
    assert sent == [] and b.dropped_count == 1
    assert [reason for _evs, reason in drops] == ["invalid"]
    assert drops[0][0][0]["customerId"] == "c" * 65
