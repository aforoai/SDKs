"""Wave 5 transport behaviour of this variant (G266-G270, G284, G285).

The client sends through the shared transport core (``_transport``, a
byte-identical copy of python/aforo/_transport). These tests prove the variant
is wired to it: one bounded queue, one sender thread, requeue on outage,
Retry-After in both forms, request deadlines and a bounded shutdown. Most run
against the repo's fault-injecting mock ingestor; waits are on conditions.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

import pytest

from fakes import ScriptedServer
from mock_ingestor import wait_until
from variant_harness import CLIENT_MODULE, EMIT, MAKE

pytestmark = pytest.mark.real_transport

FAST = {"retry_base": 0.01, "breaker_initial": 0.05, "breaker_max": 0.2}


def _keys(state):
    return {k for r in state["requests"] for k in r["idempotencyKeys"]}


def test_push_never_starts_a_thread_and_one_thread_sends(monkeypatch):
    server = ScriptedServer()
    b = MAKE("https://ingest.example.test", http_transport=server.transport(), flush_count=5)
    started = []
    real_start = threading.Thread.start
    monkeypatch.setattr(threading.Thread, "start", lambda self: (started.append(self.name), real_start(self)))
    for i in range(60):
        EMIT(b, i)
    monkeypatch.undo()
    b.flush()
    b.shutdown()
    assert started == []
    assert len(server.keys) == 60
    assert len(server.threads) == 1


def test_queue_is_bounded_and_overflow_is_reported():
    drops = []
    b = MAKE("https://ingest.example.test", http_transport=ScriptedServer().transport(), max_queue_size=3,
             on_drop=lambda events, reason: drops.append(reason))
    for i in range(5):
        EMIT(b, i)
    assert drops == ["overflow", "overflow"]
    b.shutdown()


def test_customer_id_limit_counts_utf16_units():
    drops = []
    b = MAKE("https://ingest.example.test", http_transport=ScriptedServer().transport(),
             on_drop=lambda events, reason: drops.append(reason))
    EMIT(b, 1, customer="\U0001F600" * 33)  # 66 UTF-16 units > 64
    assert drops == ["invalid"]
    b.shutdown()


def test_api_key_stays_out_of_repr_and_plain_http_is_refused():
    b = MAKE("https://ingest.example.test", http_transport=ScriptedServer().transport(), api_key="sk_live_hidden")
    try:
        assert "sk_live_hidden" not in repr(b)
    finally:
        b.shutdown()
    with pytest.raises(ValueError, match="https"):
        MAKE("http://ingest.example.com")


def test_outage_then_recovery_loses_nothing_and_keeps_keys(mock_ingestor):
    mock_ingestor.faults({"status": 503, "times": -1})
    drops = []
    b = MAKE(mock_ingestor.url, on_drop=lambda events, reason: drops.append(reason), transport_options=FAST)
    for i in range(4):
        EMIT(b, i)
    b.flush()
    mock_ingestor.wait_for(lambda s: len(s["requests"]) >= 6)
    mock_ingestor.clear_faults()
    state = mock_ingestor.wait_for(lambda s: s["acceptedCount"] == 4)
    b.shutdown()
    assert drops == []
    assert len(_keys(state)) == 4 and state["uniqueKeys"] == 4


@pytest.mark.parametrize("form", ["delta", "http-date"])
def test_429_retry_after_both_forms(mock_ingestor, form):
    if form == "delta":
        header, expected = "3", 3.0
    else:
        header = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=5), usegmt=True)
        expected = 5.0
    mock_ingestor.faults({"status": 429, "retryAfter": header})
    waits = []
    b = MAKE(mock_ingestor.url, transport_options={**FAST, "sleep": waits.append})
    EMIT(b, 1)
    b.flush()
    b.shutdown()
    assert mock_ingestor.state()["acceptedCount"] == 1
    assert len(waits) == 1 and waits[0] == pytest.approx(expected, abs=1.1)


def test_hung_response_times_out_and_is_retried(mock_ingestor):
    mock_ingestor.faults({"hang": True})
    b = MAKE(mock_ingestor.url, timeout=0.3, transport_options=FAST)
    EMIT(b, 1)
    start = time.monotonic()
    b.flush()
    b.shutdown()
    assert [r["status"] for r in mock_ingestor.state()["requests"]] == [-2, 202]
    assert time.monotonic() - start < 3.0


def test_shutdown_during_an_in_flight_request_honours_the_deadline(mock_ingestor):
    mock_ingestor.faults({"hang": True, "times": -1})
    drops = []
    b = MAKE(mock_ingestor.url, timeout=10.0, shutdown_timeout=0.5, flush_count=2,
             on_drop=lambda events, reason: drops.append((reason, len(events))))
    EMIT(b, 1)
    EMIT(b, 2)
    mock_ingestor.wait_for(lambda s: [r["status"] for r in s["requests"]] == [-2])
    start = time.monotonic()
    b.shutdown()
    assert time.monotonic() - start < 2.0
    assert drops == [("shutdown", 2)]


def test_a_single_sender_means_one_request_in_flight(mock_ingestor):
    mock_ingestor.faults({"delayMs": 15, "times": -1})
    b = MAKE(mock_ingestor.url, flush_count=25)

    def produce(base):
        for i in range(100):
            EMIT(b, base + i)

    threads = [threading.Thread(target=produce, args=(n * 1000,)) for n in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    b.flush()
    b.shutdown()
    state = mock_ingestor.state()
    assert state["acceptedCount"] == 300
    assert state["maxInFlight"] == 1


def test_wire_request_has_no_content_encoding_and_a_user_agent(mock_ingestor):
    b = MAKE(mock_ingestor.url)
    EMIT(b, 1)
    b.flush()
    b.shutdown()
    request = mock_ingestor.state()["requests"][0]
    assert request["status"] == 202 and request["contentEncoding"] is None
    assert request["userAgent"].endswith("/" + CLIENT_MODULE.__version__)
