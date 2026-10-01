"""Labels the middlewares copy from the incoming request are truncated to the
ingestor's limit and the event is still sent; fields the caller sets are not
altered and still drop the event as ``invalid`` when over-long."""

from __future__ import annotations

import logging

import pytest

from aforo import limits
from aforo.client import AforoClient
from aforo.limits import truncate_label, truncate_utf16, utf16_length
from aforo.middleware._common import http_fields

ASTRAL = "\U0001F600"  # 2 UTF-16 code units, 1 code point


@pytest.fixture(autouse=True)
def _fresh_warnings():
    limits._truncation_warned.clear()
    yield
    limits._truncation_warned.clear()


@pytest.fixture
def client():
    c = AforoClient(api_key="k", flush_interval=3600, flush_count=1000)
    sent: list = []

    def send_sync(batch):
        from aforo.types import FlushResult

        sent.extend(batch)
        return FlushResult(sent=len(batch), failed=0)

    c._transport.send_sync = send_sync  # type: ignore[method-assign]
    c.sent = sent  # type: ignore[attr-defined]
    yield c
    c.shutdown()


def test_truncate_utf16_counts_code_units_and_never_splits_a_pair():
    assert truncate_utf16("abc", 3) == "abc"
    assert truncate_utf16("abcd", 3) == "abc"
    # Cutting at 4 units would land inside the pair: the whole character goes.
    text = "abc" + ASTRAL + "z"
    assert truncate_utf16(text, 4) == "abc"
    assert truncate_utf16(text, 5) == "abc" + ASTRAL
    assert utf16_length(truncate_utf16(ASTRAL * 300, 512)) == 512
    assert utf16_length(truncate_utf16("a" + ASTRAL * 300, 512)) == 511
    # 300 code points pass a code-point count of 512 but are 600 UTF-16 units.
    assert utf16_length(ASTRAL * 300) == 600


def test_over_long_path_is_truncated_to_the_limit_not_dropped():
    path = "/" + "p" * 510 + ASTRAL + "tail"
    fields = http_fields(path, "GET", 200, 3)
    assert fields["endpointPath"] == "/" + "p" * 510  # 511 units: the pair did not fit
    assert utf16_length(fields["endpointPath"]) <= 512
    fields["endpointPath"].encode("utf-16-le")  # no lone surrogate

    exact = http_fields("/" + "p" * 600, "GET", 200, None)["endpointPath"]
    assert exact == "/" + "p" * 511 and len(exact) == 512

    assert http_fields("/short", "GET", 200, None)["endpointPath"] == "/short"


def test_over_long_method_is_truncated():
    fields = http_fields("/x", "x" * 40, 200, None)
    assert fields["httpMethod"] == "X" * 16


def test_warns_once_per_label_across_events(caplog):
    with caplog.at_level(logging.WARNING, logger="aforo.limits"):
        http_fields("/" + "a" * 600, "GET", 200, None)
        http_fields("/" + "b" * 700, "GET", 200, None)
        http_fields("/x", "m" * 40, 200, None)
        http_fields("/x", "n" * 50, 200, None)
    messages = [r.getMessage() for r in caplog.records]
    assert len([m for m in messages if "endpointPath" in m]) == 1
    assert len([m for m in messages if "httpMethod" in m]) == 1
    assert "truncated to 512 characters" in "".join(messages)


def test_event_with_truncated_request_labels_is_sent(client):
    for tail in ("a", "b"):
        client.track(
            customer_id="cust_1",
            metric_name="api_calls",
            quantity=1,
            extra_fields=http_fields("/" + "p" * 600 + tail, "GET", 200, 1),
        )
    assert client.dropped_count == 0
    client.flush()
    assert len(client.sent) == 2
    assert all(len(e.extra_fields["endpointPath"]) == 512 for e in client.sent)
    # The key is a random UUID minted per event: it does not depend on the
    # path, so truncation cannot make two requests share one.
    keys = {e.idempotency_key for e in client.sent}
    assert len(keys) == 2


def test_asgi_middleware_meters_a_request_with_an_over_long_path(client):
    pytest.importorskip("starlette")
    import asyncio

    from aforo.middleware.fastapi import AforoMeteringMiddleware

    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    mw = AforoMeteringMiddleware(app, api_key="k")
    mw._client.shutdown()
    mw._client = client

    async def receive():
        return {"type": "http.request", "body": b""}

    async def send(_message):
        return None

    scope = {
        "type": "http",
        "path": "/v1/" + "x" * 900,
        "method": "GET",
        "headers": [(b"x-customer-id", b"cust_1")],
    }
    asyncio.run(mw(scope, receive, send))
    assert client.dropped_count == 0
    client.flush()
    assert len(client.sent) == 1
    assert len(client.sent[0].extra_fields["endpointPath"]) == 512
    assert client.sent[0].metric_name == "api_calls"


def test_caller_set_fields_still_drop_as_invalid(client):
    drops: list = []
    client._on_drop = lambda events, reason: drops.append(reason)
    client.track(customer_id="c" * 65, metric_name="api_calls", quantity=1)
    # A label the caller passes explicitly is not truncated either.
    client.track(
        customer_id="cust_1", metric_name="api_calls", quantity=1,
        extra_fields={"endpointPath": "/" + "p" * 600},
    )
    assert drops == ["invalid", "invalid"]
    assert client.dropped_count == 2
    client.flush()
    assert client.sent == []


def test_truncate_label_leaves_non_strings_alone():
    assert truncate_label("endpointPath", None) is None
    assert truncate_label("endpointPath", 5) == 5
