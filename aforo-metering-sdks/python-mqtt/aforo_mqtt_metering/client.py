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

import hashlib
import logging
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

from ._transport import (
    TransportCore,
    clean_customer_id,
    require_customer_source,
    truncate_utf16,
    utf16_length,
)
from ._transport import policy as _policy

__version__ = "2.1.0"
logger = logging.getLogger("aforo_mqtt_metering")

# POST /v1/ingest/batch takes 1..1000 events per request.
MAX_BATCH_EVENTS = 1000
MAX_CUSTOMER_ID_LEN = 64
MAX_IDEMPOTENCY_KEY_LEN = 255
MAX_MQTT_TOPIC_LEN = 500
MAX_MQTT_CLIENT_ID_LEN = 128


# ── Request-derived labels ───────────────────────────────────────
# A label the SDK copies from the incoming request / message is cut to the
# ingestor's limit and the event is still sent: dropping it would let an API
# consumer avoid metering by sending an over-long name. Fields the SDK caller
# sets are never altered. The ingestor counts Java String.length(), i.e. UTF-16
# code units, so a character outside the BMP counts as 2.

_truncation_lock = threading.Lock()


_utf16_length = utf16_length
_truncate_utf16 = truncate_utf16


def _truncate_label(field_name: str, value: Any, limit: int, warned: set) -> Any:
    """Cut a request-derived label to ``limit``; one WARNING per field name per
    ``warned`` set (one set per client). Non-strings pass through."""
    if not isinstance(value, str):
        return value
    cut = _truncate_utf16(value, limit)
    if len(cut) == len(value):
        return value
    with _truncation_lock:
        first = field_name not in warned
        warned.add(field_name)
    if first:
        logger.warning(
            "[aforo-mqtt] %s taken from the request was longer than the ingestor's limit and was "
            "truncated to %d characters; the event is still sent. Logged once per field.",
            field_name, limit,
        )
    return cut


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


def _fit_idempotency_key(parts: List[Any], request_derived: Tuple[int, ...]) -> str:
    """Join ``parts`` with ":" into an idempotency key of at most 255 chars.

    A key that fits is returned unchanged. Otherwise the request-derived
    components (indexes in ``request_derived``, in that order) are replaced one
    at a time by the SHA-256 hex digest of their full text until the key fits;
    if it still does not, everything after the prefix becomes the digest of the
    whole key. Nothing is cut off, so two different inputs never share a key
    and the same input always gives the same key.
    """
    parts = [str(p) for p in parts]
    full = ":".join(parts)
    if _utf16_length(full) <= MAX_IDEMPOTENCY_KEY_LEN:
        return full
    for index in request_derived:
        parts[index] = _sha256_hex(parts[index])
        key = ":".join(parts)
        if _utf16_length(key) <= MAX_IDEMPOTENCY_KEY_LEN:
            return key
    return f"{parts[0]}:{_sha256_hex(full)}"


def _clip(value: Any) -> str:
    text = repr(value)
    return text if len(text) <= 80 else text[:77] + "..."


def _customer_id_problem(customer_id: Any) -> Optional[str]:
    """Why the ingestor would refuse this customerId, or None when it is usable."""
    if not isinstance(customer_id, str) or not customer_id.strip():
        return f"customerId is required (got {_clip(customer_id)})"
    if utf16_length(customer_id) > MAX_CUSTOMER_ID_LEN:
        return f"customerId exceeds {MAX_CUSTOMER_ID_LEN} chars (got {_clip(customer_id)})"
    return None


DEFAULT_PRODUCT_TYPE = "MQTT_BROKER"
def _normalize_product_type(product_type: Any, default: str) -> str:
    """Trim + uppercase. Unknown values pass through; the ingestor is the authority."""
    value = str(product_type).strip().upper() if product_type is not None else ""
    return value or default


MQTT_EVENT_TYPES = ("PUBLISH", "DELIVER", "SUBSCRIBE", "UNSUBSCRIBE", "CONNECT", "DISCONNECT")


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
    executionStatus: Optional[str] = None
    """Normalized (trimmed, upper-cased) outcome; left off the wire when None."""

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        if d.get("executionStatus") is None:
            d.pop("executionStatus", None)
        return d


# Canonical execution statuses accepted by the usage-ingestor (mirrors
# contract/ingest-contract.json ``executionStatus.values``; maxLength 20).
EXECUTION_STATUSES = frozenset({
    "SUCCESS", "PARTIAL", "TIMEOUT", "ERROR", "VALIDATION_FAILED", "FAILED",
    "FAILURE", "CANCELLED", "PENDING", "BLOCKED", "HITL_REQUIRED",
})


def normalize_execution_status(value: Optional[str]) -> Optional[str]:
    """Trim + upper-case an execution status; blank or non-string -> None.

    A value outside the canonical set (see ``EXECUTION_STATUSES``) is logged
    and dropped (None): the ingestor rejects an unknown status with a 400 for
    that event, so its usage would be lost.
    """
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    normalized = trimmed.upper()
    if normalized not in EXECUTION_STATUSES:
        logger.warning(
            "Ignoring unknown executionStatus %r; expected one of %s",
            value[:40], ", ".join(sorted(EXECUTION_STATUSES)),
        )
        return None
    return normalized


class AforoMqttBilling:
    """MQTT metering client: one bounded queue and one sender thread.

    ``push()`` only queues. One background thread sends batches every
    ``flush_interval_sec`` seconds or as soon as ``flush_count`` events are
    queued. During an ingest outage batches stay queued with the same
    idempotency keys and are retried after a pause. An event is lost only on
    queue overflow, a rejection by the ingestor, invalid input, the shutdown
    deadline, or ``push()`` after ``shutdown()`` -- each counted in
    ``dropped_count`` and passed to ``on_drop``. ``ingestor_url`` must be
    ``https://`` (plain ``http://`` only for localhost, or with
    ``allow_insecure_http=True``). ``shutdown()`` also runs at interpreter exit.
    """

    def __init__(
        self,
        tenant_id: str,
        product_id: str,
        api_key: str,
        ingestor_url: str,
        flush_interval_sec: float = 2.0,
        flush_count: int = _policy.DEFAULT_FLUSH_COUNT,
        emit_deliver_events: bool = False,
        on_error: Optional[Callable[[Exception], None]] = None,
        on_drop: Optional[Callable[[List[Dict[str, Any]], str], None]] = None,
        product_type: str = DEFAULT_PRODUCT_TYPE,
        *,
        max_queue_size: int = _policy.DEFAULT_QUEUE_CAPACITY,
        timeout_sec: float = _policy.REQUEST_TIMEOUT_S,
        shutdown_timeout_sec: float = _policy.SHUTDOWN_TIMEOUT_S,
        allow_insecure_http: bool = False,
        compression: str = "gzip",
        http_transport: Any = None,
        transport_options: Optional[Dict[str, Any]] = None,
    ):
        if not all([tenant_id, product_id, api_key, ingestor_url]):
            raise ValueError("tenant_id, product_id, api_key and ingestor_url are required")

        self.tenant_id = tenant_id
        self.product_id = product_id
        self.emit_deliver_events = emit_deliver_events
        # Top-level productType on every event; push(product_type=...) overrides per call.
        self.product_type = _normalize_product_type(product_type, DEFAULT_PRODUCT_TYPE)
        self._truncation_warned: set = set()
        self.on_error = on_error or (lambda e: logger.debug("[aforo-mqtt] %s", e))
        self._core = TransportCore(
            api_key=api_key,
            base_url=ingestor_url,
            user_agent=f"aforo-mqtt-metering-python/{__version__}",
            name="aforo-mqtt",
            logger=logger,
            flush_count=flush_count,
            flush_interval=flush_interval_sec,
            max_queue_size=max_queue_size,
            timeout=timeout_sec,
            shutdown_timeout=shutdown_timeout_sec,
            allow_insecure_http=allow_insecure_http,
            compression=compression,
            on_drop=on_drop,
            on_error=self._safe_on_error,
            extra_headers={"X-Tenant-Id": tenant_id},
            http_transport=http_transport,
            **(transport_options or {}),
        )
        self.ingestor_url = self._core.url[: -len(_policy.INGEST_PATH)]
        self.flush_count = self._core.flush_count
        self.flush_interval_sec = flush_interval_sec

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
        execution_status: Optional[str] = None,
        product_type: Optional[str] = None,
    ) -> None:
        """Buffer one MQTT event (all arguments keyword-only).

        Required: ``customer_id`` (non-blank, at most 64 chars), a supported
        ``event_type`` (PUBLISH, DELIVER, SUBSCRIBE, UNSUBSCRIBE, CONNECT,
        DISCONNECT) and a ``topic`` (CONNECT / DISCONNECT may omit it). An event
        that fails those checks is not buffered or sent: it is counted in
        ``dropped_count``, logged at WARNING and handed to ``on_drop`` with
        reason ``"invalid"``. ``push`` does not raise for event content.
        ``product_type`` overrides the client default.

        ``topic`` and ``client_id`` originate from the MQTT traffic. A topic
        longer than 500 characters or a client id longer than 128 is cut to the
        limit and the event is still sent (a WARNING is logged once per field
        per client); the idempotency key is built from the full values.
        ``customer_id`` is never truncated.

        ``execution_status`` is the optional outcome used by OUTCOME_BASED
        pricing. Trimmed and upper-cased; blank counts as unset and the key is
        then left off the event. The client wrappers don't set one (they emit
        before the broker answers), so only values passed here are sent.
        Accepted values: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED,
        FAILED, FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED -- any other value is logged and left off the event.
        """
        event_type = str(event_type or "").upper()
        if event_type == "DELIVER" and not self.emit_deliver_events:
            return
        invalid = _customer_id_problem(customer_id)
        if invalid is None and event_type not in MQTT_EVENT_TYPES:
            invalid = f"mqttEventType must be one of {', '.join(MQTT_EVENT_TYPES)} (got {_clip(event_type)})"
        # Topic and client id originate from the MQTT traffic: an over-long one
        # is cut to the ingestor's limit instead of losing the event. The key
        # below is built from the full values.
        key_client_id = str(client_id) if client_id else "unknown-client"
        client_id = _truncate_label(
            "mqttClientId", key_client_id, MAX_MQTT_CLIENT_ID_LEN, self._truncation_warned)
        if not isinstance(topic, str) or not topic.strip():
            # mqttTopic is required on every MQTT_BROKER event. CONNECT /
            # DISCONNECT have no topic, so they carry a broker-style $SYS marker
            # (same as the Go and Java SDKs); any other topic-less event is invalid.
            if event_type in ("CONNECT", "DISCONNECT"):
                topic = f"$SYS/clients/{client_id}/{event_type.lower()}ed"
            else:
                if invalid is None:
                    invalid = f"mqttTopic is required for {event_type} (got {_clip(topic)})"
                topic = ""
        key_topic = topic
        topic = _truncate_label("mqttTopic", topic, MAX_MQTT_TOPIC_LEN, self._truncation_warned)
        qos = qos if qos in (0, 1, 2) else 0
        now = datetime.now(timezone.utc)
        ev = MqttUsageEvent(
            customerId=customer_id,
            metricName=f"mqtt_broker.{event_type.lower()}",
            quantity=1,
            occurredAt=now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            idempotencyKey=_fit_idempotency_key(
                ["mqtt", self.tenant_id, key_client_id, event_type, key_topic,
                 int(now.timestamp() * 1000), uuid.uuid4().hex[:8]],
                (4, 2),
            ),
            productType=_normalize_product_type(product_type, self.product_type),
            mqttTopic=topic,
            mqttQos=qos,
            mqttRetained=bool(retained),
            mqttEventType=event_type,
            mqttClientId=client_id,
            dataBytes=data_bytes,
            metadata={
                **(metadata or {}),
                "sdkVersion": __version__,
                "productId": self.product_id,
            },
            executionStatus=normalize_execution_status(execution_status),
        )
        if invalid is not None:
            self._core.report_drop([ev.to_dict()], "invalid", detail=invalid)
            return
        self._core.enqueue(ev.to_dict())

    def dropped_count(self) -> int:
        """Total events permanently dropped (failed batches)."""
        with self._drop_lock:
            return self._dropped

    # ── Delivery (shared transport core) ─────────────────────────

    @property
    def on_drop(self) -> Optional[Callable[[List[Dict[str, Any]], str], None]]:
        """``on_drop(events, reason)``: events lost for good. Reasons:
        ``overflow``, ``rejected``, ``invalid``, ``shutdown``, ``closed``."""
        return self._core._on_drop

    @on_drop.setter
    def on_drop(self, hook: Optional[Callable[[List[Dict[str, Any]], str], None]]) -> None:
        self._core._on_drop = hook

    def _safe_on_error(self, exc: Exception) -> None:
        try:
            self.on_error(exc)
        except Exception:
            logger.debug("[aforo-mqtt] on_error hook raised", exc_info=True)

    def __repr__(self) -> str:
        return f"AforoMqttBilling(tenant_id={self.tenant_id!r}, ingestor_url={self.ingestor_url!r})"

    def flush(self, timeout: Optional[float] = None) -> int:
        """Ask the sender thread to send everything queued and wait for it.
        Returns the number of events still queued (non-zero while the
        ingestor is unreachable; they are retried after a pause)."""
        return self._core.flush(timeout).pending

    _flush = flush

    @property
    def dropped_count(self) -> int:
        """Events lost for good: overflow, rejected, invalid, shutdown, closed."""
        return self._core.dropped_count

    @property
    def queued_count(self) -> int:
        return self._core.queue_size

    def report_invalid(self, detail: str) -> None:
        """Count an event an integration could not build (no customer) as ``invalid``."""
        self._core.report_drop([], "invalid", count=1, detail=detail)

    def shutdown(self, timeout: Optional[float] = None) -> None:
        """Stop accepting events and flush for at most ``shutdown_timeout_sec``
        (or ``timeout``) seconds; what is still queued then is reported to
        ``on_drop`` as ``"shutdown"``. Also runs at interpreter exit."""
        self._core.close(timeout)

# ── Customer identity ────────────────────────────────────────────

_UNSET: Any = object()

#: Unconfirmed QoS>0 publishes kept per client while waiting for the broker's
#: ack. A full table drops the oldest entry unmetered (logged at debug).
MAX_PENDING_PUBLISHES = 10_000


def _mqtt_username(client: Any) -> Optional[str]:
    value = getattr(client, "_username", None)
    if value is None:
        value = getattr(client, "username", None)
    if isinstance(value, (bytes, bytearray)):
        value = bytes(value).decode("utf-8", "replace")
    return value if isinstance(value, str) else None


def _customer_source(client: Any, customer_id: Any, customer_resolver: Optional[Callable[[Any], Optional[str]]],
                     trust_customer_header: bool, integration: str) -> Callable[[], Optional[str]]:
    """How the wrapper finds the customer for each event.

    An explicit ``customer_id`` is the value your code resolved from identity
    it verified. Otherwise ``customer_resolver(client)`` is called per event;
    using the MQTT username -- which whoever configures the connection
    controls -- needs ``trust_customer_header=True``. With none of the three
    this raises ValueError. A missing customer drops that event as
    ``invalid`` (counted); MQTT traffic is never blocked.
    """
    if customer_id is not _UNSET:
        fixed = clean_customer_id(customer_id)
        return lambda: fixed
    require_customer_source(customer_resolver, trust_customer_header, integration=integration,
                            untrusted_source="the MQTT username of the connection")
    if customer_resolver is not None:
        def resolve() -> Optional[str]:
            try:
                return clean_customer_id(customer_resolver(client))
            except Exception:
                logger.warning("[aforo-mqtt] customer_resolver raised; the event is not metered", exc_info=True)
                return None
        return resolve
    return lambda: clean_customer_id(_mqtt_username(client))


def _rc_ok(rc: Any) -> bool:
    """True for a successful paho return / reason code (int 0, or a v2
    ReasonCode that is not a failure)."""
    if rc is None:
        return True
    is_failure = getattr(rc, "is_failure", None)
    if isinstance(is_failure, bool):
        return not is_failure
    value = getattr(rc, "value", rc)
    try:
        return int(value) == 0
    except (TypeError, ValueError):
        return False


# ── paho-mqtt (synchronous) integration ──────────────────────────

def wrap_paho_client(
    billing: AforoMqttBilling,
    client: Any,
    *,
    customer_id: Any = _UNSET,
    customer_resolver: Optional[Callable[[Any], Optional[str]]] = None,
    trust_customer_header: bool = False,
    client_id: Optional[str] = None,
    product_type: Optional[str] = None,
    reconnect_debounce_sec: float = 30.0,
) -> None:
    """
    Attach metering callbacks to a paho-mqtt client *before* calling .connect().

    The customer: ``customer_id`` (resolved by your own auth), or
    ``customer_resolver=callable(client) -> str | None``, or
    ``trust_customer_header=True`` to bill the connection's MQTT username.
    With none of them this raises ValueError.

    What is metered:
      - CONNECT when the broker accepts the connection (CONNACK success).
      - DISCONNECT when you disconnect, or ``reconnect_debounce_sec`` after a
        dropped connection that did not come back. A connection that drops
        and reconnects within that window is one session: no new
        CONNECT/DISCONNECT pair is billed for the flap.
      - PUBLISH after paho confirms it (``on_publish``: the broker's ack for
        QoS 1/2, the socket write for QoS 0). A publish paho refuses
        (``rc != 0``) is not billed.
      - SUBSCRIBE / UNSUBSCRIBE when requested; DELIVER per received message
        when ``emit_deliver_events=True``.

    Usage:
        import paho.mqtt.client as mqtt
        from aforo_mqtt_metering import AforoMqttBilling, wrap_paho_client

        billing = AforoMqttBilling(...)
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="device-001")
        wrap_paho_client(billing, c, customer_id=device_registry.owner_of("device-001"))
        c.connect("broker.example.com", 1883)
        c.publish("devices/001/temp", "23.4")
        c.loop_forever()
    """
    customer = _customer_source(client, customer_id, customer_resolver, trust_customer_header,
                                "wrap_paho_client")
    cid = client_id or getattr(client, "_client_id", None)
    if isinstance(cid, bytes):
        cid = cid.decode("utf-8")
    cid = cid or "paho-client"

    orig_on_connect = getattr(client, "on_connect", None)
    orig_on_disconnect = getattr(client, "on_disconnect", None)
    orig_on_message = getattr(client, "on_message", None)
    orig_on_publish = getattr(client, "on_publish", None)
    orig_publish = client.publish
    orig_subscribe = client.subscribe
    orig_unsubscribe = client.unsubscribe

    lock = threading.Lock()
    state: Dict[str, Any] = {"connected": False, "timer": None}
    pending: "Dict[int, Dict[str, Any]]" = {}
    acked_early: "Dict[int, bool]" = {}

    def _push(**fields: Any) -> None:
        billing.push(customer_id=customer(), product_type=product_type, client_id=cid, **fields)

    def _emit_disconnect() -> None:
        with lock:
            state["timer"] = None
            if state["connected"]:
                return  # it reconnected after all
        _push(topic="", qos=0, retained=False, event_type="DISCONNECT")

    def _on_connect(c, userdata, flags, rc, *args, **kwargs):  # type: ignore[no-untyped-def]
        if _rc_ok(rc):
            with lock:
                timer, state["timer"] = state["timer"], None
                flap = timer is not None
                state["connected"] = True
            if timer is not None:
                timer.cancel()
            if not flap:
                _push(topic="", qos=0, retained=False, event_type="CONNECT")
        if orig_on_connect:
            return orig_on_connect(c, userdata, flags, rc, *args, **kwargs)

    def _on_disconnect(c, userdata, *args, **kwargs):  # type: ignore[no-untyped-def]
        # paho 1.x: (client, userdata, rc); 2.x: (client, userdata, flags, rc, properties)
        rc = args[1] if len(args) >= 2 and hasattr(args[0], "is_disconnect_packet_from_server") else (
            args[0] if args else 0)
        with lock:
            was_connected = state["connected"]
            state["connected"] = False
        if was_connected:
            if _rc_ok(rc):
                _push(topic="", qos=0, retained=False, event_type="DISCONNECT")
            else:
                timer = threading.Timer(reconnect_debounce_sec, _emit_disconnect)
                timer.daemon = True
                with lock:
                    previous, state["timer"] = state["timer"], timer
                if previous is not None:
                    previous.cancel()
                timer.start()
        if orig_on_disconnect:
            return orig_on_disconnect(c, userdata, *args, **kwargs)

    def _on_message(c, userdata, msg):  # type: ignore[no-untyped-def]
        _push(
            topic=msg.topic,
            qos=getattr(msg, "qos", 0),
            retained=getattr(msg, "retain", False),
            event_type="DELIVER",
            data_bytes=len(msg.payload) if msg.payload else 0,
        )
        if orig_on_message:
            return orig_on_message(c, userdata, msg)

    def _on_publish(c, userdata, mid, *args, **kwargs):  # type: ignore[no-untyped-def]
        with lock:
            fields = pending.pop(mid, None)
            if fields is None:
                acked_early[mid] = True
                while len(acked_early) > MAX_PENDING_PUBLISHES:
                    acked_early.pop(next(iter(acked_early)))
        reason = args[0] if args else None
        if fields is not None and _rc_ok(reason):
            _push(**fields)
        if orig_on_publish:
            return orig_on_publish(c, userdata, mid, *args, **kwargs)

    client.on_connect = _on_connect
    client.on_disconnect = _on_disconnect
    client.on_message = _on_message
    client.on_publish = _on_publish

    def _publish(topic, payload=None, qos=0, retain=False, **kwargs):  # type: ignore[no-untyped-def]
        fields = {"topic": topic, "qos": qos, "retained": retain, "event_type": "PUBLISH",
                  "data_bytes": _payload_bytes(payload)}
        info = orig_publish(topic, payload=payload, qos=qos, retain=retain, **kwargs)
        mid = getattr(info, "mid", None)
        if mid is None or not hasattr(info, "rc"):
            _push(**fields)  # not paho: the call returned without error
            return info
        if not _rc_ok(info.rc):
            return info  # paho refused it: nothing was published
        with lock:
            if acked_early.pop(mid, False):
                confirmed = True
            else:
                confirmed = False
                pending[mid] = fields
                while len(pending) > MAX_PENDING_PUBLISHES:
                    lost = next(iter(pending))
                    pending.pop(lost)
                    logger.debug("[aforo-mqtt] too many unconfirmed publishes; mid %s not metered", lost)
        if confirmed:
            _push(**fields)
        return info

    def _subscribe(topic, qos=0, *args, **kwargs):  # type: ignore[no-untyped-def]
        # Paho accepts str or [(str, qos)] — normalize
        topics = [topic] if isinstance(topic, str) else [t[0] if isinstance(t, tuple) else t for t in topic]
        for t in topics:
            _push(topic=t, qos=qos, retained=False, event_type="SUBSCRIBE")
        return orig_subscribe(topic, qos, *args, **kwargs)

    def _unsubscribe(topic, *args, **kwargs):  # type: ignore[no-untyped-def]
        topics = [topic] if isinstance(topic, str) else list(topic)
        for t in topics:
            _push(topic=t, qos=0, retained=False, event_type="UNSUBSCRIBE")
        return orig_unsubscribe(topic, *args, **kwargs)

    client.publish = _publish
    client.subscribe = _subscribe
    client.unsubscribe = _unsubscribe


# ── aiomqtt (async) integration ──────────────────────────────────

def wrap_aiomqtt_client(
    billing: AforoMqttBilling,
    client: Any,
    *,
    customer_id: Any = _UNSET,
    customer_resolver: Optional[Callable[[Any], Optional[str]]] = None,
    trust_customer_header: bool = False,
    client_id: Optional[str] = None,
    product_type: Optional[str] = None,
) -> None:
    """
    Wrap an aiomqtt.Client's publish/subscribe methods + a CONNECT marker.
    Call inside the client's async context (after it connected).

    The customer is found as in ``wrap_paho_client``. PUBLISH is billed after
    ``publish()`` returns: aiomqtt waits for the broker's ack for QoS 1/2, so a
    publish that raises is not billed.

    Usage:
        async with aiomqtt.Client("broker.example.com") as c:
            wrap_aiomqtt_client(billing, c, customer_id=tenant.customer_id)
            await c.publish("devices/001", "hello")
            async for msg in c.messages:
                ...
    """
    customer = _customer_source(client, customer_id, customer_resolver, trust_customer_header,
                                "wrap_aiomqtt_client")
    cid = client_id or getattr(client, "_client_id", None) or "aiomqtt-client"
    if isinstance(cid, bytes):
        cid = cid.decode("utf-8")

    def _push(**fields: Any) -> None:
        billing.push(customer_id=customer(), product_type=product_type, client_id=cid, **fields)

    # CONNECT marker (aiomqtt exposes no on_connect callback; the wrapper is
    # applied inside the connected context).
    _push(topic="", qos=0, retained=False, event_type="CONNECT")

    orig_publish = client.publish
    orig_subscribe = client.subscribe
    orig_unsubscribe = client.unsubscribe

    async def _publish(topic, payload=None, qos=0, retain=False, **kwargs):  # type: ignore[no-untyped-def]
        result = await orig_publish(topic, payload=payload, qos=qos, retain=retain, **kwargs)
        _push(topic=topic, qos=qos, retained=retain, event_type="PUBLISH", data_bytes=_payload_bytes(payload))
        return result

    async def _subscribe(topic, qos=0, *args, **kwargs):  # type: ignore[no-untyped-def]
        topics = [topic] if isinstance(topic, str) else list(topic)
        for t in topics:
            _push(topic=str(t), qos=qos, retained=False, event_type="SUBSCRIBE")
        return await orig_subscribe(topic, qos, *args, **kwargs)

    async def _unsubscribe(topic, *args, **kwargs):  # type: ignore[no-untyped-def]
        topics = [topic] if isinstance(topic, str) else list(topic)
        for t in topics:
            _push(topic=str(t), qos=0, retained=False, event_type="UNSUBSCRIBE")
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
