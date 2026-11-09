"""End-to-end test finding (2026-11-09): with the README's FastAPI quickstart
(``while True: await ws.receive_text()``) every normal client disconnect was
stored as ``wsCloseReason = INTERNAL_ERROR``, because the loop ends with
``WebSocketDisconnect`` and any exception counted as a handler failure. Both
helpers must report the real close code through ``WS_CLOSE_REASONS``: 1000 ->
NORMAL_CLOSURE, 1001 -> GOING_AWAY; only a real handler exception is
INTERNAL_ERROR."""

from __future__ import annotations

import asyncio
from typing import List

import pytest

from fakes import ScriptedServer
from aforo_ws_metering import AforoWsBilling, track_starlette_websocket, track_websockets_connection

pytestmark = pytest.mark.real_transport


def _billing(server):
    return AforoWsBilling(tenant_id="t", product_id="p", api_key="k", ingestor_url="https://ingest.example.test",
                          flush_interval_sec=3600, http_transport=server.transport())


def _close_reasons(server) -> List[str]:
    return [e["wsCloseReason"] for r in server.requests for e in r["body"]["events"]
            if e.get("wsFrameType") == "CLOSE"]


# ── FastAPI / Starlette (README quickstart 2) ─────────────────────

starlette_testclient = pytest.importorskip("starlette.testclient")
starlette_websockets = pytest.importorskip("starlette.websockets")
fastapi = pytest.importorskip("fastapi")


def _readme_app(billing):
    app = fastapi.FastAPI()

    @app.websocket("/ws")
    async def ws_handler(ws: fastapi.WebSocket):
        await ws.accept()
        async with await track_starlette_websocket(billing, ws, "cust_1"):
            while True:
                data = await ws.receive_text()
                if data == "crash":
                    raise RuntimeError("handler failed")
                if data == "kick":
                    await ws.close(code=1008)
                    return
                await ws.send_text(f"echo: {data}")

    return app


@pytest.mark.parametrize("client_code, expected", [
    (1000, "NORMAL_CLOSURE"),
    (1001, "GOING_AWAY"),
    (1011, "INTERNAL_ERROR"),   # the client said the server errored
    (4401, "NORMAL_CLOSURE"),   # application code: outside the map
])
def test_starlette_client_close_code_is_reported(client_code, expected):
    server = ScriptedServer()
    b = _billing(server)
    with starlette_testclient.TestClient(_readme_app(b)) as tc:
        # The README loop lets WebSocketDisconnect leave the handler (uvicorn
        # logs it); TestClient re-raises it when the session closes.
        with pytest.raises(starlette_websockets.WebSocketDisconnect) as closed:
            with tc.websocket_connect("/ws") as ws:
                ws.send_text("hi")
                assert ws.receive_text() == "echo: hi"
                ws.close(code=client_code)
    b.shutdown()
    assert closed.value.code == client_code
    assert _close_reasons(server) == [expected]


def test_starlette_handler_exception_is_internal_error_and_server_close_uses_its_code():
    server = ScriptedServer()
    b = _billing(server)
    with starlette_testclient.TestClient(_readme_app(b)) as tc:
        with pytest.raises(RuntimeError):
            with tc.websocket_connect("/ws") as ws:
                ws.send_text("crash")
                ws.receive_text()
        with tc.websocket_connect("/ws") as ws:
            ws.send_text("kick")
            with pytest.raises(Exception):
                ws.receive_text()  # the server closed with 1008
    b.shutdown()
    assert _close_reasons(server) == ["INTERNAL_ERROR", "POLICY_VIOLATION"]


# ── websockets library (README quickstart 1) ──────────────────────

websockets = pytest.importorskip("websockets")


async def _websockets_run(billing, client_code=None, crash=False):
    async def handler(ws):
        async with await track_websockets_connection(billing, ws, "cust_1"):
            async for msg in ws:
                if msg == "crash":
                    raise RuntimeError("handler failed")
                await ws.send(f"echo: {msg}")

    async with websockets.serve(handler, "127.0.0.1", 0) as srv:
        port = next(iter(srv.sockets)).getsockname()[1]
        async with websockets.connect(f"ws://127.0.0.1:{port}") as c:
            await c.send("hi")
            await c.recv()
            if crash:
                await c.send("crash")
                try:
                    await c.recv()
                except websockets.ConnectionClosed:
                    pass
            else:
                await c.close(code=client_code)
        for _ in range(100):  # let the server-side block exit
            if not billing.open_connections:
                break
            await asyncio.sleep(0.02)


@pytest.mark.parametrize("client_code, expected", [
    (1000, "NORMAL_CLOSURE"),
    (1001, "GOING_AWAY"),        # ends `async for` without an exception
    (1008, "POLICY_VIOLATION"),  # ends it with ConnectionClosedError
])
def test_websockets_client_close_code_is_reported(client_code, expected):
    server = ScriptedServer()
    b = _billing(server)
    asyncio.run(_websockets_run(b, client_code=client_code))
    b.shutdown()
    assert _close_reasons(server) == [expected]


def test_websockets_handler_exception_is_internal_error():
    server = ScriptedServer()
    b = _billing(server)
    asyncio.run(_websockets_run(b, crash=True))
    b.shutdown()
    assert _close_reasons(server) == ["INTERNAL_ERROR"]
