"""Ingest-contract guard (A+ delivery-guarantee prompt 7).

Validates the OBSERVED wire request (endpoint path + body shape) against the
shared, checked-in contract fixture at contract/ingest-contract.json — which
is derived from the REAL usage-ingestor controllers/DTOs, never from this
SDK's own constants. The 2026-07-05 D1 incident shipped this very SDK posting
a batch body to a single-event endpoint; its own green suite hid 100% event
loss because it asserted the SDK's own (wrong) constant.

Also covers the transport rules shared by every variant: the key travels only
in X-API-Key, a flush is split into requests of at most 1000 events,
idempotency keys are reused verbatim on retry, and an event with an unusable
customerId is dropped with reason "invalid" instead of being sent.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import List
from urllib.parse import urlparse

from unittest import mock

import pytest

from aforo_grpc_metering import client as mod
from aforo_grpc_metering.client import AforoGrpcBilling

MODULE_KEY = "python-grpc"

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "contract" / "ingest-contract.json").read_text()
)


def _assert_required(obj: dict, field: str) -> None:
    assert field in obj, f"required field '{field}' missing from wire body"
    v = obj[field]
    assert v is not None, f"required field '{field}' is null"
    if isinstance(v, str):
        assert v.strip() != "", f"required field '{field}' is blank"


def assert_body_matches_contract(spec: dict, body) -> None:
    """Same assertion shape in every SDK suite (all languages)."""
    assert body is not None
    if spec["cardinality"] == "batch-wrapped":
        # A bare array here is the /v1/ingest/async-batch shape — wrong for this endpoint.
        assert isinstance(body, dict), "batch body must be an object, not a bare array"
        events = body.get(spec["batchKey"])
        assert isinstance(events, list) and events, f"batch body must carry non-empty '{spec['batchKey']}'"
        assert len(events) <= spec["maxEvents"]
        for ev in events:
            for field in spec["eventRequiredFields"]:
                _assert_required(ev, field)
    elif spec["cardinality"] == "single":
        assert isinstance(body, dict)
        for key in spec.get("forbiddenTopLevelKeys", []):
            assert key not in body, f"single-event body must not carry '{key}'"
        for field in spec["requiredFields"]:
            _assert_required(body, field)
    else:
        raise AssertionError(f"unhandled cardinality in fixture: {spec['cardinality']}")


class _CapturingClient:
    """Stand-in for httpx.Client that records the POST and returns 202."""

    captured: list = []

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def post(self, url, json=None, headers=None):
        _CapturingClient.captured.append((url, json, headers))
        resp = mock.MagicMock()
        resp.status_code = 202
        return resp


def test_posts_to_contracted_endpoint_with_contracted_body_shape(monkeypatch):
    sdk_entry = FIXTURE["sdks"].get(MODULE_KEY)
    assert sdk_entry is not None, "module must be registered in the fixture"
    endpoint = sdk_entry["endpoint"]
    spec = FIXTURE["endpoints"][endpoint]

    _CapturingClient.captured = []
    monkeypatch.setattr(mod, "HAS_HTTPX", True, raising=False)
    monkeypatch.setattr(mod.httpx, "Client", _CapturingClient)

    billing = AforoGrpcBilling(
        tenant_id="tenant-001",
        product_id="prod-grpc-001",
        api_key="sk_test_abc",
        ingestor_url="https://ingest.test.aforo.ai",
        service_name="acme.v1.UserService",
    )
    billing.record(
        method="GetUser",
        call_type="UNARY",
        customer_id="cust_contract",
        status="OK",
        message_count=1,
        duration_ms=5,
    )
    billing.shutdown()

    assert _CapturingClient.captured, "no wire request observed"
    url, body, _headers = _CapturingClient.captured[0]
    assert urlparse(str(url)).path == endpoint
    assert_body_matches_contract(spec, body)


def test_execution_status_is_contracted_optional_field_sent_only_when_set(monkeypatch):
    spec = FIXTURE["endpoints"][FIXTURE["sdks"][MODULE_KEY]["endpoint"]]
    status_spec = spec["eventOptionalFields"]["executionStatus"]

    _CapturingClient.captured = []
    monkeypatch.setattr(mod, "HAS_HTTPX", True, raising=False)
    monkeypatch.setattr(mod.httpx, "Client", _CapturingClient)

    billing = AforoGrpcBilling(
        tenant_id="tenant-001",
        product_id="prod-grpc-001",
        api_key="sk_test_abc",
        ingestor_url="https://ingest.test.aforo.ai",
        service_name="acme.v1.UserService",
    )
    billing.record("GetUser", "UNARY", "cust_contract", "OK", 1, 5, execution_status="timeout")
    billing.record("GetUser", "UNARY", "cust_contract", "NOT_A_GRPC_STATUS", 1, 5)
    billing.shutdown()

    assert _CapturingClient.captured, "no wire request observed"
    _url, body, _headers = _CapturingClient.captured[0]
    assert_body_matches_contract(spec, body)
    with_status, without_status = body[spec["batchKey"]]
    assert with_status["executionStatus"] == "TIMEOUT"
    assert with_status["executionStatus"] in status_spec["values"]
    assert len(with_status["executionStatus"]) <= status_spec["maxLength"]
    assert "executionStatus" not in without_status


def test_every_derivable_grpc_outcome_is_a_contracted_value():
    import grpc

    from aforo_grpc_metering import outcome_from_grpc_status

    values = FIXTURE["endpoints"]["/v1/ingest/batch"]["eventOptionalFields"]["executionStatus"]["values"]
    derived = {outcome_from_grpc_status(code) for code in grpc.StatusCode}
    derived.add(outcome_from_grpc_status(999))  # unlisted code -> ERROR
    assert derived <= set(values), derived - set(values)


# ── Transport rules (X-API-Key, 1000-event requests, stable keys) ──

ALLOWED_TOP_LEVEL = {
    "customerId", "metricName", "quantity", "occurredAt", "idempotencyKey",
    "traceId", "spanId", "sessionId", "metadata", "productType",
    "executionDurationMs", "executionStatus", "dataBytes", "messageCount",
    "grpcService", "grpcMethod", "grpcStatusCode", "grpcCallType",
}
ISO_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


class _Http:
    def __init__(self, statuses=None):
        self.statuses = list(statuses or [])
        self.requests: List[dict] = []

    def urlopen(self, req, timeout=None):
        self.requests.append({
            "url": req.full_url,
            "headers": {k.lower(): v for k, v in req.header_items()},
            "body": json.loads(req.data.decode("utf-8")),
        })
        code = self.statuses.pop(0) if self.statuses else 202

        class _R:
            status = code
            def __enter__(self_i): return self_i
            def __exit__(self_i, *_a): return False
            def read(self_i): return b""

        return _R()


def _install(monkeypatch, statuses=None):
    monkeypatch.setattr(mod, "HAS_HTTPX", False, raising=False)
    monkeypatch.setattr(mod.time, "sleep", lambda _s: None)
    h = _Http(statuses)
    patcher = mock.patch("urllib.request.urlopen", side_effect=h.urlopen)
    patcher.start()
    return h, patcher


def _make():
    return AforoGrpcBilling(
        tenant_id="tenant-001",
        product_id="prod-001",
        api_key="sk_contract",
        ingestor_url="https://api.aforo.ai/",
        flush_count=10_000,
        flush_interval_sec=3600,
        service_name="acme.v1.UserService",
    )


def _emit(b, i):
    _emit_customer(b, f"cust_{i}")


def _emit_customer(b, customer_id):
    b.record(method="GetUser", call_type="server_stream", customer_id=customer_id,
             status=5, message_count=3, duration_ms=42, data_bytes=128)


def test_posts_batch_to_v1_ingest_batch_with_dto_shape(monkeypatch):
    h, patcher = _install(monkeypatch)
    try:
        b = _make()
        _emit(b, 0)
        b.shutdown()
    finally:
        patcher.stop()

    assert len(h.requests) == 1
    req = h.requests[0]
    assert req["url"] == "https://api.aforo.ai/v1/ingest/batch"
    assert req["headers"]["x-api-key"] == "sk_contract"
    assert "authorization" not in req["headers"]
    assert set(req["body"].keys()) == {"events"}
    assert "sk_contract" not in json.dumps(req["body"])

    ev = req["body"]["events"][0]
    assert "apiKey" not in ev
    assert set(ev.keys()) <= ALLOWED_TOP_LEVEL, set(ev.keys()) - ALLOWED_TOP_LEVEL
    assert ev["customerId"] == "cust_0"
    assert ev["quantity"] > 0
    assert ISO_INSTANT.match(ev["occurredAt"])
    assert ev["idempotencyKey"] and len(ev["idempotencyKey"]) <= 255
    assert ev["productType"] == "GRPC_API"
    assert ev["grpcService"] == "acme.v1.UserService"
    assert ev["grpcMethod"] == "GetUser"
    assert ev["grpcStatusCode"] == "NOT_FOUND"  # int code normalised to label
    assert ev["grpcCallType"] == "SERVER_STREAM"
    assert ev["messageCount"] == 3
    assert ev["executionDurationMs"] == 42
    assert ev["dataBytes"] == 128


def test_more_than_1000_events_are_split_into_batches_of_at_most_1000(monkeypatch):
    h, patcher = _install(monkeypatch)
    try:
        b = _make()
        for i in range(2500):
            _emit(b, i)
        b.shutdown()
    finally:
        patcher.stop()

    sizes = [len(r["body"]["events"]) for r in h.requests]
    assert sizes == [1000, 1000, 500]
    assert all(r["url"].endswith("/v1/ingest/batch") for r in h.requests)
    keys = [e["idempotencyKey"] for r in h.requests for e in r["body"]["events"]]
    assert len(set(keys)) == 2500


def test_idempotency_keys_are_stable_across_retries(monkeypatch):
    h, patcher = _install(monkeypatch, statuses=[503, 202])
    try:
        b = _make()
        for i in range(3):
            _emit(b, i)
        b.shutdown()
    finally:
        patcher.stop()

    assert len(h.requests) == 2
    first = [e["idempotencyKey"] for e in h.requests[0]["body"]["events"]]
    retry = [e["idempotencyKey"] for e in h.requests[1]["body"]["events"]]
    assert first == retry and len(set(first)) == 3


@pytest.mark.parametrize("bad", ["", "   ", "c" * 65])
def test_invalid_customer_id_is_dropped_as_invalid_and_not_sent(monkeypatch, bad):
    h, patcher = _install(monkeypatch)
    drops = []
    try:
        b = _make()
        b.on_drop = lambda events, reason: drops.append((events, reason))
        _emit_customer(b, bad)  # must not raise
        assert b.dropped_count == 1
        b.shutdown()
    finally:
        patcher.stop()
    assert h.requests == []
    assert len(drops) == 1
    events, reason = drops[0]
    assert reason == "invalid"
    assert len(events) == 1 and events[0]["idempotencyKey"]
