"""Regression test for the 2026-11-09 review (python-graphql): a batched POST
(a JSON array of operations) is metered one event per operation (finding 11)."""

from __future__ import annotations

import json

import pytest

from fakes import ScriptedServer
from aforo_graphql_metering import AforoGraphQlBilling, asgi_middleware

pytestmark = pytest.mark.real_transport
pytest.importorskip("starlette")


async def _gql_app(scope, receive, send):
    body = b""
    while True:
        message = await receive()
        body += message.get("body", b"")
        if not message.get("more_body"):
            break
    request = json.loads(body)
    if isinstance(request, list):
        out = [{"data": {"a": 1}}, {"data": None, "errors": [{"message": "x", "path": ["a"]}]}, {"data": {"a": 2}}]
        out = out[:len(request)]
    else:
        out = {"data": {"a": 1}}
    await send({"type": "http.response.start", "status": 200,
                "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": json.dumps(out).encode()})


def _billing():
    return AforoGraphQlBilling("t", "p", "k", "https://ingest.example.test", flush_interval_sec=3600,
                               http_transport=ScriptedServer().transport())


def test_batched_request_is_metered_per_operation():
    from starlette.testclient import TestClient

    billing = _billing()
    app = asgi_middleware(billing, customer_resolver=lambda scope: "cust_1")(_gql_app)
    TestClient(app).post("/graphql", json=[{"query": "query A { a }"}, {"query": "query B { a }"},
                                           {"query": "query C { a }"}])
    events = billing._core.queued_items()
    assert [e["gqlOperationName"] for e in events] == ["A", "B", "C"]
    assert [e.get("executionStatus") for e in events] == ["SUCCESS", "ERROR", "SUCCESS"]
    billing.shutdown(timeout=0)


def test_batched_request_without_customer_counts_every_operation():
    from starlette.testclient import TestClient

    billing = _billing()
    app = asgi_middleware(billing, customer_resolver=lambda scope: None)(_gql_app)
    TestClient(app).post("/graphql", json=[{"query": "query A { a }"}, {"query": "query B { a }"}])
    assert billing.queued_count == 0 and billing.dropped_count == 2
    billing.shutdown(timeout=0)


def test_single_request_is_still_one_event():
    from starlette.testclient import TestClient

    billing = _billing()
    app = asgi_middleware(billing, customer_resolver=lambda scope: "cust_1")(_gql_app)
    TestClient(app).post("/graphql", json={"query": "query A { a }"})
    assert [e["gqlOperationName"] for e in billing._core.queued_items()] == ["A"]
    billing.shutdown(timeout=0)
