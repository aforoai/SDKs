"""Ingest contract tests: batches go to POST /v1/ingest/batch as
{"events": [...]} with the key only in X-API-Key, at most 1000 events per
request, using IngestUsageEventRequest field names."""

from __future__ import annotations

import json
import re
from typing import List
from unittest import mock

import pytest

from aforo_grpc_metering import client as mod
from aforo_grpc_metering.client import AforoGrpcBilling

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
        ingestor_url="https://usage-ingestor.aforo.ai/",
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
    assert req["url"] == "https://usage-ingestor.aforo.ai/v1/ingest/batch"
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
def test_invalid_customer_id_is_not_sent(monkeypatch, bad):
    h, patcher = _install(monkeypatch)
    try:
        b = _make()
        _emit_customer(b, bad)
        b.shutdown()
    finally:
        patcher.stop()
    assert h.requests == []
