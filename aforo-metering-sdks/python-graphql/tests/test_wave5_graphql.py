"""G287: the ASGI middleware caps the request body and parses off the event
loop; Strawberry's parsed document is reused. G265: customer resolver required."""

from __future__ import annotations

import asyncio
import json
import threading

import pytest

from fakes import ScriptedServer
from aforo_graphql_metering import AforoGraphQlBilling, asgi_middleware, strawberry_extension
from aforo_graphql_metering import client as mod

pytestmark = pytest.mark.real_transport


def _billing(server, **kw):
    return AforoGraphQlBilling(tenant_id="t", product_id="p", api_key="k", ingestor_url="https://ingest.example.test",
                               flush_interval_sec=3600, http_transport=server.transport(), **kw)


def _events(server):
    return [e for r in server.requests for e in r["body"]["events"]]


def _app(body=b'{"data":{"ping":"pong"}}'):
    async def app(scope, receive, send):
        while True:
            msg = await receive()
            if not msg.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200,
                    "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": body})
    return app


def _post(app, payload: bytes, headers=(), chunk=65536):
    sent = []

    async def go():
        pieces = [payload[i:i + chunk] for i in range(0, len(payload), chunk)] or [b""]
        queue = [{"type": "http.request", "body": p, "more_body": i < len(pieces) - 1} for i, p in enumerate(pieces)]

        async def receive():
            return queue.pop(0) if queue else {"type": "http.disconnect"}

        async def send(message):
            sent.append(message)

        await app({"type": "http", "method": "POST", "path": "/graphql",
                   "headers": [(k.encode(), v.encode()) for k, v in headers]}, receive, send)

    asyncio.run(go())
    return sent


def test_middleware_without_a_customer_source_refuses_to_start():
    b = _billing(ScriptedServer())
    try:
        with pytest.raises(ValueError, match="customer_resolver"):
            asgi_middleware(b)
        with pytest.raises(ValueError, match="trust_customer_header"):
            strawberry_extension(b)
    finally:
        b.shutdown(timeout=0)


def test_resolver_reads_the_scope_and_the_header_is_ignored():
    server = ScriptedServer()
    b = _billing(server)
    app = asgi_middleware(b, customer_resolver=lambda scope: "cust_" + scope["path"].strip("/"))(_app())
    _post(app, json.dumps({"query": "{ ping }"}).encode(), headers=[("x-customer-id", "spoofed")])
    b.shutdown()
    assert [e["customerId"] for e in _events(server)] == ["cust_graphql"]


def test_oversized_request_body_is_capped_served_and_counted_not_metered():
    server = ScriptedServer()
    b = _billing(server)
    app = asgi_middleware(b, customer_resolver=lambda scope: "cust_1", max_request_body_bytes=1024)(_app())
    big = json.dumps({"query": "{ ping }", "variables": {"pad": "x" * 5000}}).encode()
    sent = _post(app, big, chunk=512)
    assert [m["type"] for m in sent] == ["http.response.start", "http.response.body"]  # served
    b.shutdown()
    assert _events(server) == []
    assert b.dropped_count == 1


def test_parsing_and_scoring_run_off_the_event_loop(monkeypatch):
    server = ScriptedServer()
    b = _billing(server)
    threads = []
    real_parse = mod.parse

    def spy(query, *a, **k):
        threads.append(threading.current_thread())
        return real_parse(query, *a, **k)

    monkeypatch.setattr(mod, "parse", spy)
    loop_threads = []

    async def app(scope, receive, send):
        loop_threads.append(threading.current_thread())
        await _app()(scope, receive, send)

    _post(asgi_middleware(b, customer_resolver=lambda scope: "cust_1")(app), b'{"query":"{ ping }"}')
    b.shutdown()
    assert len(threads) == 1 and threads[0] is not loop_threads[0]
    assert len(_events(server)) == 1


def test_strawberry_reuses_its_parsed_document(monkeypatch):
    strawberry = pytest.importorskip("strawberry")
    server = ScriptedServer()
    b = _billing(server)
    calls = []
    real_parse = mod.parse
    monkeypatch.setattr(mod, "parse", lambda q, *a, **k: (calls.append(q), real_parse(q, *a, **k))[1])

    @strawberry.type
    class Query:
        @strawberry.field
        def ping(self) -> str:
            return "pong"

    schema = strawberry.Schema(query=Query, extensions=[
        strawberry_extension(b, customer_resolver=lambda context: context["user"])])
    result = schema.execute_sync("query Ping { ping }", context_value={"user": "cust_ctx"})
    assert result.errors is None
    b.shutdown()
    assert calls == []
    events = _events(server)
    assert [(e["customerId"], e["gqlOperationName"]) for e in events] == [("cust_ctx", "Ping")]


# ── a dedicated, bounded executor (review 2026-10-26) ──────────────
# run_in_executor(None, ...) used the application's default executor, so
# metering competed with the app's own blocking work (and the other way round).

def test_metering_runs_on_its_own_small_executor_not_the_apps_default(monkeypatch):
    server = ScriptedServer()
    b = _billing(server)
    names = []
    real_parse = mod.parse

    def spy(query, *a, **k):
        names.append(threading.current_thread().name)
        return real_parse(query, *a, **k)

    monkeypatch.setattr(mod, "parse", spy)
    app = asgi_middleware(b, customer_resolver=lambda scope: "cust_1")(_app())

    default_used = []

    async def go():
        loop = asyncio.get_running_loop()
        real = loop.run_in_executor

        def watch(executor, fn, *args):
            if executor is None:
                default_used.append(fn)
            return real(executor, fn, *args)

        loop.run_in_executor = watch  # type: ignore[method-assign]
        for _ in range(3):
            queue = [{"type": "http.request", "body": json.dumps({"query": "{ ping }"}).encode(),
                      "more_body": False}]

            async def receive():
                return queue.pop(0) if queue else {"type": "http.disconnect"}

            async def send(message):
                return None

            await app({"type": "http", "method": "POST", "path": "/graphql", "headers": []}, receive, send)

    asyncio.run(go())
    b.shutdown()
    assert default_used == []
    assert names and all(n.startswith("aforo-graphql-meter") for n in names)
    assert len(_events(server)) == 3


def test_the_metering_executor_is_bounded_and_shut_down_with_the_client():
    server = ScriptedServer()
    b = _billing(server)
    app = asgi_middleware(b, customer_resolver=lambda scope: "cust_1", meter_workers=2)(_app())
    _post(app, json.dumps({"query": "{ ping }"}).encode())
    executor = b._meter_executors[0]
    assert executor._max_workers == 2
    b.shutdown()
    assert executor._shutdown
    # A request after shutdown is still counted (as "closed"), never an error.
    _post(app, json.dumps({"query": "{ ping }"}).encode())
    assert b.dropped_count == 1


def test_meter_workers_must_be_positive():
    b = _billing(ScriptedServer())
    try:
        with pytest.raises(ValueError, match="meter_workers"):
            asgi_middleware(b, customer_resolver=lambda scope: "c", meter_workers=0)
    finally:
        b.shutdown(timeout=0)
