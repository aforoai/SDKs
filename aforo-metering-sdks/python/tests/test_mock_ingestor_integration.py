"""End-to-end transport behaviour against the repo's fault-injecting mock ingestor.

Waits are on conditions (mock state, client counters), never fixed sleeps.
Timeouts and breaker pauses are configured short.
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import threading
import time
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

import pytest

from aforo import AforoClient
from aforo._transport import TransportCore

from .mock_ingestor import wait_until


def event(i: int):
    return {"customerId": "cust_1", "metricName": "api_calls", "quantity": 1,
            "occurredAt": "2026-10-26T00:00:00Z", "idempotencyKey": f"key-{i}", "productType": "API"}


def core(url: str, drops=None, **kw) -> TransportCore:
    drops = drops if drops is not None else []
    params = dict(api_key="test-key", base_url=url, user_agent="aforo-python-test/0", name="it",
                  flush_interval=3600, retry_base=0.01, breaker_initial=0.05, breaker_max=0.2,
                  timeout=2.0, shutdown_timeout=2.0, register_atexit=False,
                  on_drop=lambda items, reason: drops.append((reason, [i["idempotencyKey"] for i in items])))
    params.update(kw)
    return TransportCore(**params)


def test_outage_then_recovery_loses_nothing_and_keeps_keys(mock_ingestor):
    mock_ingestor.faults({"status": 503, "times": -1})
    drops = []
    c = core(mock_ingestor.url, drops)
    for i in range(5):
        c.enqueue(event(i))
    c.flush()
    mock_ingestor.wait_for(lambda s: len(s["requests"]) >= 8)  # retries, then post-breaker attempts
    assert c.dropped_count == 0  # an outage requeues; nothing is lost
    mock_ingestor.clear_faults()
    state = mock_ingestor.wait_for(lambda s: s["acceptedCount"] == 5)
    c.close()
    assert drops == []
    keys = {k for r in state["requests"] for k in r["idempotencyKeys"]}
    assert keys == {f"key-{i}" for i in range(5)}
    assert state["uniqueKeys"] == 5


@pytest.mark.parametrize("form", ["delta", "http-date"])
def test_429_retry_after_both_forms(mock_ingestor, form):
    if form == "delta":
        header, expected = "2", 2.0
    else:
        header = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=4), usegmt=True)
        expected = 4.0
    mock_ingestor.faults({"status": 429, "retryAfter": header})
    waits = []
    c = core(mock_ingestor.url, sleep=waits.append)
    c.enqueue(event(1))
    c.flush()
    c.close()
    assert mock_ingestor.state()["acceptedCount"] == 1
    assert len(waits) == 1 and waits[0] == pytest.approx(expected, abs=1.1)


def test_hung_response_times_out_and_is_retried(mock_ingestor):
    mock_ingestor.faults({"hang": True})
    c = core(mock_ingestor.url, timeout=0.3)
    c.enqueue(event(1))
    start = time.monotonic()
    c.flush()
    c.close()
    statuses = [r["status"] for r in mock_ingestor.state()["requests"]]
    assert statuses == [-2, 202]
    assert time.monotonic() - start < 3.0


def test_close_during_an_in_flight_request_honours_the_deadline(mock_ingestor):
    mock_ingestor.faults({"hang": True, "times": -1})
    drops = []
    c = core(mock_ingestor.url, drops, timeout=10.0, shutdown_timeout=0.5, flush_count=3)
    for i in range(3):
        c.enqueue(event(i))
    # the mock records a hung request with status -2 and never answers it
    mock_ingestor.wait_for(lambda s: [r["status"] for r in s["requests"]] == [-2])
    start = time.monotonic()
    c.close()
    assert time.monotonic() - start < 2.0
    assert drops == [("shutdown", ["key-0", "key-1", "key-2"])]


def test_overflow_while_the_breaker_is_open(mock_ingestor):
    mock_ingestor.faults({"status": 503, "times": -1})
    drops = []
    c = core(mock_ingestor.url, drops, max_queue_size=5, breaker_initial=0.5, breaker_max=0.5)
    for i in range(3):
        c.enqueue(event(i))
    c.flush()
    wait_until(lambda: c.breaker_open)
    for i in range(3, 10):
        c.enqueue(event(i))
    overflow = [k for reason, keys in drops if reason == "overflow" for k in keys]
    assert overflow == ["key-0", "key-1", "key-2", "key-3", "key-4"]
    mock_ingestor.clear_faults()
    mock_ingestor.wait_for(lambda s: s["acceptedCount"] == 5)
    c.close()


def test_per_event_retryable_failure_is_resent_with_the_same_key(mock_ingestor):
    mock_ingestor.faults({"perEvent": [{"index": 0, "message": "busy", "retryable": True},
                                       {"index": 1, "message": "unknown metric", "retryable": False}]})
    drops = []
    c = core(mock_ingestor.url, drops)
    for i in range(3):
        c.enqueue(event(i))
    c.flush()
    c.flush()
    c.close()
    state = mock_ingestor.state()
    assert drops == [("rejected", ["key-1"])]
    assert {e["idempotencyKey"] for e in state["events"]} == {"key-0", "key-2"}
    assert state["requests"][1]["idempotencyKeys"] == ["key-0"]


def test_a_single_flusher_means_one_request_in_flight(mock_ingestor):
    mock_ingestor.faults({"delayMs": 20, "times": -1})
    c = core(mock_ingestor.url, flush_count=50)

    def produce(base):
        for i in range(300):
            c.enqueue(event(base + i))

    threads = [threading.Thread(target=produce, args=(n * 1000,)) for n in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    c.flush()
    c.close()
    state = mock_ingestor.state()
    assert state["acceptedCount"] == 1200
    assert state["maxInFlight"] == 1


def test_client_wire_requests_match_the_contract(mock_ingestor):
    client = AforoClient(api_key="test-key", base_url=mock_ingestor.url, flush_interval=3600)
    client.track(customer_id="cust_1", metric_name="api_calls", quantity=2)
    client.flush()
    client.shutdown()
    request = mock_ingestor.state()["requests"][0]
    assert request["status"] == 202
    assert request["contentEncoding"] is None
    assert request["userAgent"].startswith("aforo-python/")
    assert request["apiKeyPresent"] and not request["authorizationPresent"]


@pytest.mark.skipif(not hasattr(os, "fork"), reason="needs os.fork")
def test_fork_child_gets_its_own_flusher(mock_ingestor):
    client = AforoClient(api_key="test-key", base_url=mock_ingestor.url, flush_interval=0.1)
    try:
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)  # fork with threads running
            pid = os.fork()
        if pid == 0:  # child: rely on the background flusher, never call flush()
            code = 1
            try:
                client.track(customer_id="cust_child", metric_name="api_calls", idempotency_key="from-child")
                end = time.monotonic() + 5
                while time.monotonic() < end and client.buffered_count:
                    time.sleep(0.02)
                end = time.monotonic() + 5
                while time.monotonic() < end and client._core.sent_count == 0:
                    time.sleep(0.02)
                code = 0 if client._core.sent_count == 1 else 2
            finally:
                os._exit(code)
        _, status = os.waitpid(pid, 0)
        assert os.waitstatus_to_exitcode(status) == 0
        keys = [e["idempotencyKey"] for e in mock_ingestor.state()["events"]]
        assert keys == ["from-child"]
    finally:
        client.shutdown()


def test_interpreter_exit_flushes_within_the_deadline(mock_ingestor):
    script = textwrap.dedent(f"""
        from aforo import AforoClient
        client = AforoClient(api_key="test-key", base_url={mock_ingestor.url!r}, flush_interval=3600)
        client.track(customer_id="cust_exit", metric_name="api_calls", idempotency_key="at-exit")
        # no shutdown(): the atexit hook must flush
    """)
    subprocess.run([sys.executable, "-c", script], check=True, timeout=30,
                   cwd=os.path.dirname(os.path.dirname(__file__)))
    keys = [e["idempotencyKey"] for e in mock_ingestor.state()["events"]]
    assert keys == ["at-exit"]
