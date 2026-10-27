"""G265: the customer comes from your own auth, never silently from the client."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from fakes import ScriptedServer
from aforo_ws_metering import AforoWsBilling, track_starlette_websocket, track_websockets_connection

pytestmark = pytest.mark.real_transport


def _billing(drops):
    return AforoWsBilling(tenant_id="t", product_id="p", api_key="k", ingestor_url="https://ingest.example.test",
                          flush_interval_sec=3600, http_transport=ScriptedServer().transport(),
                          on_drop=lambda events, reason: drops.append((reason, [e["customerId"] for e in events])))


class _Ws:
    def __init__(self, headers):
        self.request = SimpleNamespace(headers=headers)

    async def send(self, data):
        return None

    async def recv(self):
        return "m"


def _run(coro):
    return asyncio.run(coro)


def test_no_customer_source_raises():
    drops = []
    b = _billing(drops)
    try:
        with pytest.raises(ValueError, match="customer_resolver"):
            _run(track_websockets_connection(b, _Ws({"x-customer-id": "spoofed"})))
        with pytest.raises(ValueError, match="trust_customer_header"):
            _run(track_starlette_websocket(b, SimpleNamespace(headers={})))
    finally:
        b.shutdown(timeout=0)


def test_resolver_wins_and_the_handshake_header_is_ignored():
    drops = []
    b = _billing(drops)

    async def go():
        ws = _Ws({"x-customer-id": "spoofed"})
        tracker = await track_websockets_connection(b, ws, customer_resolver=lambda w: "cust_verified")
        async with tracker:
            await ws.send("hi")

    _run(go())
    b.flush()
    b.shutdown()
    assert drops == []
    assert b.dropped_count == 0


def test_trusting_the_handshake_header_is_an_explicit_opt_in():
    drops = []
    b = _billing(drops)
    seen = []
    b._core._on_drop = lambda events, reason: seen.append(reason)

    async def go():
        ws = _Ws({"x-customer-id": "cust_from_header"})
        async with await track_websockets_connection(b, ws, trust_customer_header=True):
            pass

    _run(go())
    assert b.queued_count == 2  # CONNECTION_OPENED + CONNECTION_CLOSED
    b.shutdown()
    assert seen == []


def test_resolver_returning_nothing_drops_events_as_invalid_without_breaking_the_connection():
    drops = []
    b = _billing(drops)

    async def go():
        ws = _Ws({})
        async with await track_websockets_connection(b, ws, customer_resolver=lambda w: None):
            await ws.send("still works")

    _run(go())
    b.shutdown()
    assert [reason for reason, _ in drops] == ["invalid", "invalid"]
