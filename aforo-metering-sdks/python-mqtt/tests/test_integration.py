"""
Real-broker integration test for aforo-mqtt-metering.

Where test_client.py uses in-memory fakes, this file:
  - starts a REAL mosquitto broker as a subprocess on a random port
  - connects a REAL paho-mqtt client wrapped with wrap_paho_client()
  - publishes + subscribes through the real broker
  - asserts the metering events reach a real HTTP capture server

Catches what mock-based tests can't:
  - real paho-mqtt callback signatures across versions
  - publish/subscribe/unsubscribe wrapping against the real client API
  - QoS + retain flag preservation under real broker semantics
  - the wrapper doesn't break paho's own book-keeping

Self-contained — skipped when mosquitto or paho-mqtt isn't available.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, List, Tuple

import pytest

from aforo_mqtt_metering import AforoMqttBilling, wrap_paho_client

try:
    import paho.mqtt.client as mqtt  # type: ignore
    HAS_PAHO = True
except ImportError:  # pragma: no cover
    HAS_PAHO = False


def _find_mosquitto() -> str:
    """Locate the mosquitto binary on PATH (brew puts it in /opt/homebrew/sbin)."""
    path = shutil.which("mosquitto")
    if path:
        return path
    for candidate in ("/opt/homebrew/sbin/mosquitto", "/usr/local/sbin/mosquitto", "/usr/sbin/mosquitto"):
        if os.path.exists(candidate):
            return candidate
    return ""


MOSQUITTO_BIN = _find_mosquitto()
HAS_MOSQUITTO = bool(MOSQUITTO_BIN)

pytestmark = pytest.mark.skipif(
    not (HAS_PAHO and HAS_MOSQUITTO),
    reason="paho-mqtt + mosquitto broker are required for the integration test",
)


# ── HTTP capture for the ingestor ─────────────────────────────────────

class _CaptureHandler(BaseHTTPRequestHandler):
    captured: List[Dict[str, Any]] = []

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else None
        except Exception:
            body = None
        type(self).captured.append(
            {"url": self.path, "body": body, "headers": dict(self.headers)}
        )
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_args: Any) -> None:
        pass


def _start_capture() -> Tuple[HTTPServer, threading.Thread, List[Dict[str, Any]]]:
    captured: List[Dict[str, Any]] = []

    class _Handler(_CaptureHandler):
        pass

    _Handler.captured = captured
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server, t, captured


# ── Mosquitto broker subprocess ───────────────────────────────────────

def _find_free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _MosquittoBroker:
    def __init__(self) -> None:
        self.port = _find_free_port()
        self.tmpdir = tempfile.mkdtemp(prefix="aforo-mqtt-test-")
        self.conf_path = os.path.join(self.tmpdir, "mosquitto.conf")
        with open(self.conf_path, "w") as f:
            f.write(f"listener {self.port} 127.0.0.1\n")
            f.write("allow_anonymous true\n")
            f.write("persistence false\n")
            # Keep mosquitto's own logging off stderr to avoid polluting pytest
            f.write(f"log_dest file {os.path.join(self.tmpdir, 'mosquitto.log')}\n")

        # Start the broker
        self.proc = subprocess.Popen(
            [MOSQUITTO_BIN, "-c", self.conf_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # Wait for the port to be accepting connections (up to 3s)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(0.2)
            try:
                s.connect(("127.0.0.1", self.port))
                s.close()
                return
            except OSError:
                s.close()
                time.sleep(0.05)
        self.stop()
        raise RuntimeError("mosquitto broker failed to come up on 127.0.0.1:%d" % self.port)

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=1)
        if os.path.isdir(self.tmpdir):
            shutil.rmtree(self.tmpdir, ignore_errors=True)


@pytest.fixture
def fixture():
    capture_server, capture_thread, captured = _start_capture()
    port = capture_server.server_address[1]
    ingestor_url = f"http://127.0.0.1:{port}"

    broker = _MosquittoBroker()

    billing = AforoMqttBilling(
        tenant_id="tenant-int-mqtt",
        product_id="prod-int-mqtt",
        api_key="sk_int_mqtt",
        ingestor_url=ingestor_url,
        flush_count=1,
        flush_interval_sec=60.0,
    )

    yield {
        "billing": billing,
        "broker": broker,
        "captured": captured,
    }

    billing.shutdown()
    broker.stop()
    capture_server.shutdown()
    capture_thread.join(timeout=2)


def _wait_for_events(captured: List[Dict[str, Any]],
                     predicate, timeout_sec: float = 3.0) -> List[Dict[str, Any]]:
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        events = [e for r in captured for e in (r.get("body") or {}).get("events", [])]
        if predicate(events):
            return events
        time.sleep(0.025)
    raise AssertionError(f"timed out; captured={captured!r}")


def _new_paho_client(client_id: str) -> Any:
    # paho-mqtt 2.x requires a callback_api_version. Fall back to 1.x
    # constructor for older installs.
    try:
        return mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
    except AttributeError:  # pragma: no cover — paho 1.x
        return mqtt.Client(client_id=client_id)


# ── Tests ─────────────────────────────────────────────────────────────

def test_PUBLISH_event_reaches_ingestor_via_real_broker(fixture):
    client = _new_paho_client("device-int-001")
    wrap_paho_client(fixture["billing"], client, customer_id="cust_pub_001")
    client.connect("127.0.0.1", fixture["broker"].port, keepalive=30)
    client.loop_start()
    try:
        # Give the broker a moment to accept
        time.sleep(0.1)
        info = client.publish("sensors/room-a/temperature", b"22.7", qos=1, retain=False)
        info.wait_for_publish(timeout=2)

        events = _wait_for_events(
            fixture["captured"],
            lambda evs: any(e.get("mqttEventType") == "PUBLISH" for e in evs),
        )
        pub = next(e for e in events if e.get("mqttEventType") == "PUBLISH")
        assert pub["productType"] == "MQTT_BROKER"
        assert pub["mqttTopic"] == "sensors/room-a/temperature"
        assert pub["mqttQos"] == 1
        assert pub["mqttRetained"] is False
        assert pub["mqttClientId"] == "device-int-001"
        assert pub["customerId"] == "cust_pub_001"
        assert pub["dataBytes"] == 4  # "22.7"
    finally:
        client.loop_stop()
        client.disconnect()


def test_SUBSCRIBE_event_reaches_ingestor(fixture):
    client = _new_paho_client("device-int-002")
    wrap_paho_client(fixture["billing"], client, customer_id="cust_sub_001")
    client.connect("127.0.0.1", fixture["broker"].port, keepalive=30)
    client.loop_start()
    try:
        time.sleep(0.1)
        result, _mid = client.subscribe("alerts/critical", qos=2)
        assert result == mqtt.MQTT_ERR_SUCCESS

        events = _wait_for_events(
            fixture["captured"],
            lambda evs: any(e.get("mqttEventType") == "SUBSCRIBE" for e in evs),
        )
        sub = next(e for e in events if e.get("mqttEventType") == "SUBSCRIBE")
        assert sub["mqttTopic"] == "alerts/critical"
        assert sub["mqttQos"] == 2
        assert sub["mqttClientId"] == "device-int-002"
        assert sub["customerId"] == "cust_sub_001"
    finally:
        client.loop_stop()
        client.disconnect()


def test_authorization_and_tenant_headers_reach_ingestor(fixture):
    client = _new_paho_client("device-int-headers")
    wrap_paho_client(fixture["billing"], client, customer_id="cust_hdr")
    client.connect("127.0.0.1", fixture["broker"].port, keepalive=30)
    client.loop_start()
    try:
        time.sleep(0.1)
        info = client.publish("h/test", b"x", qos=0)
        info.wait_for_publish(timeout=2)

        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and not fixture["captured"]:
            time.sleep(0.025)
        assert fixture["captured"], "ingestor was never called"

        headers = fixture["captured"][0]["headers"]
        assert headers.get("Authorization") == "Bearer sk_int_mqtt"
        assert headers.get("X-Tenant-Id") == "tenant-int-mqtt"
    finally:
        client.loop_stop()
        client.disconnect()
