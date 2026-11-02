"""executionStatus on WebSocket events (P6 item 15).

Explicit only (same as node-ws, java-ws, go-ws): values are trimmed +
upper-cased and left off the wire when unset or blank. The connection
trackers put the caller's value on the CONNECTION_CLOSED event and derive
nothing -- a close with or without an exception sends no status unless set.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, List
from unittest import mock

import pytest

from aforo_ws_metering import client as mod
from aforo_ws_metering import (
    AforoWsBilling,
    track_starlette_websocket,
    track_websockets_connection,
)


class _FakeHttp:
    def __init__(self) -> None:
        self.bodies: List[Dict[str, Any]] = []

    def urlopen(self, req, timeout=None):  # noqa: ARG002
        self.bodies.append(json.loads(req.data.decode("utf-8")))

        class _R:
            status = 202

            def __enter__(self_i):
                return self_i

            def __exit__(self_i, *_a):
                return False

        return _R()


@pytest.fixture
def http(monkeypatch):
    monkeypatch.setattr(mod, "HAS_HTTPX", False, raising=False)
    fake = _FakeHttp()
    with mock.patch("urllib.request.urlopen", side_effect=fake.urlopen):
        yield fake


def _billing(**kw: Any) -> AforoWsBilling:
    return AforoWsBilling(
        tenant_id="tenant-001",
        product_id="prod-ws-001",
        api_key="sk_ws_abc",
        ingestor_url="https://api.aforo.ai",
        flush_count=1000,
        flush_interval_sec=60,
        **kw,
    )


def _events(http: _FakeHttp) -> List[Dict[str, Any]]:
    return [e for body in http.bodies for e in body["events"]]


FRAME = {"customerId": "cust_001", "wsConnectionId": "c1", "wsFrameType": "TEXT"}


# ── push() ───────────────────────────────────────────────────────────────


def test_push_keyword_trimmed_and_upper_cased(http):
    b = _billing()
    b.push(dict(FRAME), execution_status=" partial ")
    b.shutdown()
    assert _events(http)[0]["executionStatus"] == "PARTIAL"


def test_push_reads_partial_key_and_keyword_wins(http):
    b = _billing()
    b.push({**FRAME, "executionStatus": "timeout"})
    b.push({**FRAME, "executionStatus": "timeout"}, execution_status="blocked")
    b.push({**FRAME, "executionStatus": "timeout"}, execution_status="  ")  # blank keyword = unset
    b.shutdown()
    assert [e["executionStatus"] for e in _events(http)] == ["TIMEOUT", "BLOCKED", "TIMEOUT"]


def test_push_omits_when_unset_or_blank(http):
    b = _billing()
    b.push(dict(FRAME))
    b.push({**FRAME, "executionStatus": ""})
    b.push({**FRAME, "executionStatus": None}, execution_status=None)
    b.shutdown()
    events = _events(http)
    assert len(events) == 3
    assert all("executionStatus" not in e for e in events)


def test_push_execution_status_is_keyword_only():
    b = _billing()
    try:
        with pytest.raises(TypeError):
            b.push(dict(FRAME), "SUCCESS")  # type: ignore[misc]
    finally:
        b.shutdown()


# ── Trackers ─────────────────────────────────────────────────────────────


class _FakeWebsocketsConn:
    def __init__(self) -> None:
        self._queue = ["one", b"two"]

    async def send(self, data):
        return None

    async def recv(self):
        return self._queue.pop(0)


class _FakeStarletteWs:
    async def send_text(self, data):
        return None

    async def send_bytes(self, data):
        return None

    async def receive_text(self):
        return "hi"

    async def receive_bytes(self):
        return b"hi"


async def _websockets_session(b, *, raise_exc=False, set_status=None, **kwargs):
    ws = _FakeWebsocketsConn()
    tracker = await track_websockets_connection(b, ws, "cust_001", **kwargs)
    try:
        async with tracker as t:
            await ws.recv()
            await ws.send("x")
            if set_status is not None:
                t.execution_status = set_status
            if raise_exc:
                raise RuntimeError("handler failed")
    except RuntimeError:
        pass


async def _starlette_session(b, *, raise_exc=False, set_status=None, **kwargs):
    ws = _FakeStarletteWs()
    ctx = await track_starlette_websocket(b, ws, "cust_001", **kwargs)
    try:
        async with ctx as c:
            await ws.receive_text()
            await ws.send_text("x")
            if set_status is not None:
                c.execution_status = set_status
            if raise_exc:
                raise RuntimeError("handler failed")
    except RuntimeError:
        pass


def _closed(http):
    events = _events(http)
    return [e for e in events if e["metadata"].get("event") == "CONNECTION_CLOSED"]


@pytest.mark.parametrize("session", [_websockets_session, _starlette_session])
def test_tracker_sends_no_status_unless_set_with_or_without_exception(http, session):
    b = _billing(per_frame_events=True)
    asyncio.run(session(b))
    asyncio.run(session(b, raise_exc=True))
    b.shutdown()
    closed = _closed(http)
    assert [e["wsCloseReason"] for e in closed] == ["NORMAL_CLOSURE", "INTERNAL_ERROR"]
    events = _events(http)
    assert len(events) > 2
    assert all("executionStatus" not in e for e in events)


@pytest.mark.parametrize("session", [_websockets_session, _starlette_session])
def test_tracker_explicit_value_on_close_event_only(http, session):
    b = _billing(per_frame_events=True)
    asyncio.run(session(b, raise_exc=True, execution_status=" hitl_required "))
    asyncio.run(session(b, set_status="partial"))
    asyncio.run(session(b, raise_exc=True, execution_status="timeout", set_status="   "))  # blank attribute = unset
    b.shutdown()
    assert [e.get("executionStatus") for e in _closed(http)] == ["HITL_REQUIRED", "PARTIAL", None]
    others = [e for e in _events(http) if e["metadata"].get("event") != "CONNECTION_CLOSED"]
    assert others and all("executionStatus" not in e for e in others)


@pytest.mark.parametrize("fn", [track_websockets_connection, track_starlette_websocket])
def test_tracker_execution_status_is_keyword_only(fn):
    b = _billing()
    try:
        with pytest.raises(TypeError):
            asyncio.run(fn(b, _FakeWebsocketsConn(), "cust_001", None, "SUCCESS"))
    finally:
        b.shutdown()


def _contract_statuses():
    from pathlib import Path
    here = Path(__file__).resolve()
    fixture = json.loads((here.parents[2] / "contract" / "ingest-contract.json").read_text())
    endpoint = fixture["sdks"][here.parents[1].name]["endpoint"]
    spec = fixture["endpoints"][endpoint]["eventOptionalFields"]["executionStatus"]
    return spec["values"], spec["maxLength"]


def test_canonical_statuses_match_contract():
    values, max_len = _contract_statuses()
    assert mod.EXECUTION_STATUSES == frozenset(values)
    assert all(len(v) <= max_len for v in values)
    for v in values:
        assert mod.normalize_execution_status(v.lower()) == v


def test_unknown_explicit_status_is_omitted_and_event_still_sent(http, caplog):
    b = _billing()
    with caplog.at_level("WARNING", logger="aforo_ws_metering"):
        b.push(dict(FRAME), execution_status="bogus")
        b.push({**FRAME, "executionStatus": "X" * 25})
        # An invalid keyword falls back to a valid dict value.
        b.push({**FRAME, "executionStatus": "timeout"}, execution_status="nope")
    b.shutdown()
    events = _events(http)
    assert len(events) == 3
    assert "executionStatus" not in events[0]
    assert "executionStatus" not in events[1]
    assert events[2]["executionStatus"] == "TIMEOUT"
    assert events[0]["customerId"] == "cust_001" and events[0]["wsConnectionId"] == "c1"
    assert "Ignoring unknown executionStatus" in caplog.text
