"""Wave 5 gaps in the Python core, checked through the public AforoClient API."""

from __future__ import annotations

import threading

import httpx
import pytest

from aforo import AforoClient, AforoOptions, MiddlewareOptions
from .gzip_body import request_bytes


def _ok_transport(requests):
    def handle(request):
        import json

        body = json.loads(request_bytes(request))
        requests.append(body)
        return httpx.Response(202, json={"data": {"accepted": len(body["events"]), "failed": 0}})

    return httpx.MockTransport(handle)


def test_g281_track_above_flush_count_starts_no_thread(monkeypatch):
    requests = []
    client = AforoClient(api_key="k", base_url="https://ingest.example.test", flush_count=5,
                         flush_interval=3600, http_transport=_ok_transport(requests))
    started = []
    real_start = threading.Thread.start
    monkeypatch.setattr(threading.Thread, "start", lambda self: (started.append(self.name), real_start(self)))
    for i in range(100):
        client.track(customer_id="c", metric_name="api_calls", idempotency_key=f"k{i}")
    monkeypatch.undo()
    client.shutdown()
    assert started == []
    assert sum(len(b["events"]) for b in requests) == 100


def test_g269_default_batch_is_500_events():
    assert AforoOptions(api_key="k").flush_count == 500
    assert MiddlewareOptions(api_key="k").flush_count == 500


def test_g270_api_key_is_not_in_repr():
    secret = "sk_live_do_not_print"
    assert secret not in repr(AforoOptions(api_key=secret))
    assert secret not in repr(MiddlewareOptions(api_key=secret))
    client = AforoClient(api_key=secret, base_url="https://ingest.example.test")
    try:
        assert secret not in repr(client)
    finally:
        client.shutdown()


def test_g270_plain_http_is_refused_unless_loopback_or_opted_in():
    with pytest.raises(ValueError, match="https"):
        AforoClient(api_key="k", base_url="http://ingest.example.com")
    for url in ("http://localhost:1", "http://127.0.0.1:1"):
        AforoClient(api_key="k", base_url=url).shutdown(timeout=0)
    AforoClient(api_key="k", base_url="http://ingest.internal", allow_insecure_http=True).shutdown(timeout=0)


def test_g284_field_limits_count_utf16_units():
    drops = []
    client = AforoClient(api_key="k", base_url="https://ingest.example.test", flush_interval=3600,
                         on_drop=lambda events, reason: drops.append(reason))
    try:
        # 33 emoji = 33 code points but 66 UTF-16 units: over the 64 limit.
        client.track(customer_id="😀" * 33, metric_name="api_calls")
        client.track(customer_id="😀" * 32, metric_name="api_calls")
        assert drops == ["invalid"]
        assert client.buffered_count == 1
    finally:
        client.shutdown(timeout=0)


def test_g283_shutdown_timeout_bounds_shutdown_against_a_dead_ingestor():
    import time

    def refuse(request):
        raise httpx.ConnectError("refused")

    drops = []
    client = AforoClient(api_key="k", base_url="https://ingest.example.test", flush_interval=3600,
                         shutdown_timeout=0.5, retry_base_s=0.2, http_transport=httpx.MockTransport(refuse),
                         on_drop=lambda events, reason: drops.append((reason, len(events))))
    client.track(customer_id="c", metric_name="api_calls")
    start = time.monotonic()
    client.shutdown()
    assert time.monotonic() - start < 2.0
    assert drops == [("shutdown", 1)]


def test_track_after_shutdown_does_not_raise():
    drops = []
    client = AforoClient(api_key="k", base_url="https://ingest.example.test",
                         on_drop=lambda events, reason: drops.append(reason))
    client.shutdown(timeout=0)
    client.track(customer_id="c", metric_name="api_calls")
    assert drops == ["closed"]
    assert client.dropped_count == 1
