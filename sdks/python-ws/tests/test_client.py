"""Tests for aforo_ws_metering.client.AforoWsBilling.

Unique bits vs. gRPC family canary:
  - push() with protocol-specific frameType → metricName mapping
  - Close-reason mapping (WS_CLOSE_REASONS dict)
  - idempotencyKey shape: ws:{tenant}:{connId}:{frameType}:{millis}:{8-hex}
"""

from __future__ import annotations

import json
import re
import time
from typing import List
from unittest import mock

import pytest

from aforo_ws_metering.client import AforoWsBilling, WS_CLOSE_REASONS


class FakeHttp:
    def __init__(self):
        self.requests: List[dict] = []

    def urlopen(self, req, timeout=None):
        body = req.data.decode("utf-8") if req.data else ""
        self.requests.append({"body": json.loads(body) if body else {}})

        class _R:
            status = 204
            def __enter__(self_i): return self_i
            def __exit__(self_i, *_a): return False
            def read(self_i): return b""
        return _R()


@pytest.fixture
def http(monkeypatch):
    from aforo_ws_metering import client as mod
    monkeypatch.setattr(mod, "HAS_HTTPX", False, raising=False)
    c = FakeHttp()
    with mock.patch("urllib.request.urlopen", side_effect=c.urlopen):
        yield c


@pytest.fixture
def cfg():
    return dict(
        tenant_id="tenant-001",
        product_id="prod-ws-001",
        api_key="sk_ws_abc",
        ingestor_url="https://ingestor.aforo.ai",
    )


def wait_until(pred, timeout=1.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return
        time.sleep(0.01)
    raise AssertionError("timeout")


# ── Close-reason dict ───────────────────────────────────────────────────


def test_close_reasons_dict_has_expected_entries():
    assert WS_CLOSE_REASONS[1000] == "NORMAL_CLOSURE"
    assert WS_CLOSE_REASONS[1001] == "GOING_AWAY"
    assert WS_CLOSE_REASONS[1006] == "ABNORMAL_CLOSURE"
    assert WS_CLOSE_REASONS[1008] == "POLICY_VIOLATION"
    assert WS_CLOSE_REASONS[1009] == "MESSAGE_TOO_BIG"
    assert WS_CLOSE_REASONS[1011] == "INTERNAL_ERROR"


# ── push() event shape ──────────────────────────────────────────────────


def test_push_connection_opened(http, cfg):
    b = AforoWsBilling(**cfg, flush_count=1, flush_interval_sec=60)
    b.push({
        "customerId": "cust_001",
        "wsConnectionId": "ws_abc123",
        "wsDirection": "SERVER_TO_CLIENT",
        "wsFrameType": "PING",
        "metadata": {"event": "CONNECTION_OPENED"},
    })
    wait_until(lambda: len(http.requests) == 1)

    ev = http.requests[0]["body"]["events"][0]
    assert ev["productType"] == "WEBSOCKET_API"
    assert ev["wsConnectionId"] == "ws_abc123"
    assert ev["wsFrameType"] == "PING"
    assert ev["metricName"] == "websocket_api.message"  # PING is not CLOSE → message
    assert ev["metadata"]["event"] == "CONNECTION_OPENED"
    assert ev["metadata"]["productId"] == "prod-ws-001"
    b.shutdown()


def test_push_connection_closed_uses_close_metric(http, cfg):
    b = AforoWsBilling(**cfg, flush_count=1, flush_interval_sec=60)
    b.push({
        "customerId": "cust_001",
        "wsConnectionId": "ws_abc123",
        "wsDirection": "SERVER_TO_CLIENT",
        "wsFrameType": "CLOSE",
        "wsCloseReason": "NORMAL_CLOSURE",
        "messageCount": 10,
        "dataBytes": 500,
        "durationMs": 1800000,
    })
    wait_until(lambda: len(http.requests) == 1)

    ev = http.requests[0]["body"]["events"][0]
    assert ev["wsFrameType"] == "CLOSE"
    assert ev["metricName"] == "websocket_api.connection_closed"
    assert ev["wsCloseReason"] == "NORMAL_CLOSURE"
    assert ev["messageCount"] == 10
    assert ev["dataBytes"] == 500
    assert ev["durationMs"] == 1800000
    b.shutdown()


def test_idempotency_key_format(http, cfg):
    b = AforoWsBilling(**cfg, flush_count=1, flush_interval_sec=60)
    b.push({
        "customerId": "cust_001",
        "wsConnectionId": "ws_abc123",
        "wsDirection": "SERVER_TO_CLIENT",
        "wsFrameType": "CLOSE",
    })
    wait_until(lambda: len(http.requests) == 1)
    key = http.requests[0]["body"]["events"][0]["idempotencyKey"]
    assert re.match(r"^ws:tenant-001:ws_abc123:CLOSE:\d+:[0-9a-f]{8}$", key)
    b.shutdown()


def test_shutdown_flushes_pending(http, cfg):
    b = AforoWsBilling(**cfg, flush_count=100, flush_interval_sec=60)
    for i in range(4):
        b.push({
            "customerId": f"cust_{i}",
            "wsConnectionId": f"ws_{i}",
            "wsDirection": "SERVER_TO_CLIENT",
            "wsFrameType": "TEXT",
            "messageCount": 1,
            "dataBytes": 10,
        })
    b.shutdown()
    assert len(http.requests) == 1
    assert len(http.requests[0]["body"]["events"]) == 4


def test_idempotency_keys_unique(http, cfg):
    b = AforoWsBilling(**cfg, flush_count=5, flush_interval_sec=60)
    for _ in range(5):
        b.push({
            "customerId": "cust_001",
            "wsConnectionId": "ws_abc",
            "wsDirection": "SERVER_TO_CLIENT",
            "wsFrameType": "TEXT",
        })
    wait_until(lambda: len(http.requests) == 1)
    keys = [e["idempotencyKey"] for e in http.requests[0]["body"]["events"]]
    assert len(set(keys)) == 5
    b.shutdown()
