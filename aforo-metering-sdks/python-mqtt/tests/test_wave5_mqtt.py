"""G265 (customer identity) and G288 (reconnect flaps, PUBLISH after success)."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from fakes import ScriptedServer
from mock_ingestor import wait_until
from aforo_mqtt_metering import AforoMqttBilling, wrap_aiomqtt_client, wrap_paho_client

pytestmark = pytest.mark.real_transport


def _billing(server=None, drops=None):
    server = server or ScriptedServer()
    return AforoMqttBilling(tenant_id="t", product_id="p", api_key="k", ingestor_url="https://ingest.example.test",
                            flush_interval_sec=3600, http_transport=server.transport(),
                            on_drop=(lambda events, reason: drops.append(reason)) if drops is not None else None)


def _types(server):
    return [e["mqttEventType"] for r in server.requests for e in r["body"]["events"]]


class _Info:
    def __init__(self, mid, rc=0):
        self.mid, self.rc = mid, rc


class _Paho:
    """paho-like client: publish returns MQTTMessageInfo-style objects."""

    def __init__(self, username=None, ack_inline=False, rc=0):
        self._client_id = b"dev-1"
        self._username = username
        self.next_mid = 0
        self.ack_inline = ack_inline
        self.rc = rc

    def publish(self, topic, payload=None, qos=0, retain=False, **kw):
        self.next_mid += 1
        if self.ack_inline and self.rc == 0:
            self.on_publish(self, None, self.next_mid)  # loop thread acked before publish() returned
        return _Info(self.next_mid, self.rc)

    def subscribe(self, topic, qos=0, *a, **kw):
        return (0, 1)

    def unsubscribe(self, topic, *a, **kw):
        return (0, 1)


def test_wrapping_without_a_customer_source_raises():
    b = _billing()
    try:
        with pytest.raises(ValueError, match="customer_resolver"):
            wrap_paho_client(b, _Paho())
        with pytest.raises(ValueError, match="trust_customer_header"):
            wrap_aiomqtt_client(b, SimpleNamespace(publish=None, subscribe=None, unsubscribe=None))
    finally:
        b.shutdown(timeout=0)


def test_resolver_or_trusted_username_supplies_the_customer():
    server = ScriptedServer()
    b = _billing(server)
    resolved, trusted = _Paho(username="spoofed"), _Paho(username=b"user-7")
    wrap_paho_client(b, resolved, customer_resolver=lambda client: "cust_verified")
    wrap_paho_client(b, trusted, trust_customer_header=True)
    resolved.on_connect(resolved, None, {}, 0)
    trusted.on_connect(trusted, None, {}, 0)
    b.shutdown()
    customers = [e["customerId"] for r in server.requests for e in r["body"]["events"]]
    assert customers == ["cust_verified", "user-7"]


def test_no_customer_drops_the_event_as_invalid_without_blocking_mqtt():
    drops = []
    b = _billing(drops=drops)
    c = _Paho()
    wrap_paho_client(b, c, customer_resolver=lambda client: None)
    info = c.publish("t", "x")
    c.on_publish(c, None, info.mid)
    assert isinstance(info, _Info)
    b.shutdown()
    assert drops == ["invalid"]


def test_publish_is_billed_only_after_paho_confirms_it():
    server = ScriptedServer()
    b = _billing(server)
    c = _Paho()
    wrap_paho_client(b, c, customer_id="cust_1")
    info = c.publish("t", "x", qos=1)
    b.flush()
    assert _types(server) == []  # not acked yet
    c.on_publish(c, None, info.mid)
    b.flush()
    assert _types(server) == ["PUBLISH"]
    b.shutdown()


def test_publish_acked_before_publish_returns_is_billed_once():
    server = ScriptedServer()
    b = _billing(server)
    c = _Paho(ack_inline=True)
    wrap_paho_client(b, c, customer_id="cust_1")
    c.publish("t", "x")
    b.shutdown()
    assert _types(server) == ["PUBLISH"]


def test_publish_paho_refuses_is_not_billed():
    server = ScriptedServer()
    b = _billing(server)
    c = _Paho(rc=4)  # MQTT_ERR_NO_CONN
    wrap_paho_client(b, c, customer_id="cust_1")
    c.publish("t", "x")
    b.shutdown()
    assert _types(server) == []


def test_reconnect_flap_bills_one_session():
    server = ScriptedServer()
    b = _billing(server)
    c = _Paho()
    wrap_paho_client(b, c, customer_id="cust_1", reconnect_debounce_sec=30)
    c.on_connect(c, None, {}, 0)
    for _ in range(5):  # network flaps: dropped (rc 7) then reconnected
        c.on_disconnect(c, None, 7)
        c.on_connect(c, None, {}, 0)
    c.on_disconnect(c, None, 0)  # we disconnect
    b.shutdown()
    assert _types(server) == ["CONNECT", "DISCONNECT"]


def test_dropped_connection_that_stays_down_bills_disconnect_after_the_debounce():
    server = ScriptedServer()
    b = _billing(server)
    c = _Paho()
    wrap_paho_client(b, c, customer_id="cust_1", reconnect_debounce_sec=0.05)
    c.on_connect(c, None, {}, 0)
    c.on_disconnect(c, None, 7)
    wait_until(lambda: b.queued_count == 2)
    b.shutdown()
    assert _types(server) == ["CONNECT", "DISCONNECT"]


def test_refused_connack_and_paho_v2_disconnect_signature():
    server = ScriptedServer()
    b = _billing(server)
    c = _Paho()
    wrap_paho_client(b, c, customer_id="cust_1")
    c.on_connect(c, None, {}, 5)  # not authorised: nothing billed
    c.on_connect(c, None, {}, 0)
    flags = SimpleNamespace(is_disconnect_packet_from_server=False)
    c.on_disconnect(c, None, flags, 0, None)  # paho 2.x signature, clean
    b.shutdown()
    assert _types(server) == ["CONNECT", "DISCONNECT"]


def test_aiomqtt_publish_that_raises_is_not_billed():
    server = ScriptedServer()
    b = _billing(server)

    class _Aio:
        _client_id = "aio-1"

        async def publish(self, topic, payload=None, qos=0, retain=False, **kw):
            if topic == "bad":
                raise RuntimeError("not acked")

        async def subscribe(self, topic, qos=0, *a, **kw):
            return None

        async def unsubscribe(self, topic, *a, **kw):
            return None

    c = _Aio()
    wrap_aiomqtt_client(b, c, customer_id="cust_1")

    async def go():
        await c.publish("good", "x", qos=1)
        with pytest.raises(RuntimeError):
            await c.publish("bad", "x", qos=1)

    asyncio.run(go())
    b.shutdown()
    assert _types(server) == ["CONNECT", "PUBLISH"]
