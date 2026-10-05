"""The method name comes from the client's request. An over-long one is cut to
the ingestor's 128-character limit and the call is still metered, through the
interceptor and through ``record()``. ``customer_id`` is not altered and still
drops the event as ``invalid``; the configured service name is sent as given."""

from __future__ import annotations

import logging

import pytest

from aforo_grpc_metering import client as mod
from aforo_grpc_metering.client import (
    AforoGrpcBilling,
    AforoGrpcInterceptor,
    _fit_idempotency_key,
    _sha256_hex,
    _utf16_length,
)

ASTRAL = "\U0001F600"


@pytest.fixture
def sent(monkeypatch):
    batches: list = []

    def post(url, body, headers):
        batches.append(body["events"])
        return 202, None, b""

    monkeypatch.setattr(mod, "_post_json", post)
    return batches


def _billing(**kwargs):
    return AforoGrpcBilling(
        tenant_id="tenant-001", product_id="prod-grpc-001", api_key="k",
        ingestor_url="https://api.aforo.ai", service_name="acme.v1.UserService",
        flush_interval_sec=3600, flush_count=1000, **kwargs,
    )


class _Handler:
    unary_unary = staticmethod(lambda request, context: {"ok": True})
    request_deserializer = None
    response_serializer = None


class _Ctx:
    def __init__(self, customer_id="cust_001"):
        self._customer_id = customer_id

    def invocation_metadata(self):
        return (("x-customer-id", self._customer_id),)


def _call(interceptor, method, ctx=None):
    details = type("Details", (), {"method": f"/acme.v1.UserService/{method}"})()
    wrapped = interceptor.intercept_service(lambda _d: _Handler(), details)
    wrapped.unary_unary({}, ctx or _Ctx())


def test_over_long_method_is_truncated_and_call_is_metered(sent, caplog):
    drops: list = []
    b = _billing(on_drop=lambda evs, reason: drops.append(reason))
    interceptor = AforoGrpcInterceptor(b)
    # 126 + a 2-unit character + more: a cut at 128 units fits the pair exactly;
    # the second name would split a pair at 128, so it is cut at 127.
    first = "M" * 126 + ASTRAL + "x" * 100
    second = "M" * 127 + ASTRAL + "x" * 100
    with caplog.at_level(logging.WARNING, logger="aforo_grpc_metering"):
        _call(interceptor, first)
        _call(interceptor, second)
    b.shutdown()

    events = [e for batch in sent for e in batch]
    assert len(events) == 2 and drops == [] and b.dropped_count == 0
    assert events[0]["grpcMethod"] == "M" * 126 + ASTRAL
    assert events[1]["grpcMethod"] == "M" * 127
    for e in events:
        assert _utf16_length(e["grpcMethod"]) <= 128
        e["grpcMethod"].encode("utf-16-le")  # no lone surrogate
        assert e["grpcService"] == "acme.v1.UserService"
    warnings = [r for r in caplog.records if "truncated" in r.getMessage()]
    assert len(warnings) == 1 and "grpcMethod" in warnings[0].getMessage()

    for event, full in zip(events, (first, second)):
        key = event["idempotencyKey"]
        assert len(key) <= 255
        _, tenant, service, method_part, millis, nonce = key.split(":")
        assert method_part == _sha256_hex(full)
        assert key == _fit_idempotency_key(["grpc", tenant, service, full, millis, nonce], (3,))


def test_methods_sharing_the_first_128_characters_get_different_keys(sent):
    b = _billing()
    interceptor = AforoGrpcInterceptor(b)
    _call(interceptor, "M" * 128 + "a" * 150)
    _call(interceptor, "M" * 128 + "b" * 150)
    b.shutdown()
    events = [e for batch in sent for e in batch]
    assert events[0]["grpcMethod"] == events[1]["grpcMethod"] == "M" * 128
    assert events[0]["idempotencyKey"].split(":")[3] != events[1]["idempotencyKey"].split(":")[3]


def test_short_method_key_is_unchanged(sent):
    b = _billing()
    _call(AforoGrpcInterceptor(b), "GetUser")
    b.shutdown()
    event = sent[0][0]
    assert event["grpcMethod"] == "GetUser"
    assert event["idempotencyKey"].startswith("grpc:tenant-001:acme.v1.UserService:GetUser:")
    assert _fit_idempotency_key(["grpc", "t", "s", "GetUser", 5, "n"], (3,)) == "grpc:t:s:GetUser:5:n"


def test_over_long_customer_id_still_dropped_as_invalid(sent):
    drops: list = []
    b = _billing(on_drop=lambda evs, reason: drops.append((evs, reason)))
    _call(AforoGrpcInterceptor(b), "GetUser", _Ctx("c" * 65))
    b.record(method="GetUser", call_type="UNARY", customer_id="c" * 65, status="OK",
             message_count=1, duration_ms=1)
    b.shutdown()
    assert sent == [] and b.dropped_count == 2
    assert [reason for _evs, reason in drops] == ["invalid", "invalid"]
    assert drops[0][0][0]["customerId"] == "c" * 65


def test_record_truncates_the_method_too(sent):
    b = _billing()
    b.record(method="M" * 200, call_type="UNARY", customer_id="cust_1", status="OK",
             message_count=1, duration_ms=1)
    b.shutdown()
    event = sent[0][0]
    assert event["grpcMethod"] == "M" * 128 and b.dropped_count == 0
    # Built from the full name (too long for the key, so as its digest).
    assert event["idempotencyKey"].split(":")[3] == _sha256_hex("M" * 200)


def test_configured_service_name_is_not_truncated(sent):
    b = AforoGrpcBilling(
        tenant_id="tenant-001", product_id="p", api_key="k", ingestor_url="https://api.aforo.ai",
        service_name="s" * 300, flush_interval_sec=3600, flush_count=1000,
    )
    b.record(method="GetUser", call_type="UNARY", customer_id="cust_1", status="OK",
             message_count=1, duration_ms=1)
    b.shutdown()
    assert sent[0][0]["grpcService"] == "s" * 300  # config value: sent as given, as before
    assert len(sent[0][0]["idempotencyKey"]) <= 255
