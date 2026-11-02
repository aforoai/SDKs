"""Drop observability + on_drop hook (A+ delivery-guarantee prompt 6 —
transport-variant mirror of the core SDK's drop hardening).

Wave 5: the queue is bounded and an outage requeues instead of dropping, so
events are lost only on overflow, rejection, invalid input, the shutdown
deadline ("shutdown") or push() after shutdown ("closed"). With the network
down, shutdown() therefore reports the queued events as "shutdown".
time.sleep is patched out so retry and breaker waits do not wait.

Also locks two prompt-2 lessons:
  - shutdown() deregisters the atexit handler (no accumulation / GC pinning)
  - the on_drop hook fires OUTSIDE all locks (a hook calling shutdown()
    must not deadlock)
"""

from __future__ import annotations

import logging
import urllib.error
from unittest import mock

import pytest

from aforo_ws_metering.client import AforoWsBilling


@pytest.fixture
def no_httpx(monkeypatch):
    from aforo_ws_metering import client as mod
    monkeypatch.setattr(mod, "HAS_HTTPX", False, raising=False)


@pytest.fixture
def cfg():
    return dict(
        tenant_id="tenant-001",
        product_id="prod-ws-001",
        api_key="sk_ws_abc",
        ingestor_url="https://api.aforo.ai",
    )


def http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://api.aforo.ai/v1/ingest/batch", code, "err", {}, None)


def new_client(cfg, **kwargs):
    return AforoWsBilling(**cfg, **kwargs)


def record_one(client, customer_id="cust_1"):
    client.push({
        "customerId": customer_id,
        "wsConnectionId": "conn-1",
        "wsFrameType": "TEXT",
        "messageCount": 1,
    })

def drain(client):
    """Flush synchronously through shutdown(), skipping retry sleeps. The core
    keeps retrying until the shutdown deadline, so the deadline is kept short."""
    with mock.patch("time.sleep"):
        client.shutdown(timeout=0.3)


def test_network_down_at_shutdown_drops_counts_warns_and_fires_hook(no_httpx, cfg, caplog):
    drops = []
    client = new_client(cfg, on_drop=lambda events, reason: drops.append((events, reason)))
    record_one(client, "cust_1")
    record_one(client, "cust_2")

    with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("conn refused")):
        with caplog.at_level(logging.WARNING, logger="aforo_ws_metering"):
            drain(client)

    assert client.dropped_count == 2
    assert len(drops) == 1
    events, reason = drops[0]
    assert reason == "shutdown"
    assert len(events) == 2
    # Events keep their keys — dedup-safe replay is possible
    assert events[0]["idempotencyKey"].startswith("ws:")
    assert "total dropped" in caplog.text


def test_terminal_4xx_classified_rejected(no_httpx, cfg):
    reasons = []
    client = new_client(cfg, on_drop=lambda _e, reason: reasons.append(reason))
    record_one(client)

    with mock.patch("urllib.request.urlopen", side_effect=lambda *a, **k: (_ for _ in ()).throw(http_error(400))):
        drain(client)

    assert client.dropped_count == 1
    assert reasons == ["rejected"]


def test_5xx_at_shutdown_reported_as_shutdown(no_httpx, cfg):
    reasons = []
    client = new_client(cfg, on_drop=lambda _e, reason: reasons.append(reason))
    record_one(client)

    with mock.patch("urllib.request.urlopen", side_effect=lambda *a, **k: (_ for _ in ()).throw(http_error(503))):
        drain(client)

    assert client.dropped_count == 1
    assert reasons == ["shutdown"]


def test_default_no_hook_counts_warns_and_on_error_once(no_httpx, cfg, caplog):
    errors = []
    client = new_client(cfg, on_error=errors.append)
    record_one(client)

    with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("conn refused")):
        with caplog.at_level(logging.WARNING, logger="aforo_ws_metering"):
            drain(client)

    assert client.dropped_count == 1
    assert [e.kind for e in errors] == ["outage", "shutdown"]  # typed TransportError kinds
    assert "total dropped" in caplog.text


def test_throwing_hook_is_harmless(no_httpx, cfg):
    def bad_hook(_events, _reason):
        raise RuntimeError("hook bug")

    errors = []
    client = new_client(cfg, on_error=errors.append, on_drop=bad_hook)
    record_one(client)

    with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("conn refused")):
        drain(client)  # must not raise

    assert client.dropped_count == 1
    assert [e.kind for e in errors] == ["outage", "shutdown"]  # typed TransportError kinds


def test_hook_calling_shutdown_does_not_deadlock(no_httpx, cfg):
    """The hook fires outside all locks — reentrant shutdown must complete."""
    client = None

    def reentrant_hook(_events, _reason):
        client.shutdown()

    client = new_client(cfg, on_drop=reentrant_hook)
    record_one(client)

    with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("conn refused")):
        drain(client)  # would hang forever if the hook fired under a lock

    assert client.dropped_count == 1


def test_happy_path_unchanged(no_httpx, cfg):
    hook = mock.Mock()
    client = new_client(cfg, on_drop=hook)
    record_one(client)

    captured = []

    def ok_urlopen(req, timeout=None):
        captured.append(req)

        class _R:
            status = 204
            def __enter__(self_i):
                return self_i
            def __exit__(self_i, *_a):
                return False

        return _R()

    with mock.patch("urllib.request.urlopen", side_effect=ok_urlopen):
        drain(client)

    assert client.dropped_count == 0
    hook.assert_not_called()
    assert len(captured) == 1


@pytest.mark.real_transport
def test_shutdown_deregisters_atexit_handler(cfg):
    client = new_client({**cfg, "ingestor_url": "http://127.0.0.1:1"})
    with mock.patch("atexit.unregister") as unreg:
        client.shutdown(timeout=0)
    unreg.assert_called_once_with(client._core._atexit_close)


def test_push_after_shutdown_is_dropped_as_closed(no_httpx, cfg):
    reasons = []
    client = new_client(cfg, on_drop=lambda _e, reason: reasons.append(reason))
    drain(client)
    record_one(client)  # must not raise
    assert reasons == ["closed"]
