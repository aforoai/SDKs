"""End-to-end test finding (2026-11-09): an app that set ``on_connect`` /
``on_publish`` after ``wrap_paho_client`` (normal paho style) replaced the
metering hooks, so CONNECT, PUBLISH and DISCONNECT were silently not metered
(0 rows, ``dropped_count`` 0). The hooks must stay in place and call the app's
callback, whenever it was set, on paho 1.x and 2.x callback APIs."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from fakes import ScriptedServer
from aforo_mqtt_metering import AforoMqttBilling, wrap_aiomqtt_client, wrap_paho_client

pytestmark = pytest.mark.real_transport

mqtt = pytest.importorskip("paho.mqtt.client")


def _billing(server, **kw):
    return AforoMqttBilling(tenant_id="t", product_id="p", api_key="k", ingestor_url="https://ingest.example.test",
                            flush_interval_sec=3600, http_transport=server.transport(), **kw)


def _types(server):
    return [e["mqttEventType"] for r in server.requests for e in r["body"]["events"]]


class _Info:
    def __init__(self, mid, rc=0):
        self.mid, self.rc = mid, rc


class _PahoWithProperties:
    """Callbacks behind properties and read through them, as paho 1.x/2.x do."""

    def __init__(self):
        self._client_id = b"dev-prop"
        self._on_connect = self._on_disconnect = self._on_message = self._on_publish = None
        self.next_mid = 0

    on_connect = property(lambda s: s._on_connect, lambda s, f: setattr(s, "_on_connect", f))
    on_disconnect = property(lambda s: s._on_disconnect, lambda s, f: setattr(s, "_on_disconnect", f))
    on_message = property(lambda s: s._on_message, lambda s, f: setattr(s, "_on_message", f))
    on_publish = property(lambda s: s._on_publish, lambda s, f: setattr(s, "_on_publish", f))

    # what paho's network loop does
    def connack(self, rc=0):
        cb = self.on_connect
        if cb:
            cb(self, None, {}, rc)

    def ack(self, mid):
        cb = self.on_publish
        if cb:
            cb(self, None, mid)

    def deliver(self, topic, payload=b"x"):
        cb = self.on_message
        if cb:
            cb(self, None, SimpleNamespace(topic=topic, payload=payload, qos=1, retain=False))

    def closed(self, rc=0):
        cb = self.on_disconnect
        if cb:
            cb(self, None, rc)

    def publish(self, topic, payload=None, qos=0, retain=False, **kw):
        self.next_mid += 1
        return _Info(self.next_mid)

    def subscribe(self, topic, qos=0, *a, **kw):
        return (0, 1)

    def unsubscribe(self, topic, *a, **kw):
        return (0, 1)


@pytest.mark.parametrize("set_before", [False, True], ids=["callbacks-set-after-wrap", "callbacks-set-before-wrap"])
def test_callbacks_set_after_wrapping_keep_metering_and_are_called(set_before):
    server = ScriptedServer()
    b = _billing(server, emit_deliver_events=True)
    c = _PahoWithProperties()
    seen = []

    def set_app_callbacks():
        c.on_connect = lambda *a: seen.append("connect")
        c.on_publish = lambda *a: seen.append("publish")
        c.on_message = lambda *a: seen.append("message")
        c.on_disconnect = lambda *a: seen.append("disconnect")

    if set_before:
        set_app_callbacks()
    wrap_paho_client(b, c, customer_id="cust_1")
    if not set_before:
        set_app_callbacks()

    c.connack()
    for _ in range(3):
        c.ack(c.publish("devices/1", b"v", qos=1).mid)
    c.deliver("devices/1")
    c.closed()
    b.shutdown()

    assert _types(server) == ["CONNECT", "PUBLISH", "PUBLISH", "PUBLISH", "DELIVER", "DISCONNECT"]
    assert seen == ["connect", "publish", "publish", "publish", "message", "disconnect"]
    assert b.dropped_count == 0


def test_app_can_replace_or_clear_a_callback_later():
    server = ScriptedServer()
    b = _billing(server)
    c = _PahoWithProperties()
    wrap_paho_client(b, c, customer_id="cust_1")
    first, second = [], []
    c.on_publish = lambda *a: first.append(a[2])
    c.ack(c.publish("t", "1").mid)
    c.on_publish = lambda *a: second.append(a[2])
    c.ack(c.publish("t", "2").mid)
    c.on_publish = None
    c.ack(c.publish("t", "3").mid)
    b.shutdown()
    assert _types(server) == ["PUBLISH", "PUBLISH", "PUBLISH"]
    assert first == [1] and second == [2]


def test_plain_attribute_client_is_also_covered():
    """A paho-like object with plain attributes (no properties)."""

    class _Plain:
        _client_id = "plain"

        def publish(self, topic, payload=None, qos=0, retain=False, **kw):
            return _Info(1)

        def subscribe(self, *a, **kw):
            return (0, 1)

        def unsubscribe(self, *a, **kw):
            return (0, 1)

    server = ScriptedServer()
    b = _billing(server)
    c = _Plain()
    wrap_paho_client(b, c, customer_id="cust_1")
    seen = []
    c.on_connect = lambda *a: seen.append("connect")
    c.on_connect(c, None, {}, 0)
    b.shutdown()
    assert _types(server) == ["CONNECT"] and seen == ["connect"]
    assert isinstance(c, _Plain)


@pytest.mark.parametrize("api", ["VERSION1", "VERSION2"])
def test_real_paho_client_keeps_hooks_when_callbacks_are_assigned_after_wrap(api):
    if not hasattr(mqtt, "CallbackAPIVersion"):
        if api == "VERSION2":
            pytest.skip("paho 1.x has no callback API v2")
        client = mqtt.Client(client_id="dev-real")
    else:
        client = mqtt.Client(getattr(mqtt.CallbackAPIVersion, api), client_id="dev-real")
    server = ScriptedServer()
    b = _billing(server, emit_deliver_events=True)
    wrap_paho_client(b, client, customer_id="cust_1")
    seen = []
    client.on_connect = lambda *a: seen.append(("connect", len(a)))
    client.on_publish = lambda *a: seen.append(("publish", len(a)))
    client.on_disconnect = lambda *a: seen.append(("disconnect", len(a)))
    client.on_message = lambda *a: seen.append(("message", len(a)))

    assert isinstance(client, mqtt.Client)
    for name in ("on_connect", "on_publish", "on_disconnect", "on_message"):
        assert getattr(client, name).__name__ == "_" + name, name  # paho reads the metering hook

    # paho's own dispatch of an inbound message (same internal in 1.x and 2.x)
    msg = mqtt.MQTTMessage(mid=1, topic=b"devices/1")
    msg.payload = b"22.5"
    client._handle_on_message(msg)

    # what paho passes to each callback, per callback API
    if api == "VERSION2":
        rc = mqtt.ReasonCode(mqtt.PacketTypes.CONNACK, "Success")
        client.on_connect(client, None, mqtt.ConnectFlags(False), rc, None)
        client.on_publish(client, None, 7, mqtt.ReasonCode(mqtt.PacketTypes.PUBACK, "Success"), None)
        client.on_disconnect(client, None, mqtt.DisconnectFlags(False),
                             mqtt.ReasonCode(mqtt.PacketTypes.DISCONNECT, "Normal disconnection"), None)
    else:
        client.on_connect(client, None, {}, 0)
        client.on_publish(client, None, 7)
        client.on_disconnect(client, None, 0)
    b.shutdown()

    # PUBLISH is billed only for a publish the wrapper saw; mid 7 was never published
    assert _types(server) == ["DELIVER", "CONNECT", "DISCONNECT"]
    assert [s[0] for s in seen] == ["message", "connect", "publish", "disconnect"]


def test_unswappable_client_falls_back_to_plain_attributes():
    server = ScriptedServer()
    b = _billing(server)
    c = SimpleNamespace(publish=lambda *a, **k: _Info(1), subscribe=lambda *a, **k: (0, 1),
                        unsubscribe=lambda *a, **k: (0, 1), _client_id="ns")
    wrap_paho_client(b, c, customer_id="cust_1")
    c.on_connect(c, None, {}, 0)
    b.shutdown()
    assert _types(server) == ["CONNECT"]


def test_aiomqtt_wrapper_hooks_no_callbacks():
    """aiomqtt has no user-assignable callbacks; the wrapper replaces methods only."""

    class _Aio:
        _client_id = "aio-1"

        async def publish(self, topic, payload=None, qos=0, retain=False, **kw):
            return None

        async def subscribe(self, topic, qos=0, *a, **kw):
            return None

        async def unsubscribe(self, topic, *a, **kw):
            return None

    import asyncio

    server = ScriptedServer()
    b = _billing(server)
    c = _Aio()
    wrap_aiomqtt_client(b, c, customer_id="cust_1")
    asyncio.run(c.publish("t", "x", qos=1))
    b.shutdown()
    assert _types(server) == ["CONNECT", "PUBLISH"]
    assert type(c) is _Aio
