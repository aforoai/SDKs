"""An outbound frame is billed only once the send returns without raising
(decided 2026-10-27, industry practice: a message the socket refuses is not billed)."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from fakes import ScriptedServer
from aforo_ws_metering import AforoWsBilling, track_starlette_websocket, track_websockets_connection

pytestmark = pytest.mark.real_transport


class _Ws:
    def __init__(self, fail):
        self.request = SimpleNamespace(headers={})
        self.fail = fail

    async def send(self, data):
        if self.fail:
            raise ConnectionError("socket closed")

    async def recv(self):
        return "m"


class _StarletteWs:
    def __init__(self, fail):
        self.fail = fail

    async def send_text(self, data):
        if self.fail:
            raise RuntimeError("Cannot call send once a close message has been sent")

    async def receive_text(self):
        return "m"


def _billing(server):
    return AforoWsBilling(tenant_id="t", product_id="p", api_key="k", ingestor_url="https://ingest.example.test",
                          flush_interval_sec=3600, http_transport=server.transport(), per_frame_events=True)


def _events(server):
    return [e for r in server.requests for e in r["body"]["events"]]


@pytest.mark.parametrize("helper", ["websockets", "starlette"])
@pytest.mark.parametrize("fail", [False, True])
def test_frame_counted_only_after_successful_send(helper, fail):
    server = ScriptedServer()
    b = _billing(server)

    async def run():
        if helper == "websockets":
            ws = _Ws(fail)
            async with await track_websockets_connection(b, ws, "cust_1"):
                if fail:
                    with pytest.raises(ConnectionError):
                        await ws.send("hello")
                else:
                    await ws.send("hello")
        else:
            ws = _StarletteWs(fail)
            async with await track_starlette_websocket(b, ws, "cust_1"):
                if fail:
                    with pytest.raises(RuntimeError):
                        await ws.send_text("hello")
                else:
                    await ws.send_text("hello")

    asyncio.run(run())
    b.shutdown()
    events = _events(server)
    frames = [e for e in events if e.get("wsDirection") == "SERVER_TO_CLIENT" and e.get("wsFrameType") == "TEXT"]
    closed = [e for e in events if e.get("metadata", {}).get("event") == "CONNECTION_CLOSED"]
    assert len(frames) == (0 if fail else 1)
    assert closed and closed[0]["messageCount"] == (0 if fail else 1)
