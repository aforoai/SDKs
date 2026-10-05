"""Topic and client id originate from the MQTT traffic. Over-long values are cut
to the ingestor's limits (500 / 128) and the event is still sent, through the
client wrappers and through ``push()``. ``customer_id`` is not altered and still
drops the event as ``invalid``."""

from __future__ import annotations

import logging

import pytest

from aforo_mqtt_metering import AforoMqttBilling, wrap_paho_client
from aforo_mqtt_metering import client as mod
from aforo_mqtt_metering.client import _fit_idempotency_key, _sha256_hex, _utf16_length

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
    return AforoMqttBilling(
        tenant_id="tenant-001", product_id="prod-mqtt-001", api_key="k",
        ingestor_url="https://api.aforo.ai", flush_interval_sec=3600, flush_count=1000, **kwargs,
    )


class _PahoLike:
    def __init__(self, client_id=b"dev-1"):
        self._client_id = client_id

    def publish(self, topic, payload=None, qos=0, retain=False, **kw):
        return None

    def subscribe(self, topic, qos=0, *a, **kw):
        return None

    def unsubscribe(self, topic, *a, **kw):
        return None


def _events(sent):
    return [e for batch in sent for e in batch]


def test_over_long_topic_is_truncated_and_event_is_sent(sent, caplog):
    drops: list = []
    b = _billing(on_drop=lambda evs, reason: drops.append(reason))
    c = _PahoLike()
    wrap_paho_client(b, c, customer_id="cust_001")
    # A cut at 500 units would split the pair in the first topic: cut at 499.
    first = "t" * 499 + ASTRAL + "/tail"
    second = "t" * 500 + "/other"
    with caplog.at_level(logging.WARNING, logger="aforo_mqtt_metering"):
        c.publish(first, "x")
        c.subscribe(second)
    b.shutdown()

    events = _events(sent)
    assert len(events) == 2 and drops == [] and b.dropped_count == 0
    assert events[0]["mqttTopic"] == "t" * 499
    assert events[1]["mqttTopic"] == "t" * 500
    for e in events:
        assert _utf16_length(e["mqttTopic"]) <= 500
        e["mqttTopic"].encode("utf-16-le")  # no lone surrogate
    warnings = [r for r in caplog.records if "truncated" in r.getMessage()]
    assert len(warnings) == 1 and "mqttTopic" in warnings[0].getMessage()

    for event, full in zip(events, (first, second)):
        key = event["idempotencyKey"]
        assert len(key) <= 255
        _, tenant, client_id, event_type, topic_part, millis, nonce = key.split(":")
        # Built from the full topic, before truncation.
        assert topic_part == _sha256_hex(full)
        assert key == _fit_idempotency_key(
            ["mqtt", tenant, client_id, event_type, full, millis, nonce], (4, 2))


def test_topics_sharing_the_first_500_characters_get_different_keys(sent):
    b = _billing()
    c = _PahoLike()
    wrap_paho_client(b, c, customer_id="cust_001")
    c.publish("t" * 500 + "a", "x")
    c.publish("t" * 500 + "b", "x")
    b.shutdown()
    events = _events(sent)
    assert events[0]["mqttTopic"] == events[1]["mqttTopic"] == "t" * 500
    assert events[0]["idempotencyKey"].split(":")[4] != events[1]["idempotencyKey"].split(":")[4]


def test_delivered_message_topic_is_truncated(sent):
    b = _billing(emit_deliver_events=True)
    c = _PahoLike()
    wrap_paho_client(b, c, customer_id="cust_001")
    msg = type("Msg", (), {"topic": "d" * 800, "qos": 1, "retain": False, "payload": b"abc"})()
    c.on_message(c, None, msg)
    b.shutdown()
    (event,) = _events(sent)
    assert event["mqttEventType"] == "DELIVER" and event["mqttTopic"] == "d" * 500


def test_client_id_read_from_the_mqtt_client_is_truncated(sent, caplog):
    b = _billing()
    full_id = "c" * 127 + ASTRAL + "more"
    c = _PahoLike(client_id=full_id.encode("utf-8"))
    wrap_paho_client(b, c, customer_id="cust_001")
    with caplog.at_level(logging.WARNING, logger="aforo_mqtt_metering"):
        c.publish("t/1", "x")
        c.on_connect(c, None, {}, 0)
    b.shutdown()
    events = _events(sent)
    assert len(events) == 2 and b.dropped_count == 0
    assert all(e["mqttClientId"] == "c" * 127 for e in events)
    assert events[1]["mqttTopic"] == "$SYS/clients/" + "c" * 127 + "/connected"
    assert len([r for r in caplog.records if "mqttClientId" in r.getMessage()]) == 1
    # The key carries the full client id, never the truncated label.
    key = events[0]["idempotencyKey"]
    assert key.split(":")[2] == full_id
    assert len(key) <= 255


def test_short_topic_key_is_unchanged(sent):
    b = _billing()
    c = _PahoLike()
    wrap_paho_client(b, c, customer_id="cust_001")
    c.publish("devices/001/temp", "x")
    b.shutdown()
    (event,) = _events(sent)
    assert event["mqttTopic"] == "devices/001/temp"
    assert event["idempotencyKey"].startswith("mqtt:tenant-001:dev-1:PUBLISH:devices/001/temp:")
    assert _fit_idempotency_key(["mqtt", "t", "c", "PUBLISH", "a/b", 5, "n"], (4, 2)) == "mqtt:t:c:PUBLISH:a/b:5:n"


def test_key_hashes_topic_then_client_id_then_whole_key():
    topic, cid = "t" * 400, "c" * 300
    key = _fit_idempotency_key(["mqtt", "tenant", cid, "PUBLISH", topic, 5, "n"], (4, 2))
    assert key == f"mqtt:tenant:{_sha256_hex(cid)}:PUBLISH:{_sha256_hex(topic)}:5:n"
    assert key == _fit_idempotency_key(["mqtt", "tenant", cid, "PUBLISH", topic, 5, "n"], (4, 2))
    huge = ["mqtt", "x" * 300, "c", "PUBLISH", "t", 5, "n"]
    assert _fit_idempotency_key(huge, (4, 2)) == "mqtt:" + _sha256_hex(":".join(str(p) for p in huge))


def test_push_truncates_topic_and_client_id_too(sent, caplog):
    b = _billing()
    with caplog.at_level(logging.WARNING, logger="aforo_mqtt_metering"):
        for tail in ("a", "b"):
            b.push(customer_id="cust_1", topic="t" * 500 + tail, qos=0, retained=False,
                   event_type="PUBLISH", client_id="d" * 128 + tail)
    b.shutdown()
    events = _events(sent)
    assert len(events) == 2 and b.dropped_count == 0
    assert all(e["mqttTopic"] == "t" * 500 and e["mqttClientId"] == "d" * 128 for e in events)
    messages = [r.getMessage() for r in caplog.records if "truncated" in r.getMessage()]
    assert len([m for m in messages if "mqttTopic" in m]) == 1
    assert len([m for m in messages if "mqttClientId" in m]) == 1
    keys = [e["idempotencyKey"].split(":") for e in events]
    assert all(len(e["idempotencyKey"]) <= 255 for e in events)
    # Topic and client id are both too long for the key: each is in it as the
    # digest of its full value, so the two events do not share those parts.
    assert keys[0][4] == _sha256_hex("t" * 500 + "a") and keys[1][4] == _sha256_hex("t" * 500 + "b")
    assert keys[0][2] == "d" * 128 + "a" and keys[1][2] == "d" * 128 + "b"


def test_customer_id_still_drops_as_invalid(sent):
    drops: list = []
    b = _billing(on_drop=lambda evs, reason: drops.append((evs, reason)))
    b.push(customer_id="c" * 65, topic="t/1", qos=0, retained=False, event_type="PUBLISH", client_id="dev-1")
    c = _PahoLike()
    wrap_paho_client(b, c, customer_id="c" * 65)
    c.publish("t" * 600, "x")
    b.push(customer_id="cust_1", topic="", qos=0, retained=False, event_type="PUBLISH", client_id="dev-1")
    b.shutdown()
    assert sent == [] and b.dropped_count == 3
    assert [reason for _evs, reason in drops] == ["invalid"] * 3
    assert drops[0][0][0]["customerId"] == "c" * 65  # not altered
