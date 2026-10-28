"""Connection lifecycle (review 2026-10-26, matches go-ws 2.0.0 / G279).

* CONNECTION_OPENED is sent with ``wsFrameType: "OPEN"`` and metric
  ``websocket_api.connection_opened`` (it was ``PING`` / ``websocket_api.message``).
* ``shutdown()`` sends CONNECTION_CLOSED (GOING_AWAY, ``closedBy: "sdk_shutdown"``)
  for every connection still open.
* The open-connection map is bounded: a connection idle longer than
  ``connection_idle_timeout_sec`` is closed (ABNORMAL_CLOSURE,
  ``closedBy: "sdk_idle_timeout"``) and forgotten.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from fakes import ScriptedServer
from aforo_ws_metering import AforoWsBilling, track_starlette_websocket, track_websockets_connection

pytestmark = pytest.mark.real_transport


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


class _Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def _billing(server, **kw):
    return AforoWsBilling(tenant_id="t", product_id="p", api_key="k", ingestor_url="https://ingest.example.test",
                          flush_interval_sec=3600, http_transport=server.transport(), **kw)


def _events(server):
    return [e for r in server.requests for e in r["body"]["events"]]


def test_push_open_frame_uses_its_own_metric():
    server = ScriptedServer()
    b = _billing(server)
    b.push({"customerId": "c", "wsConnectionId": "conn-1", "wsFrameType": "OPEN"})
    b.shutdown()
    (ev,) = _events(server)
    assert ev["wsFrameType"] == "OPEN"
    assert ev["metricName"] == "websocket_api.connection_opened"


@pytest.mark.parametrize("helper", ["websockets", "starlette"])
def test_helpers_send_open_not_ping(helper):
    server = ScriptedServer()
    b = _billing(server)

    async def run():
        if helper == "websockets":
            async with await track_websockets_connection(b, _Ws(), "cust_1"):
                pass
        else:
            async with await track_starlette_websocket(b, _StarletteWs(), "cust_1"):
                pass

    asyncio.run(run())
    b.shutdown()
    opened, closed = _events(server)
    assert (opened["wsFrameType"], opened["metricName"]) == ("OPEN", "websocket_api.connection_opened")
    assert opened["metadata"]["event"] == "CONNECTION_OPENED"
    assert (closed["wsFrameType"], closed["metricName"]) == ("CLOSE", "websocket_api.connection_closed")
    assert b.open_connections == 0


@pytest.mark.parametrize("helper", ["websockets", "starlette"])
def test_shutdown_closes_connections_that_are_still_open(helper):
    server = ScriptedServer()
    b = _billing(server)
    entered = {}

    async def run():
        if helper == "websockets":
            ws = _Ws()
            tracker = await track_websockets_connection(b, ws, "cust_1")
            await tracker.__aenter__()
            await ws.send("hello")
        else:
            ws = _StarletteWs()
            tracker = await track_starlette_websocket(b, ws, "cust_1")
            await tracker.__aenter__()
            await ws.send_text("hello")
        entered["tracker"] = tracker

    asyncio.run(run())
    assert b.open_connections == 1
    b.shutdown()
    opened, closed = _events(server)
    assert closed["wsConnectionId"] == opened["wsConnectionId"]
    assert closed["wsFrameType"] == "CLOSE"
    assert closed["wsCloseReason"] == "GOING_AWAY"
    assert closed["metadata"]["closedBy"] == "sdk_shutdown"
    assert closed["metadata"]["event"] == "CONNECTION_CLOSED"
    assert closed["messageCount"] == 1
    assert b.open_connections == 0
    # The app's own exit after shutdown does not report the connection again.
    asyncio.run(entered["tracker"].__aexit__(None, None, None))
    assert len(_events(server)) == 2


def test_idle_connections_are_closed_and_forgotten():
    server = ScriptedServer()
    clock = _Clock()
    b = _billing(server, connection_idle_timeout_sec=60)
    b._now = clock
    trackers, sockets = [], []

    async def open_two():
        for _ in range(2):
            ws = _Ws()
            t = await track_websockets_connection(b, ws, "cust_1")
            await t.__aenter__()
            trackers.append(t)
            sockets.append(ws)

    asyncio.run(open_two())
    assert b.open_connections == 2
    clock.now += 30
    asyncio.run(sockets[1].send("still here"))  # activity keeps the second one
    clock.now += 45
    assert b.sweep_idle() == 1
    assert b.open_connections == 1
    b.flush()
    closed = [e for e in _events(server) if e["wsFrameType"] == "CLOSE"]
    assert len(closed) == 1
    assert closed[0]["wsCloseReason"] == "ABNORMAL_CLOSURE"
    assert closed[0]["metadata"]["closedBy"] == "sdk_idle_timeout"
    asyncio.run(trackers[0].__aexit__(None, None, None))  # already closed: nothing more
    b.flush()
    assert len([e for e in _events(server) if e["wsFrameType"] == "CLOSE"]) == 1
    b.shutdown()


def test_the_sweep_runs_by_itself_as_connections_come_and_go():
    server = ScriptedServer()
    clock = _Clock()
    b = _billing(server, connection_idle_timeout_sec=60)
    b._now = clock

    async def open_one():
        t = await track_websockets_connection(b, _Ws(), "cust_1")
        await t.__aenter__()

    for _ in range(50):
        asyncio.run(open_one())  # never closed by the app (a leak)
        clock.now += 10
    # Without a sweep the map would hold 50; idle ones are dropped as new ones arrive.
    assert b.open_connections <= 8
    b.shutdown()


def test_open_after_shutdown_is_not_tracked_and_is_reported_closed():
    server = ScriptedServer()
    drops = []
    b = _billing(server, on_drop=lambda events, reason: drops.append((reason, [e["wsFrameType"] for e in events])))
    b.shutdown()

    async def run():
        t = await track_websockets_connection(b, _Ws(), "cust_1")
        await t.__aenter__()
        await t.__aexit__(None, None, None)

    asyncio.run(run())
    assert b.open_connections == 0
    assert drops[0] == ("closed", ["OPEN"])
    assert _events(server) == []


def test_open_during_shutdown_is_either_closed_by_it_or_reported():
    """The Go review race (go-ws Open/Shutdown): an OPEN that lands while
    shutdown() is closing connections must not be billed without a CLOSE."""
    server = ScriptedServer()
    drops = []
    b = _billing(server, on_drop=lambda events, reason: drops.append((reason, [e["wsFrameType"] for e in events])))
    with b._connections_lock:  # shutdown() has taken its snapshot
        b._shutting_down = True

    async def run():
        t = await track_websockets_connection(b, _Ws(), "cust_1")
        await t.__aenter__()

    asyncio.run(run())
    b.shutdown()
    assert drops == [("closed", ["OPEN"])]
    assert _events(server) == []


def test_connection_without_a_customer_is_not_tracked():
    server = ScriptedServer()
    b = _billing(server)

    async def run():
        t = await track_websockets_connection(b, _Ws(), None)
        await t.__aenter__()

    asyncio.run(run())
    assert b.open_connections == 0
    b.shutdown()


@pytest.mark.parametrize("value", [-1, -0.5])
def test_negative_idle_timeout_is_refused(value):
    with pytest.raises(ValueError, match="connection_idle_timeout_sec"):
        _billing(ScriptedServer(), connection_idle_timeout_sec=value)
