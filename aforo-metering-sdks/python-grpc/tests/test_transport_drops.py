"""Transport and drop-accounting rules: no retry on a terminal 4xx, Retry-After
on 429, partial (202) failures, and client-side invalid events. Every lost
event is counted in dropped_count and handed to on_drop with a reason."""

from __future__ import annotations

import json
import logging
from typing import List
from unittest import mock

import pytest

from aforo_grpc_metering import client as mod
from aforo_grpc_metering.client import AforoGrpcBilling


class _Http:
    """Scripted urllib.request.urlopen: each entry is (status, headers, body)."""

    def __init__(self, script=None):
        self.script = list(script or [])
        self.requests: List[dict] = []

    def urlopen(self, req, timeout=None):
        self.requests.append({
            "headers": {k.lower(): v for k, v in req.header_items()},
            "body": json.loads(req.data.decode("utf-8")),
        })
        code, headers, body = self.script.pop(0) if self.script else (202, {}, b"")

        class _R:
            status = code
            def __init__(self_i): self_i.headers = headers
            def __enter__(self_i): return self_i
            def __exit__(self_i, *_a): return False
            def read(self_i): return body

        return _R()


@pytest.fixture
def http(monkeypatch):
    monkeypatch.setattr(mod, "HAS_HTTPX", False, raising=False)
    sleeps: List[float] = []
    monkeypatch.setattr(mod.time, "sleep", lambda s: sleeps.append(s))
    h = _Http()
    h.sleeps = sleeps
    with mock.patch("urllib.request.urlopen", side_effect=h.urlopen):
        yield h


def _make(drops, errors):
    return AforoGrpcBilling(
        tenant_id="tenant-001",
        product_id="prod-001",
        api_key="sk_merge",
        ingestor_url="https://api.aforo.ai",
        service_name="acme.v1.UserService",
        flush_count=10_000,
        flush_interval_sec=3600,
        on_error=errors.append,
        on_drop=lambda events, reason: drops.append((list(events), reason)),
    )


def _emit(b, customer_id="cust_1"):
    b.record(method="GetUser", call_type="UNARY", customer_id=customer_id,
             status="OK", message_count=1, duration_ms=5)


def test_terminal_4xx_is_not_retried_and_drops_as_rejected(http):
    http.script = [(401, {}, b'{"errors":[{"message":"bad key"}]}')]
    drops, errors = [], []
    b = _make(drops, errors)
    _emit(b); _emit(b, "cust_2")
    b.shutdown()

    assert len(http.requests) == 1
    assert http.sleeps == []
    assert b.dropped_count == 2
    assert [(len(e), r) for e, r in drops] == [(2, "rejected")]
    assert all(ev["idempotencyKey"] for ev in drops[0][0])
    assert len(errors) == 1 and "HTTP 401" in str(errors[0]) and "bad key" in str(errors[0])


def test_5xx_exhaustion_drops_as_retry_exhausted_with_stable_keys(http):
    http.script = [(503, {}, b"")] * 3
    drops, errors = [], []
    b = _make(drops, errors)
    _emit(b)
    b.shutdown()

    assert len(http.requests) == 3
    keys = [r["body"]["events"][0]["idempotencyKey"] for r in http.requests]
    assert len(set(keys)) == 1
    assert b.dropped_count == 1
    assert drops[0][1] == "retry_exhausted"
    assert drops[0][0][0]["idempotencyKey"] == keys[0]


def test_429_waits_for_retry_after_then_succeeds(http):
    http.script = [(429, {"Retry-After": "7"}, b""), (202, {}, b"")]
    drops, errors = [], []
    b = _make(drops, errors)
    _emit(b)
    b.shutdown()

    assert len(http.requests) == 2
    assert http.sleeps == [7.0]
    assert b.dropped_count == 0 and drops == [] and errors == []


def test_partial_failure_drops_only_the_indexed_events(http):
    http.script = [(202, {}, json.dumps({"success": True, "data": {
        "accepted": 2, "failed": 1,
        "errors": [{"index": 1, "message": "unknown metric"}],
    }}).encode())]
    drops, errors = [], []
    b = _make(drops, errors)
    for c in ("cust_a", "cust_b", "cust_c"):
        _emit(b, c)
    b.shutdown()

    assert len(http.requests) == 1
    assert b.dropped_count == 1
    assert len(drops) == 1 and drops[0][1] == "rejected"
    assert [ev["customerId"] for ev in drops[0][0]] == ["cust_b"]
    assert len(errors) == 1 and "unknown metric" in str(errors[0])


def test_partial_failure_without_indexes_is_counted_but_not_attributed(http):
    http.script = [(202, {}, json.dumps({"accepted": 1, "failed": 2}).encode())]
    drops, errors = [], []
    b = _make(drops, errors)
    for c in ("cust_a", "cust_b", "cust_c"):
        _emit(b, c)
    b.shutdown()

    assert b.dropped_count == 2
    assert drops == []
    assert len(errors) == 1


def test_invalid_event_is_dropped_without_raising(http, caplog):
    drops, errors = [], []
    b = _make(drops, errors)
    with caplog.at_level(logging.WARNING, logger="aforo_grpc_metering"):
        for _ in range(3):
            _emit(b, "   ")
    _emit(b, "cust_ok")
    b.shutdown()

    assert b.dropped_count == 3
    assert [r for _e, r in drops] == ["invalid"] * 3
    assert all(e[0]["idempotencyKey"] for e, _r in drops)
    # Same message three times -> one WARNING line.
    assert len([r for r in caplog.records if "invalid event" in r.getMessage()]) == 1
    sent = [ev["customerId"] for r in http.requests for ev in r["body"]["events"]]
    assert sent == ["cust_ok"]
    assert "authorization" not in http.requests[0]["headers"]
    assert http.requests[0]["headers"]["x-api-key"] == "sk_merge"


def test_blank_method_is_an_invalid_drop(http):
    drops, errors = [], []
    b = _make(drops, errors)
    b.record(method="  ", call_type="UNARY", customer_id="cust_1",
             status="OK", message_count=1, duration_ms=5)
    b.shutdown()

    assert http.requests == []
    assert b.dropped_count == 1
    assert [r for _e, r in drops] == ["invalid"]
