"""executionStatus on MQTT events (P6 item 15).

MQTT has no outcome the SDK can see (events are emitted before the broker
answers), so only explicit values are sent: trimmed + upper-cased, left off
the wire when unset or blank.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List
from unittest import mock

import pytest

from aforo_mqtt_metering import client as mod
from aforo_mqtt_metering import AforoMqttBilling, wrap_paho_client


class _FakeHttp:
    def __init__(self) -> None:
        self.bodies: List[Dict[str, Any]] = []

    def urlopen(self, req, timeout=None):  # noqa: ARG002
        self.bodies.append(json.loads(req.data.decode("utf-8")))

        class _R:
            status = 202

            def __enter__(self_i):
                return self_i

            def __exit__(self_i, *_a):
                return False

        return _R()


@pytest.fixture
def http(monkeypatch):
    monkeypatch.setattr(mod, "HAS_HTTPX", False, raising=False)
    fake = _FakeHttp()
    with mock.patch("urllib.request.urlopen", side_effect=fake.urlopen):
        yield fake


def _billing() -> AforoMqttBilling:
    return AforoMqttBilling(
        tenant_id="tenant-001",
        product_id="prod-mqtt-001",
        api_key="sk_mqtt_abc",
        ingestor_url="https://api.aforo.ai",
        flush_count=1000,
        flush_interval_sec=60,
    )


def _events(http: _FakeHttp) -> List[Dict[str, Any]]:
    return [e for body in http.bodies for e in body["events"]]


COMMON = dict(customer_id="cust_001", topic="t/1", qos=1, retained=False,
              event_type="PUBLISH", client_id="dev-1")


def test_explicit_status_trimmed_and_upper_cased(http):
    b = _billing()
    b.push(**COMMON, execution_status=" failed ")
    b.shutdown()
    assert _events(http)[0]["executionStatus"] == "FAILED"


def test_unset_or_blank_is_omitted(http):
    b = _billing()
    b.push(**COMMON)
    b.push(**COMMON, execution_status="   ")
    b.push(**COMMON, execution_status=None)
    b.shutdown()
    events = _events(http)
    assert len(events) == 3
    assert all("executionStatus" not in e for e in events)


def test_push_is_keyword_only():
    b = _billing()
    try:
        with pytest.raises(TypeError):
            b.push("cust_001", "t/1", 1, False, "PUBLISH", "dev-1", 0, None, "SUCCESS")  # type: ignore[misc]
    finally:
        b.shutdown()


def test_wrapped_client_events_carry_no_status(http):
    class _PahoLike:
        _client_id = b"dev-1"

        def publish(self, topic, payload=None, qos=0, retain=False, **kw):
            return None

        def subscribe(self, topic, qos=0, *a, **kw):
            return None

        def unsubscribe(self, topic, *a, **kw):
            return None

    b = _billing()
    c = _PahoLike()
    wrap_paho_client(b, c, customer_id="cust_001")
    c.publish("t/1", "x", qos=1)
    c.subscribe("t/#")
    c.on_connect(c, None, {}, 0)
    c.on_disconnect(c, None, 1)
    b.shutdown()
    events = _events(http)
    assert len(events) == 4
    assert all("executionStatus" not in e for e in events)


def _contract_statuses():
    from pathlib import Path
    here = Path(__file__).resolve()
    fixture = json.loads((here.parents[2] / "contract" / "ingest-contract.json").read_text())
    endpoint = fixture["sdks"][here.parents[1].name]["endpoint"]
    spec = fixture["endpoints"][endpoint]["eventOptionalFields"]["executionStatus"]
    return spec["values"], spec["maxLength"]


def test_canonical_statuses_match_contract():
    values, max_len = _contract_statuses()
    assert mod.EXECUTION_STATUSES == frozenset(values)
    assert all(len(v) <= max_len for v in values)
    for v in values:
        assert mod.normalize_execution_status(v.lower()) == v


def test_unknown_explicit_status_is_omitted_and_event_still_sent(http, caplog):
    b = _billing()
    with caplog.at_level("WARNING", logger="aforo_mqtt_metering"):
        b.push(**COMMON, execution_status="bogus")
        b.push(**COMMON, execution_status="X" * 25)
        b.push(**COMMON, execution_status="success")
    b.shutdown()
    events = _events(http)
    assert len(events) == 3
    assert "executionStatus" not in events[0]
    assert "executionStatus" not in events[1]
    assert events[2]["executionStatus"] == "SUCCESS"
    assert events[0]["customerId"] == "cust_001" and events[0]["mqttTopic"] == "t/1"
    assert "Ignoring unknown executionStatus" in caplog.text
