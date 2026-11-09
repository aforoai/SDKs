"""Regression tests for the 2026-11-09 review (python-ws).

* Starlette frames moved by send_json / receive_json / iter_json are counted
  (finding 10): the helper wraps the ASGI-level send / receive.
* A connection the idle sweep closed is tracked again on its next frame, and
  its next CONNECTION_CLOSED reports only the traffic after the sweep (R8).
* push() with a non-dict metadata is dropped as invalid instead of raising.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from fakes import ScriptedServer
from aforo_ws_metering import AforoWsBilling, track_starlette_websocket, track_websockets_connection

pytestmark = pytest.mark.real_transport


def _billing(server, **kw):
    return AforoWsBilling(tenant_id="t", product_id="p", api_key="k", ingestor_url="https://ingest.example.test",
                          flush_interval_sec=3600, http_transport=server.transport(), **kw)


def _events(server):
    return [e for r in server.requests for e in r["body"]["events"]]


starlette = pytest.importorskip("starlette")


@pytest.mark.parametrize("per_frame", [False, True])
def test_starlette_json_frames_are_counted(per_frame):
    from starlette.applications import Starlette
    from starlette.routing import WebSocketRoute
    from starlette.testclient import TestClient

    server = ScriptedServer()
    b = _billing(server, per_frame_events=per_frame)

    async def route(ws):
        await ws.accept()
        async with await track_starlette_websocket(b, ws, "cust_1"):
            for _ in range(3):
                data = await ws.receive_json()
                await ws.send_json(data)

    app = Starlette(routes=[WebSocketRoute("/ws", route)])
    with TestClient(app).websocket_connect("/ws") as s:
        for i in range(3):
            s.send_json({"i": i})
            s.receive_json()
    b.shutdown()
    events = _events(server)
    closed = [e for e in events if e["wsFrameType"] == "CLOSE"][0]
    assert closed["messageCount"] == 6
    assert closed["dataBytes"] == 6 * len('{"i":0}')
    frames = [e for e in events if e["wsFrameType"] == "TEXT"]
    assert len(frames) == (6 if per_frame else 0)


def test_starlette_text_frames_are_not_counted_twice():
    from starlette.applications import Starlette
    from starlette.routing import WebSocketRoute
    from starlette.testclient import TestClient

    server = ScriptedServer()
    b = _billing(server)

    async def route(ws):
        await ws.accept()
        async with await track_starlette_websocket(b, ws, "cust_1"):
            async for text in ws.iter_text():
                await ws.send_text(text)

    app = Starlette(routes=[WebSocketRoute("/ws", route)])
    with TestClient(app).websocket_connect("/ws") as s:
        s.send_text("ab")
        s.receive_text()
    b.shutdown()
    closed = [e for e in _events(server) if e["wsFrameType"] == "CLOSE"][0]
    assert closed["messageCount"] == 2 and closed["dataBytes"] == 4


class _Ws:
    def __init__(self):
        self.request = SimpleNamespace(headers={})

    async def send(self, data):
        return None

    async def recv(self):
        return "m"


class _StarletteWs:
    async def send_text(self, data):
        return None

    async def receive_text(self):
        return "m"


@pytest.mark.parametrize("helper", ["websockets", "starlette"])
def test_connection_closed_by_the_idle_sweep_is_tracked_again_on_its_next_frame(helper):
    server = ScriptedServer()
    b = _billing(server, connection_idle_timeout_sec=10)
    clock = {"now": 1000.0}
    b._now = lambda: clock["now"]

    async def run():
        if helper == "websockets":
            ws = _Ws()
            send = lambda: ws.send("hi")  # noqa: E731
            tracker = await track_websockets_connection(b, ws, "cust_1")
        else:
            ws = _StarletteWs()
            send = lambda: ws.send_text("hi")  # noqa: E731
            tracker = await track_starlette_websocket(b, ws, "cust_1")
        async with tracker:
            await send()
            await send()
            clock["now"] += 11
            assert b.sweep_idle() == 1
            assert b.open_connections == 0
            await send()                  # traffic again: tracked again
            assert b.open_connections == 1
        assert b.open_connections == 0

    asyncio.run(run())
    b.shutdown()
    closes = [e for e in _events(server) if e["wsFrameType"] == "CLOSE"]
    assert [(c["wsCloseReason"], c["messageCount"]) for c in closes] == [
        ("ABNORMAL_CLOSURE", 2), ("NORMAL_CLOSURE", 1)]
    assert closes[0]["metadata"]["closedBy"] == "sdk_idle_timeout"
    assert closes[1]["metadata"].get("resumedAfterIdle") is True
    assert sum(c["messageCount"] for c in closes) == 3   # nothing counted twice


def test_swept_connection_that_stays_quiet_is_not_reported_twice():
    server = ScriptedServer()
    b = _billing(server, connection_idle_timeout_sec=10)
    clock = {"now": 1000.0}
    b._now = lambda: clock["now"]

    async def run():
        async with await track_websockets_connection(b, _Ws(), "cust_1"):
            clock["now"] += 11
            b.sweep_idle()

    asyncio.run(run())
    b.shutdown()
    assert len([e for e in _events(server) if e["wsFrameType"] == "CLOSE"]) == 1


def test_push_with_non_dict_metadata_is_invalid_not_raised():
    server = ScriptedServer()
    drops = []
    b = _billing(server, on_drop=lambda ev, r: drops.append(r))
    b.push({"customerId": "c", "wsConnectionId": "conn-1", "metadata": ["x"]})
    assert drops == ["invalid"] and b.queued_count == 0
    b.shutdown()
