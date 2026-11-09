"""Regression tests for the 2026-11-09 review (python-mqtt).

* A QoS 1/2 publish made while disconnected (paho answers MQTT_ERR_NO_CONN,
  keeps the message and sends it on reconnect) is billed when the broker acks
  it (finding 6). A QoS 0 publish refused that way is still not billed.
* push() with a non-dict metadata is dropped as invalid instead of raising.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from fakes import ScriptedServer
from aforo_mqtt_metering import AforoMqttBilling, wrap_paho_client

pytestmark = pytest.mark.real_transport

MQTT_ERR_NO_CONN = 4


class _PahoLike:
    """Enough of paho's Client: publish() returns an info with mid and rc;
    the test fires on_publish as paho's network loop would on the ack."""

    def __init__(self):
        self._client_id = b"device-001"
        self.on_connect = self.on_disconnect = self.on_message = self.on_publish = None
        self.mid = 0
        self.connected = False

    def publish(self, topic, payload=None, qos=0, retain=False, **kwargs):
        self.mid += 1
        rc = 0 if self.connected else MQTT_ERR_NO_CONN
        return SimpleNamespace(mid=self.mid, rc=rc)

    def subscribe(self, topic, qos=0, *args, **kwargs):
        return (0, 1)

    def unsubscribe(self, topic, *args, **kwargs):
        return (0, 1)


def _billing():
    return AforoMqttBilling("t", "p", "k", "https://ingest.example.test", flush_interval_sec=3600,
                            http_transport=ScriptedServer().transport())


def _publishes(billing):
    return [e for e in billing._core.queued_items() if e["mqttEventType"] == "PUBLISH"]


def test_qos1_publish_made_offline_is_billed_when_the_broker_acks_it():
    billing = _billing()
    client = _PahoLike()
    wrap_paho_client(billing, client, customer_id="cust_1")
    info = client.publish("devices/001/temp", "23.4", qos=1)
    assert info.rc == MQTT_ERR_NO_CONN and _publishes(billing) == []
    client.on_publish(client, None, info.mid, 0, None)        # PUBACK after reconnect
    (ev,) = _publishes(billing)
    assert (ev["mqttTopic"], ev["mqttQos"], ev["dataBytes"]) == ("devices/001/temp", 1, 4)
    billing.shutdown(timeout=0)


def test_qos0_publish_refused_offline_is_not_billed():
    billing = _billing()
    client = _PahoLike()
    wrap_paho_client(billing, client, customer_id="cust_1")
    info = client.publish("devices/001/temp", "23.4", qos=0)
    client.on_publish(client, None, info.mid, 0, None)
    assert _publishes(billing) == []
    billing.shutdown(timeout=0)


def test_push_with_non_dict_metadata_is_invalid_not_raised():
    drops = []
    billing = _billing()
    billing.on_drop = lambda ev, r: drops.append(r)
    billing.push(customer_id="c", topic="t/1", qos=0, retained=False, event_type="PUBLISH",
                 client_id="d", metadata=["x"])
    assert drops == ["invalid"] and billing.queued_count == 0
    billing.shutdown(timeout=0)
