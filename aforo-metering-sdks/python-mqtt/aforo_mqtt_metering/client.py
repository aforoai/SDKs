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
import hashlib
import json
import logging
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

try:
    import httpx  # type: ignore
    HAS_HTTPX = True
except ImportError:  # pragma: no cover
    HAS_HTTPX = False

__version__ = "1.2.2"
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


def _utf16_length(text: str) -> int:
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in text)


def _truncate_utf16(text: str, limit: int) -> str:
    """Longest prefix of ``text`` within ``limit`` UTF-16 code units. Cuts
    between characters, so a surrogate pair is never split."""
    if len(text) * 2 <= limit:
        return text
    units = 0
    for index, ch in enumerate(text):
        units += 2 if ord(ch) > 0xFFFF else 1
        if units > limit:
            return text[:index]
    return text


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


def _unwrap_envelope(payload):
    """The ingestor wraps every 2xx JSON body in ``{success, data, meta}``.

    Returns the inner ``data`` object when present, else the payload unchanged
    (bare shape).
    """
    if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
        return payload["data"]
    return payload


def _clip(value: Any) -> str:
    text = repr(value)
    return text if len(text) <= 80 else text[:77] + "..."


def _customer_id_problem(customer_id: Any) -> Optional[str]:
    """Why the ingestor would refuse this customerId, or None when it is usable."""
    if not isinstance(customer_id, str) or not customer_id.strip():
        return f"customerId is required (got {_clip(customer_id)})"
    if len(customer_id) > MAX_CUSTOMER_ID_LEN:
        return f"customerId exceeds {MAX_CUSTOMER_ID_LEN} chars (got {_clip(customer_id)})"
    return None


def _failed_events(raw: bytes, batch_len: int) -> Tuple[List[int], int]:
    """(indexes of refused events, refused count) from a batch response."""
    try:
        data = _unwrap_envelope(json.loads(raw.decode("utf-8")) if raw else None)
    except Exception:
        return [], 0
    if not isinstance(data, dict):
        return [], 0
    indexes: List[int] = []
    errors = data.get("errors") or []
    for err in errors if isinstance(errors, list) else []:
        idx = err.get("index") if isinstance(err, dict) else None
        if isinstance(idx, int) and not isinstance(idx, bool) and 0 <= idx < batch_len and idx not in indexes:
            indexes.append(idx)
    failed = data.get("failed")
    if not isinstance(failed, int) or isinstance(failed, bool) or failed < 0:
        failed = len(errors) if isinstance(errors, list) else 0
    return indexes, min(max(failed, len(indexes)), batch_len)


DEFAULT_PRODUCT_TYPE = "MQTT_BROKER"
MAX_RETRY_AFTER_SEC = 60.0


def _normalize_product_type(product_type: Any, default: str) -> str:
    """Trim + uppercase. Unknown values pass through; the ingestor is the authority."""
    value = str(product_type).strip().upper() if product_type is not None else ""
    return value or default


def _post_json(url: str, body: Dict[str, Any], headers: Dict[str, str]) -> Tuple[int, Optional[str], bytes]:
    """POST JSON; returns (status, Retry-After header, response body). Raises on network errors."""
    if HAS_HTTPX:
        with httpx.Client(timeout=10.0) as c:
            r = c.post(url, json=body, headers=headers)
            return r.status_code, r.headers.get("Retry-After"), r.content
    import urllib.error
    import urllib.request
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers=headers, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            return resp.status, _header(resp, "Retry-After"), _read(resp)
    except urllib.error.HTTPError as e:
        return e.code, _header(e, "Retry-After"), _read(e)


def _header(resp: Any, name: str) -> Optional[str]:
    try:
        value = resp.headers.get(name)
        return value if isinstance(value, str) else None
    except Exception:
        return None


def _read(resp: Any) -> bytes:
    try:
        data = resp.read()
        return data if isinstance(data, (bytes, bytearray)) else b""
    except Exception:
        return b""


def _retry_after_seconds(value: str, default: float) -> float:
    try:
        return min(max(0.0, float(value)), MAX_RETRY_AFTER_SEC)
    except (TypeError, ValueError):
        return default


def _error_messages(raw: bytes) -> List[str]:
    """Pull errors[].message out of a batch response ({accepted, failed, errors:[{index, message}]})."""
    try:
        data = _unwrap_envelope(json.loads(raw.decode("utf-8")) if raw else None)
    except Exception:
        return []
    if not isinstance(data, dict):
        return []
    out: List[str] = []
    for err in data.get("errors") or []:
        if isinstance(err, dict) and err.get("message"):
            prefix = f"[{err['index']}] " if err.get("index") is not None else ""
            out.append(prefix + str(err["message"]))
    return out


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
        on_drop: Optional[Callable[[List[Dict[str, Any]], str], None]] = None,
        product_type: str = DEFAULT_PRODUCT_TYPE,
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
        # Top-level productType on every event; push(product_type=...) overrides per call.
        self.product_type = _normalize_product_type(product_type, DEFAULT_PRODUCT_TYPE)
        self.on_error = on_error or (lambda e: logger.error(f"[aforo-mqtt] {e}"))
        # Opt-in hook receiving permanently dropped events (with their
        # idempotency keys — dedup-safe replay). Reasons: 'retry_exhausted'
        # (network/5xx/408/429 after 3 attempts) | 'rejected' (terminal 4xx,
        # or events the ingestor refused inside a 2xx partial response) |
        # 'invalid' (failed a client-side check; never buffered or sent).
        # Exceptions raised by the hook are swallowed.
        self.on_drop = on_drop
        self._dropped = 0
        self._drop_lock = threading.Lock()
        self._invalid_warned: set = set()
        self._truncation_warned: set = set()

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
            self._record_invalid(ev.to_dict(), invalid)
            return
        with self._buffer_lock:
            self._buffer.append(ev.to_dict())
            if len(self._buffer) >= self.flush_count:
                threading.Thread(target=self._flush, daemon=True).start()

    def _flush_loop(self) -> None:
        while not self._stop_event.wait(self.flush_interval_sec):
            self._flush()

    def _flush(self) -> None:
        with self._buffer_lock:
            if not self._buffer:
                return
            pending = self._buffer
            self._buffer = []

        # /v1/ingest/batch accepts at most MAX_BATCH_EVENTS per request.
        for i in range(0, len(pending), MAX_BATCH_EVENTS):
            self._send_batch(pending[i:i + MAX_BATCH_EVENTS])

    def _send_batch(self, batch: List[Dict[str, Any]]) -> None:
        # Events (and their idempotencyKeys) are built once in record/push,
        # so every retry below re-sends identical keys.
        body = {"events": batch}
        headers = {
            "Content-Type": "application/json",
            "X-API-Key": self.api_key,
            "X-Tenant-Id": self.tenant_id,
        }
        url = f"{self.ingestor_url}/v1/ingest/batch"

        for attempt in range(3):
            delay = float(2 ** attempt)
            try:
                status, retry_after, raw = _post_json(url, body, headers)
            except Exception as e:
                if attempt == 2:
                    self._record_drop(batch, "retry_exhausted")
                    self.on_error(e)
                    return
                time.sleep(delay)
                continue
            if 200 <= status < 300:
                # 202 can still carry per-event failures ({failed, errors:[{index, message}]}).
                self._report_partial_failures(batch, raw)
                return
            if 400 <= status < 500 and status not in (408, 429):
                # 400 invalid batch / 401 bad key / 422 unknown metric: retrying cannot help.
                messages = _error_messages(raw)
                self._record_drop(batch, "rejected")
                self.on_error(RuntimeError(
                    f"MQTT metering flush rejected with HTTP {status}, not retrying "
                    f"(dropped {len(batch)} events)" + (": " + "; ".join(messages[:5]) if messages else "")
                ))
                return
            if status == 429 and retry_after:
                delay = _retry_after_seconds(retry_after, delay)
            if attempt < 2:
                time.sleep(delay)
        self._record_drop(batch, "retry_exhausted")
        self.on_error(RuntimeError(f"MQTT metering flush failed after 3 attempts (dropped {len(batch)} events)"))

    def _report_partial_failures(self, batch: List[Dict[str, Any]], raw: bytes) -> None:
        """A 2xx batch response can refuse individual events. Those events are
        dropped with reason 'rejected'; the rest of the batch was accepted."""
        messages = _error_messages(raw)
        indexes, failed = _failed_events(raw, len(batch))
        if not messages and failed <= 0:
            return
        rejected = [batch[i] for i in indexes]
        unidentified = max(failed - len(rejected), 0)
        if rejected:
            self._record_drop(rejected, "rejected")
        if unidentified:
            # The response gave a count but no usable indexes: count the loss
            # without guessing which events it was (on_drop is not called).
            with self._drop_lock:
                self._dropped += unidentified
                total = self._dropped
            logger.warning(
                "[aforo-mqtt] Ingestor rejected %d event(s) it did not identify (%d total dropped).",
                unidentified, total,
            )
        self.on_error(RuntimeError(
            "MQTT metering: ingestor rejected events: " + "; ".join(messages[:5])
            if messages else
            f"MQTT metering: ingestor rejected {failed} event(s)"
        ))

    @property
    def dropped_count(self) -> int:
        """Total events permanently dropped (failed batches)."""
        with self._drop_lock:
            return self._dropped

    def _record_drop(self, events: List[Dict[str, Any]], reason: str) -> None:
        """Account for a permanently lost batch: bump the counter, WARN-log,
        and invoke the opt-in on_drop hook. The buffer is drained at flush
        start, so drops are bounded by flush cadence — no log throttle
        needed. The hook fires OUTSIDE all locks, so a hook that calls
        shutdown() cannot deadlock."""
        with self._drop_lock:
            self._dropped += len(events)
            dropped_total = self._dropped
        logger.warning(
            "[aforo-mqtt] Dropped %d event(s) — %s (%d total dropped).",
            len(events), reason, dropped_total,
        )
        if self.on_drop is not None:
            try:
                self.on_drop(events, reason)
            except Exception:
                # A hook bug must never break flushing.
                logger.debug("on_drop hook raised", exc_info=True)

    def _record_invalid(self, event: Dict[str, Any], message: str) -> None:
        """Account for an event that failed a client-side check. Never raises.
        The WARN is logged once per distinct message (bounded to 100 messages)
        so a tight loop cannot flood the log; the counter and hook always run."""
        with self._drop_lock:
            self._dropped += 1
            warn = message not in self._invalid_warned and len(self._invalid_warned) < 100
            if warn:
                self._invalid_warned.add(message)
        if warn:
            logger.warning("[aforo-mqtt] Dropped invalid event: %s", message)
        if self.on_drop is not None:
            try:
                self.on_drop([event], "invalid")
            except Exception:
                logger.debug("on_drop hook raised", exc_info=True)

    def shutdown(self) -> None:
        self._stop_event.set()
        # Deregister so repeated create/shutdown cycles don't accumulate
        # atexit handlers (which also pin the client from GC). Safe no-op
        # if called FROM the atexit handler itself.
        atexit.unregister(self._safe_shutdown)
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
    product_type: Optional[str] = None,
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
        billing.push(customer_id=customer_id, product_type=product_type, topic="", qos=0, retained=False,
                     event_type="CONNECT", client_id=cid)
        if orig_on_connect:
            return orig_on_connect(c, userdata, flags, rc, *args, **kwargs)

    def _on_disconnect(c, userdata, rc, *args, **kwargs):  # type: ignore[no-untyped-def]
        billing.push(customer_id=customer_id, product_type=product_type, topic="", qos=0, retained=False,
                     event_type="DISCONNECT", client_id=cid)
        if orig_on_disconnect:
            return orig_on_disconnect(c, userdata, rc, *args, **kwargs)

    def _on_message(c, userdata, msg):  # type: ignore[no-untyped-def]
        billing.push(
            customer_id=customer_id, product_type=product_type,
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
            customer_id=customer_id, product_type=product_type,
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
            billing.push(customer_id=customer_id, product_type=product_type, topic=t, qos=qos, retained=False,
                         event_type="SUBSCRIBE", client_id=cid)
        return orig_subscribe(topic, qos, *args, **kwargs)

    def _unsubscribe(topic, *args, **kwargs):  # type: ignore[no-untyped-def]
        topics = [topic] if isinstance(topic, str) else list(topic)
        for t in topics:
            billing.push(customer_id=customer_id, product_type=product_type, topic=t, qos=0, retained=False,
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
    product_type: Optional[str] = None,
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
    billing.push(customer_id=customer_id, product_type=product_type, topic="", qos=0, retained=False,
                 event_type="CONNECT", client_id=cid)

    orig_publish = client.publish
    orig_subscribe = client.subscribe
    orig_unsubscribe = client.unsubscribe

    async def _publish(topic, payload=None, qos=0, retain=False, **kwargs):  # type: ignore[no-untyped-def]
        billing.push(
            customer_id=customer_id, product_type=product_type,
            topic=topic, qos=qos, retained=retain,
            event_type="PUBLISH", client_id=cid,
            data_bytes=_payload_bytes(payload),
        )
        return await orig_publish(topic, payload=payload, qos=qos, retain=retain, **kwargs)

    async def _subscribe(topic, qos=0, *args, **kwargs):  # type: ignore[no-untyped-def]
        topics = [topic] if isinstance(topic, str) else list(topic)
        for t in topics:
            billing.push(customer_id=customer_id, product_type=product_type, topic=str(t), qos=qos, retained=False,
                         event_type="SUBSCRIBE", client_id=cid)
        return await orig_subscribe(topic, qos, *args, **kwargs)

    async def _unsubscribe(topic, *args, **kwargs):  # type: ignore[no-untyped-def]
        topics = [topic] if isinstance(topic, str) else list(topic)
        for t in topics:
            billing.push(customer_id=customer_id, product_type=product_type, topic=str(t), qos=0, retained=False,
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
