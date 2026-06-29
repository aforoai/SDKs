"""
Unit tests for aforo_grpc_metering.client.AforoGrpcBilling.

These tests validate the buffer/flush/retry/customer-id pattern shared
(with small variations) across all 4 Python SDKs: aforo-grpc-metering,
aforo-graphql-metering, aforo-ws-metering, aforo-mqtt-metering. A
bug in this test is likely to reflect a bug in the sibling packages.

Runs with pytest + pytest-mock (no network, urllib stubbed).
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, List
from unittest import mock

import pytest

from aforo_grpc_metering.client import (
    AforoGrpcBilling,
    GRPC_STATUS_LABELS,
)


# ── Shared fixtures ──────────────────────────────────────────────────────


class FakeHttpCollector:
    """Collects POSTed requests that urllib.request.urlopen would send."""

    def __init__(self, status: int = 204) -> None:
        self.status = status
        self.requests: List[dict] = []

    def urlopen(self, req, timeout=None):  # noqa: ARG002
        body = req.data.decode("utf-8") if req.data else ""
        parsed = json.loads(body) if body else {}
        self.requests.append({
            "url": req.full_url,
            "method": req.get_method(),
            "headers": dict(req.header_items()),
            "body": parsed,
        })
        # context-manager compatible response
        outer_status = self.status

        class _Resp:
            status = outer_status

            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *_a):
                return False

            def read(self_inner):
                return b""

        return _Resp()


@pytest.fixture
def http_collector(monkeypatch):
    """Replace urllib.request.urlopen inside the client module so no network is touched."""
    # Ensure the SDK uses urllib (not httpx) for deterministic test surface
    from aforo_grpc_metering import client as client_mod

    monkeypatch.setattr(client_mod, "HAS_HTTPX", False, raising=False)

    collector = FakeHttpCollector(status=204)
    with mock.patch("urllib.request.urlopen", side_effect=collector.urlopen):
        yield collector


@pytest.fixture
def billing_config():
    return dict(
        tenant_id="tenant-001",
        product_id="prod-001",
        api_key="sk_test_abc",
        ingestor_url="https://ingestor.aforo.ai/",  # trailing slash stripped
        service_name="acme.v1.UserService",
    )


def make_ctx(customer_id: str | None = "cust_001"):
    """Minimal stand-in for grpc.ServicerContext used by the default extractor."""
    class _Ctx:
        def invocation_metadata(self_inner):
            return (("x-customer-id", customer_id),) if customer_id else ()
    return _Ctx()


# ── Constructor / validation ─────────────────────────────────────────────


def test_requires_all_core_fields():
    with pytest.raises(ValueError):
        AforoGrpcBilling(
            tenant_id="",
            product_id="p",
            api_key="k",
            ingestor_url="u",
            service_name="s",
        )
    with pytest.raises(ValueError):
        AforoGrpcBilling(
            tenant_id="t",
            product_id="",
            api_key="k",
            ingestor_url="u",
            service_name="s",
        )


def test_grpc_status_labels_complete():
    # All 17 gRPC status codes (0 OK .. 16 UNAUTHENTICATED)
    assert len(GRPC_STATUS_LABELS) == 17
    assert GRPC_STATUS_LABELS[0] == "OK"
    assert GRPC_STATUS_LABELS[5] == "NOT_FOUND"
    assert GRPC_STATUS_LABELS[16] == "UNAUTHENTICATED"


# ── record() happy path ──────────────────────────────────────────────────


def test_record_emits_event_with_correct_shape(http_collector, billing_config):
    b = AforoGrpcBilling(**billing_config, flush_count=1, flush_interval_sec=60)

    b.record(
        method="GetUser",
        call_type="UNARY",
        customer_id="cust_001",
        status="OK",
        message_count=1,
        duration_ms=42,
    )
    # Wait for the async flush triggered by flush_count
    _wait_until(lambda: len(http_collector.requests) == 1)

    req = http_collector.requests[0]
    assert req["url"] == "https://ingestor.aforo.ai/v1/ingest/events"  # trailing slash stripped
    assert req["method"] == "POST"
    assert req["headers"]["Content-type"] == "application/json"
    assert req["headers"]["Authorization"] == "Bearer sk_test_abc"
    assert req["headers"]["X-tenant-id"] == "tenant-001"

    events = req["body"]["events"]
    assert len(events) == 1
    ev = events[0]
    assert ev["productType"] == "GRPC_API"
    assert ev["grpcService"] == "acme.v1.UserService"
    assert ev["grpcMethod"] == "GetUser"
    assert ev["grpcStatusCode"] == "OK"
    assert ev["grpcCallType"] == "UNARY"
    assert ev["messageCount"] == 1
    assert ev["executionDurationMs"] == 42
    assert ev["customerId"] == "cust_001"
    assert ev["metadata"]["productId"] == "prod-001"
    assert isinstance(ev["metadata"]["sdkVersion"], str)
    assert ev["metricName"] == "grpc_api.rpc_calls"
    assert re.match(
        r"^grpc:tenant-001:acme\.v1\.UserService:GetUser:\d+:[0-9a-f]{8}$",
        ev["idempotencyKey"],
    )
    b.shutdown()


def test_record_with_no_customer_id_is_skipped(http_collector, billing_config):
    b = AforoGrpcBilling(**billing_config, flush_count=1, flush_interval_sec=60)
    b.record(
        method="Health",
        call_type="UNARY",
        customer_id="",  # falsy → skip
        status="OK",
        message_count=1,
        duration_ms=1,
    )
    # Trigger a shutdown-flush to prove no event was queued
    b.shutdown()
    assert http_collector.requests == []


# ── Buffer batching ──────────────────────────────────────────────────────


def test_flush_count_triggers_batched_flush(http_collector, billing_config):
    b = AforoGrpcBilling(**billing_config, flush_count=3, flush_interval_sec=60)

    for i in range(2):
        b.record("M", "UNARY", f"cust_{i}", "OK", 1, 1)
    # 2 events: no flush yet
    time.sleep(0.05)
    assert len(http_collector.requests) == 0

    b.record("M", "UNARY", "cust_3", "OK", 1, 1)
    _wait_until(lambda: len(http_collector.requests) == 1)
    assert len(http_collector.requests[0]["body"]["events"]) == 3
    b.shutdown()


def test_shutdown_flushes_remaining_events(http_collector, billing_config):
    b = AforoGrpcBilling(**billing_config, flush_count=100, flush_interval_sec=60)
    b.record("M", "UNARY", "cust_1", "OK", 1, 1)
    b.record("M", "UNARY", "cust_2", "OK", 1, 1)
    b.shutdown()
    assert len(http_collector.requests) == 1
    assert len(http_collector.requests[0]["body"]["events"]) == 2


def test_idempotency_keys_are_unique_across_rapid_calls(http_collector, billing_config):
    b = AforoGrpcBilling(**billing_config, flush_count=5, flush_interval_sec=60)
    for _ in range(5):
        b.record("M", "UNARY", "cust_1", "OK", 1, 1)
    _wait_until(lambda: len(http_collector.requests) == 1)
    keys = [e["idempotencyKey"] for e in http_collector.requests[0]["body"]["events"]]
    assert len(set(keys)) == 5  # no collision
    b.shutdown()


# ── Retry behaviour ──────────────────────────────────────────────────────


def test_retry_3_times_then_onerror(billing_config, monkeypatch):
    """Simulate a hard failure on every attempt — expect 3 retries + onError."""
    from aforo_grpc_metering import client as client_mod

    monkeypatch.setattr(client_mod, "HAS_HTTPX", False, raising=False)

    call_count = {"n": 0}

    def always_fail(req, timeout=None):  # noqa: ARG001
        call_count["n"] += 1
        raise RuntimeError("network down")

    # Speed up the retry backoff so the test doesn't take 7 seconds
    monkeypatch.setattr(time, "sleep", lambda _: None)

    errors = []

    b = AforoGrpcBilling(
        **billing_config,
        flush_count=1,
        flush_interval_sec=60,
        on_error=lambda e: errors.append(e),
    )

    with mock.patch("urllib.request.urlopen", side_effect=always_fail):
        b.record("M", "UNARY", "cust_1", "OK", 1, 1)
        _wait_until(lambda: len(errors) >= 1, timeout=2.0)

    assert call_count["n"] == 3
    assert len(errors) == 1
    assert "network down" in str(errors[0])
    b.shutdown()


# ── Helper ───────────────────────────────────────────────────────────────


def _wait_until(predicate, timeout: float = 1.0, interval: float = 0.01) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(interval)
    raise AssertionError("predicate never became true within timeout")
