"""
Aforo MQTT Billing Client — Python.

Client-mode integration (the broker-mode path for Python is via the
EMQ X Erlang plugin — see aforo-nextgen-docker/emqx-plugin-aforo-metering).

Wraps the two dominant Python MQTT clients:
  - paho-mqtt   (synchronous callback-based)
  - aiomqtt     (async context manager)

Emits events for PUBLISH / CONNECT / DISCONNECT by default. DELIVER
events (one per received message) are off unless emit_deliver_events=True.
"""

from __future__ import annotations

import atexit
import json
import logging
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

try:
    import httpx  # type: ignore
    HAS_HTTPX = True
except ImportError:  # pragma: no cover
    HAS_HTTPX = False

__version__ = "1.0.0"
logger = logging.getLogger("aforo_mqtt_metering")


@dataclass
class MqttUsageEvent:
    customerId: str
    metricName: str
    quantity: float
    occurredAt: str
    idempotencyKey: str
    productType: str
    mqttTopic: str
    mqttQos: int
    mqttRetained: bool
    mqttEventType: str  # PUBLISH | DELIVER | SUBSCRIBE | UNSUBSCRIBE | CONNECT | DISCONNECT
    mqttClientId: str
    dataBytes: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)


class AforoMqttBilling:
    def __init__(
        self,
        tenant_id: str,
        product_id: str,
        api_key: str,
        ingestor_url: str,
        flush_interval_sec: float = 2.0,
        flush_count: int = 200,
        emit_deliver_events: bool = False,
        on_error: Optional[Callable[[Exception], None]] = None,
    ):
        if not all([tenant_id, product_id, api_key, ingestor_url]):
            raise ValueError("tenant_id, product_id, api_key and ingestor_url are required")

        self.tenant_id = tenant_id
        self.product_id = product_id
        self.api_key = api_key
        self.ingestor_url = ingestor_url.rstrip("/")
        self.flush_interval_sec = flush_interval_sec
        self.flush_count = flush_count
        self.emit_deliver_events = emit_deliver_events
        self.on_error = on_error or (lambda e: logger.error(f"[aforo-mqtt] {e}"))

        self._buffer: List[Dict[str, Any]] = []
        self._buffer_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._flush_thread = threading.Thread(target=self._flush_loop, daemon=True, name="aforo-mqtt-flush")
        self._flush_thread.start()

        # Safety net for normal interpreter exit. The flush thread is a
        # daemon (so it won't block process exit), which historically meant
        # any in-flight events at exit were dropped unless the user
        # explicitly called shutdown(). atexit covers the common case
        # where the user forgets — does NOT cover SIGKILL or os._exit().
        atexit.register(self._safe_shutdown)

    def _safe_shutdown(self) -> None:
        """atexit-safe wrapper around shutdown()."""
        try:
            if not self._stop_event.is_set():
                self.shutdown()
        except Exception:
            pass

    def push(
        self,
        *,
        customer_id: str,
        topic: str,
        qos: int,
        retained: bool,
        event_type: str,
        client_id: str,
        data_bytes: int = 0,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        if event_type == "DELIVER" and not self.emit_deliver_events:
            return
        now = datetime.now(timezone.utc)
        ev = MqttUsageEvent(
            customerId=customer_id,
            metricName=f"mqtt_broker.{event_type.lower()}",
            quantity=1,
            occurredAt=now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            idempotencyKey=f"mqtt:{self.tenant_id}:{client_id}:{event_type}:{topic}:{int(now.timestamp() * 1000)}:{uuid.uuid4().hex[:8]}",
            productType="MQTT_BROKER",
            mqttTopic=topic,
            mqttQos=qos,
            mqttRetained=retained,
            mqttEventType=event_type,
            mqttClientId=client_id,
            dataBytes=data_bytes,
            metadata={
                **(metadata or {}),
                "sdkVersion": __version__,
                "productId": self.product_id,
            },
        )
        with self._buffer_lock:
            self._buffer.append(asdict(ev))
            if len(self._buffer) >= self.flush_count:
                threading.Thread(target=self._flush, daemon=True).start()

    def _flush_loop(self) -> None:
        while not self._stop_event.wait(self.flush_interval_sec):
            self._flush()

    def _flush(self) -> None:
        with self._buffer_lock:
            if not self._buffer:
                return
            batch = self._buffer
            self._buffer = []

        body = {"events": batch}
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "X-Tenant-Id": self.tenant_id,
        }
        url = f"{self.ingestor_url}/v1/ingest/events"

        for attempt in range(3):
            try:
                if HAS_HTTPX:
                    with httpx.Client(timeout=10.0) as c:
                        r = c.post(url, json=body, headers=headers)
                        if 200 <= r.status_code < 300:
                            return
                else:
                    import urllib.request
                    req = urllib.request.Request(
                        url, data=json.dumps(body).encode("utf-8"),
                        headers=headers, method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=10.0) as resp:
                        if 200 <= resp.status < 300:
                            return
            except Exception as e:
                if attempt == 2:
                    self.on_error(e)
                    return
            time.sleep(2 ** attempt)
        self.on_error(RuntimeError(f"MQTT metering flush failed after 3 attempts (dropped {len(batch)} events)"))

    def shutdown(self) -> None:
        self._stop_event.set()
        self._flush()
        if self._flush_thread.is_alive():
            self._flush_thread.join(timeout=5.0)


# ── paho-mqtt (synchronous) integration ──────────────────────────

def wrap_paho_client(
    billing: AforoMqttBilling,
    client: Any,
    *,
    customer_id: str,
    client_id: Optional[str] = None,
) -> None:
    """
    Attach metering callbacks to a paho-mqtt client *before* calling .connect().

    Usage:
        import paho.mqtt.client as mqtt
        from aforo_mqtt_metering import AforoMqttBilling, wrap_paho_client

        billing = AforoMqttBilling(...)
        c = mqtt.Client(client_id="device-001")
        wrap_paho_client(billing, c, customer_id="cust_acme_001")
        c.connect("broker.example.com", 1883)
        c.publish("devices/001/temp", "23.4")
        c.loop_forever()
    """
    cid = client_id or getattr(client, "_client_id", None)
    if isinstance(cid, bytes):
        cid = cid.decode("utf-8")
    cid = cid or "paho-client"

    orig_on_connect = getattr(client, "on_connect", None)
    orig_on_disconnect = getattr(client, "on_disconnect", None)
    orig_on_message = getattr(client, "on_message", None)
    orig_publish = client.publish
    orig_subscribe = client.subscribe
    orig_unsubscribe = client.unsubscribe

    def _on_connect(c, userdata, flags, rc, *args, **kwargs):  # type: ignore[no-untyped-def]
        billing.push(customer_id=customer_id, topic="", qos=0, retained=False,
                     event_type="CONNECT", client_id=cid)
        if orig_on_connect:
            return orig_on_connect(c, userdata, flags, rc, *args, **kwargs)

    def _on_disconnect(c, userdata, rc, *args, **kwargs):  # type: ignore[no-untyped-def]
        billing.push(customer_id=customer_id, topic="", qos=0, retained=False,
                     event_type="DISCONNECT", client_id=cid)
        if orig_on_disconnect:
            return orig_on_disconnect(c, userdata, rc, *args, **kwargs)

    def _on_message(c, userdata, msg):  # type: ignore[no-untyped-def]
        billing.push(
            customer_id=customer_id,
            topic=msg.topic,
            qos=getattr(msg, "qos", 0),
            retained=getattr(msg, "retain", False),
            event_type="DELIVER",
            client_id=cid,
            data_bytes=len(msg.payload) if msg.payload else 0,
        )
        if orig_on_message:
            return orig_on_message(c, userdata, msg)

    client.on_connect = _on_connect
    client.on_disconnect = _on_disconnect
    client.on_message = _on_message

    def _publish(topic, payload=None, qos=0, retain=False, **kwargs):  # type: ignore[no-untyped-def]
        billing.push(
            customer_id=customer_id,
            topic=topic,
            qos=qos,
            retained=retain,
            event_type="PUBLISH",
            client_id=cid,
            data_bytes=_payload_bytes(payload),
        )
        return orig_publish(topic, payload=payload, qos=qos, retain=retain, **kwargs)

    def _subscribe(topic, qos=0, *args, **kwargs):  # type: ignore[no-untyped-def]
        # Paho accepts str or [(str, qos)] — normalize
        topics = [topic] if isinstance(topic, str) else [t[0] if isinstance(t, tuple) else t for t in topic]
        for t in topics:
            billing.push(customer_id=customer_id, topic=t, qos=qos, retained=False,
                         event_type="SUBSCRIBE", client_id=cid)
        return orig_subscribe(topic, qos, *args, **kwargs)

    def _unsubscribe(topic, *args, **kwargs):  # type: ignore[no-untyped-def]
        topics = [topic] if isinstance(topic, str) else list(topic)
        for t in topics:
            billing.push(customer_id=customer_id, topic=t, qos=0, retained=False,
                         event_type="UNSUBSCRIBE", client_id=cid)
        return orig_unsubscribe(topic, *args, **kwargs)

    client.publish = _publish
    client.subscribe = _subscribe
    client.unsubscribe = _unsubscribe


# ── aiomqtt (async) integration ──────────────────────────────────

def wrap_aiomqtt_client(
    billing: AforoMqttBilling,
    client: Any,
    *,
    customer_id: str,
    client_id: Optional[str] = None,
) -> None:
    """
    Wrap an aiomqtt.Client's publish/subscribe methods + CONNECT/DISCONNECT
    markers. Call before entering the client's async context.

    Usage:
        async with aiomqtt.Client("broker.example.com") as c:
            wrap_aiomqtt_client(billing, c, customer_id="cust_acme_001")
            await c.publish("devices/001", "hello")
            async for msg in c.messages:
                ...
    """
    cid = client_id or getattr(client, "_client_id", None) or "aiomqtt-client"
    if isinstance(cid, bytes):
        cid = cid.decode("utf-8")

    # CONNECT marker (best-effort — aiomqtt doesn't expose an on_connect callback)
    billing.push(customer_id=customer_id, topic="", qos=0, retained=False,
                 event_type="CONNECT", client_id=cid)

    orig_publish = client.publish
    orig_subscribe = client.subscribe
    orig_unsubscribe = client.unsubscribe

    async def _publish(topic, payload=None, qos=0, retain=False, **kwargs):  # type: ignore[no-untyped-def]
        billing.push(
            customer_id=customer_id,
            topic=topic, qos=qos, retained=retain,
            event_type="PUBLISH", client_id=cid,
            data_bytes=_payload_bytes(payload),
        )
        return await orig_publish(topic, payload=payload, qos=qos, retain=retain, **kwargs)

    async def _subscribe(topic, qos=0, *args, **kwargs):  # type: ignore[no-untyped-def]
        topics = [topic] if isinstance(topic, str) else list(topic)
        for t in topics:
            billing.push(customer_id=customer_id, topic=str(t), qos=qos, retained=False,
                         event_type="SUBSCRIBE", client_id=cid)
        return await orig_subscribe(topic, qos, *args, **kwargs)

    async def _unsubscribe(topic, *args, **kwargs):  # type: ignore[no-untyped-def]
        topics = [topic] if isinstance(topic, str) else list(topic)
        for t in topics:
            billing.push(customer_id=customer_id, topic=str(t), qos=0, retained=False,
                         event_type="UNSUBSCRIBE", client_id=cid)
        return await orig_unsubscribe(topic, *args, **kwargs)

    client.publish = _publish
    client.subscribe = _subscribe
    client.unsubscribe = _unsubscribe


def _payload_bytes(payload: Any) -> int:
    if payload is None:
        return 0
    if isinstance(payload, (bytes, bytearray)):
        return len(payload)
    if isinstance(payload, str):
        return len(payload.encode("utf-8"))
    try:
        return len(payload)
    except TypeError:
        return 0
