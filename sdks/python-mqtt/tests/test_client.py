"""Tests for aforo_mqtt_metering.client.AforoMqttBilling.

Unique bits vs. gRPC family canary:
  - 6 event types (PUBLISH / DELIVER / SUBSCRIBE / UNSUBSCRIBE / CONNECT / DISCONNECT)
  - DELIVER opt-in via emit_deliver_events
  - QoS + retained flags on every event
  - metricName formula: mqtt_broker.{eventType.lower()}
"""

from __future__ import annotations

import json
import re
import time
from typing import List
from unittest import mock

import pytest

from aforo_mqtt_metering.client import AforoMqttBilling


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
    from aforo_mqtt_metering import client as mod
    monkeypatch.setattr(mod, "HAS_HTTPX", False, raising=False)
    c = FakeHttp()
    with mock.patch("urllib.request.urlopen", side_effect=c.urlopen):
        yield c


@pytest.fixture
def cfg():
    return dict(
        tenant_id="tenant-001",
        product_id="prod-mqtt-001",
        api_key="sk_mqtt_abc",
        ingestor_url="https://ingestor.aforo.ai",
    )


def wait_until(pred, timeout=1.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return
        time.sleep(0.01)
    raise AssertionError("timeout")


def drained_events(http):
    return [e for r in http.requests for e in r["body"].get("events", [])]


# ── PUBLISH ─────────────────────────────────────────────────────────────


def test_publish_event_shape(http, cfg):
    b = AforoMqttBilling(**cfg, flush_count=1, flush_interval_sec=60)
    b.push(
        customer_id="cust_001",
        topic="sensors/room-a/temperature",
        qos=1,
        retained=False,
        event_type="PUBLISH",
        client_id="device-001",
        data_bytes=4,
    )
    wait_until(lambda: len(http.requests) == 1)

    ev = drained_events(http)[0]
    assert ev["productType"] == "MQTT_BROKER"
    assert ev["mqttEventType"] == "PUBLISH"
    assert ev["mqttTopic"] == "sensors/room-a/temperature"
    assert ev["mqttQos"] == 1
    assert ev["mqttRetained"] is False
    assert ev["mqttClientId"] == "device-001"
    assert ev["dataBytes"] == 4
    assert ev["metricName"] == "mqtt_broker.publish"
    assert ev["metadata"]["productId"] == "prod-mqtt-001"
    b.shutdown()


# ── DELIVER opt-in ──────────────────────────────────────────────────────


def test_deliver_skipped_by_default(http, cfg):
    b = AforoMqttBilling(**cfg, flush_count=100, flush_interval_sec=60)
    b.push(
        customer_id="cust_001",
        topic="t",
        qos=0,
        retained=False,
        event_type="DELIVER",
        client_id="c",
        data_bytes=10,
    )
    b.shutdown()
    delivers = [e for e in drained_events(http) if e["mqttEventType"] == "DELIVER"]
    assert delivers == []


def test_deliver_emitted_when_enabled(http, cfg):
    b = AforoMqttBilling(**cfg, flush_count=1, flush_interval_sec=60, emit_deliver_events=True)
    b.push(
        customer_id="cust_001",
        topic="sensors/a",
        qos=1,
        retained=False,
        event_type="DELIVER",
        client_id="c",
        data_bytes=7,
    )
    wait_until(lambda: len(http.requests) == 1)
    delivers = [e for e in drained_events(http) if e["mqttEventType"] == "DELIVER"]
    assert len(delivers) == 1
    assert delivers[0]["metricName"] == "mqtt_broker.deliver"
    b.shutdown()


# ── All 6 event types produce correct metricName ────────────────────────


@pytest.mark.parametrize("event_type,metric_suffix", [
    ("PUBLISH", "publish"),
    ("DELIVER", "deliver"),
    ("SUBSCRIBE", "subscribe"),
    ("UNSUBSCRIBE", "unsubscribe"),
    ("CONNECT", "connect"),
    ("DISCONNECT", "disconnect"),
])
def test_metric_name_formula(http, cfg, event_type, metric_suffix):
    b = AforoMqttBilling(
        **cfg, flush_count=1, flush_interval_sec=60, emit_deliver_events=True,
    )
    b.push(
        customer_id="cust_001",
        topic="t",
        qos=0,
        retained=False,
        event_type=event_type,
        client_id="c",
    )
    wait_until(lambda: len(http.requests) == 1, timeout=2.0)
    assert drained_events(http)[0]["metricName"] == f"mqtt_broker.{metric_suffix}"
    b.shutdown()


# ── QoS + retained carried on every event (rate-plan filter support) ────


def test_qos_and_retained_flags_on_every_event(http, cfg):
    b = AforoMqttBilling(**cfg, flush_count=3, flush_interval_sec=60)
    for qos, retained in [(0, False), (1, True), (2, False)]:
        b.push(
            customer_id="cust_001",
            topic="t", qos=qos, retained=retained,
            event_type="PUBLISH", client_id="c",
        )
    wait_until(lambda: len(http.requests) == 1)

    events = drained_events(http)
    assert len(events) == 3
    assert [e["mqttQos"] for e in events] == [0, 1, 2]
    assert [e["mqttRetained"] for e in events] == [False, True, False]
    b.shutdown()


# ── Event shape ─────────────────────────────────────────────────────────


def test_idempotency_key_format(http, cfg):
    b = AforoMqttBilling(**cfg, flush_count=1, flush_interval_sec=60)
    b.push(
        customer_id="cust_001",
        topic="a/b",
        qos=0,
        retained=False,
        event_type="PUBLISH",
        client_id="c1",
    )
    wait_until(lambda: len(http.requests) == 1)
    key = drained_events(http)[0]["idempotencyKey"]
    assert re.match(r"^mqtt:tenant-001:c1:PUBLISH:a/b:\d+:[0-9a-f]{8}$", key)
    b.shutdown()


def test_shutdown_flushes_pending(http, cfg):
    b = AforoMqttBilling(**cfg, flush_count=100, flush_interval_sec=60)
    for i in range(4):
        b.push(
            customer_id="cust_001",
            topic=f"t{i}", qos=0, retained=False,
            event_type="PUBLISH", client_id="c",
        )
    b.shutdown()
    assert len(drained_events(http)) == 4
