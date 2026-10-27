"""contract/TRANSPORT-SPEC.md, "Edge cases every core handles the same way".

One test (or a small group) per row of that table, plus the review findings
that led to it. Retry, backoff and breaker timing run on an injected clock /
sleep / random; tests that need a real server use the repo's mock ingestor and
wait on conditions, never on fixed sleeps.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

import httpx
import pytest

from aforo._transport import TransportCore, TransportError
from aforo._transport.core import _Entry

from .fakes import FakeClock, ScriptedServer, event, wait_until

SECRET = "sk_live_supersecret_key_value"


def make_core(server, clock=None, drops=None, errors=None, **kw) -> TransportCore:
    clock = clock or FakeClock()
    drops = drops if drops is not None else []
    params = dict(
        api_key=SECRET, base_url="https://ingest.example.test", user_agent="aforo-test/0",
        name="edge", flush_interval=3600, clock=clock, sleep=clock.sleep, rand=lambda: 0.0,
        wall_clock=lambda: 1_800_000_000.0, http_transport=server.transport(),
        on_drop=lambda items, reason: drops.append((reason, [i["idempotencyKey"] for i in items])),
        register_atexit=False,
    )
    if errors is not None:
        params["on_error"] = errors.append
    params.update(kw)
    return TransportCore(**params)


def mock_core(url, drops=None, errors=None, **kw) -> TransportCore:
    drops = drops if drops is not None else []
    params = dict(api_key="test-key", base_url=url, user_agent="aforo-python-test/0", name="edge-it",
                  flush_interval=3600, retry_base=0.01, breaker_initial=0.05, breaker_max=0.2,
                  timeout=2.0, shutdown_timeout=2.0, register_atexit=False,
                  on_drop=lambda items, reason: drops.append((reason, [i["idempotencyKey"] for i in items])))
    if errors is not None:
        params["on_error"] = errors.append
    params.update(kw)
    return TransportCore(**params)


def retryable_answer(request: httpx.Request) -> httpx.Response:
    n = len(json.loads(request.content)["events"])
    return httpx.Response(202, json={"data": {"accepted": 0, "failed": n, "errors": [
        {"index": i, "message": "busy", "retryable": True} for i in range(n)]}})


# ── request deadline (finding 8) ────────────────────────────────────

@pytest.mark.parametrize("fault", [{"dripMs": 100}, {"stallBody": True}])
def test_timeout_covers_reading_the_response_body(mock_ingestor, fault):
    """A server that drips its body one byte at a time, or stalls after the
    headers, is cut off at the request timeout (httpx's own timeout is per read)."""
    mock_ingestor.faults(dict(fault, times=1))
    errors = []
    c = mock_core(mock_ingestor.url, errors=errors, timeout=0.6, max_retries=0, breaker_initial=60,
                  rand=lambda: 1.0)
    c.enqueue({"customerId": "c", "metricName": "m", "quantity": 1, "idempotencyKey": "slow-1"})
    start = time.monotonic()
    c.flush(timeout=10)
    elapsed = time.monotonic() - start
    try:
        assert elapsed < 2.0, f"request ran {elapsed:.2f}s with a 0.6s timeout"
        assert c.queue_size == 1  # not lost: requeued behind the breaker
        assert [e.kind for e in errors] == ["outage"]
    finally:
        mock_ingestor.clear_faults()
        c.close(timeout=2)


def test_post_single_also_honours_the_total_deadline(mock_ingestor):
    mock_ingestor.faults({"dripMs": 100, "times": 1})
    c = mock_core(mock_ingestor.url, timeout=0.6)
    try:
        start = time.monotonic()
        assert c.post_single({"events": []}) is None
        assert time.monotonic() - start < 2.0
    finally:
        c.close(timeout=1)


# ── redirects ───────────────────────────────────────────────────────

@pytest.mark.parametrize("status", [301, 302, 307, 308])
def test_redirect_is_not_followed_and_opens_the_breaker(status, caplog):
    clock = FakeClock()
    drops, errors = [], []
    server = ScriptedServer([(status, {"Location": "https://evil.example.net/v1/ingest/batch?x=1"})])
    core = make_core(server, clock, drops=drops, errors=errors)
    core.enqueue(event(0))
    with caplog.at_level(logging.ERROR, logger="aforo.transport"):
        core.flush()
    wait_until(lambda: core.sent_count == 1)  # after the breaker pause the default 202 answers
    core.close()
    assert [r["keys"] for r in server.requests] == [["k0"], ["k0"]]  # requeued once, no retries, no follow
    assert drops == []
    assert [(e.kind, e.status) for e in errors] == [("outage", status)]
    text = caplog.text
    assert "evil.example.net" in text and "base_url" in text
    assert SECRET not in text and "x=1" not in text
    assert clock.sleeps == [0.25]  # the breaker pause, nothing else


def test_redirect_from_a_real_server_is_not_followed(mock_ingestor):
    mock_ingestor.faults({"status": 307, "location": "http://127.0.0.1:9/elsewhere", "times": 1})
    errors = []
    c = mock_core(mock_ingestor.url, errors=errors, breaker_initial=60, rand=lambda: 1.0)
    c.enqueue({"customerId": "c", "metricName": "m", "quantity": 1, "idempotencyKey": "r-1"})
    c.flush(timeout=5)
    try:
        assert len(mock_ingestor.ingest_requests()) == 1
        assert c.queue_size == 1 and errors and errors[0].status == 307
    finally:
        mock_ingestor.clear_faults()
        c.close(timeout=2)


# ── every 5xx ───────────────────────────────────────────────────────

@pytest.mark.parametrize("status", [501, 505, 520, 599])
def test_every_5xx_is_retried(status):
    server = ScriptedServer([status] * 4)
    drops = []
    core = make_core(server, drops=drops)
    core.enqueue(event(0))
    core.flush()
    wait_until(lambda: core.sent_count == 1)
    core.close()
    assert len(server.requests) == 5  # 1 + 3 retries, then after the breaker the 202
    assert drops == []


# ── per-event retryable in a 2xx (finding 7) ────────────────────────

def test_per_event_retryable_waits_the_backoff_and_is_capped():
    clock = FakeClock()
    errors = []
    server = ScriptedServer([retryable_answer] * 4)
    core = make_core(server, clock, errors=errors, rand=lambda: 1.0)
    for i in range(3):
        core.enqueue(event(i))
    core.flush()
    wait_until(lambda: core.sent_count == 3)
    core.close()
    # 1 send + 3 re-sends with the full-jitter backoff, then the breaker
    # (rand 1.0: 0.5, 1, 2 s, then the 5 s cooldown), then the 202.
    assert len(server.requests) == 5
    assert all(r["keys"] == ["k0", "k1", "k2"] for r in server.requests)
    assert clock.sleeps == [0.5, 1.0, 2.0, 5.0]
    assert [e.kind for e in errors] == ["outage"]


def test_per_event_retryable_does_not_tight_loop():
    """The review proof: every event answered retryable, again and again.
    Before the fix the flusher re-sent at once, thousands of times a second."""
    clock = FakeClock()
    server = ScriptedServer([retryable_answer] * 100)
    core = make_core(server, clock, flush_count=10)
    for i in range(10):
        core.enqueue(event(i))
    wait_until(lambda: len(server.requests) >= 12)
    core.close(timeout=0)
    requests = len(server.requests)
    pauses = len([s for s in clock.sleeps if s >= 0.25])
    # At most 1 + max_retries sends per breaker pause (rand 0: no backoff wait).
    assert requests <= 4 * (pauses + 1)


def test_per_event_retry_cap_after_a_2xx_does_not_reset_the_breaker():
    clock = FakeClock()
    server = ScriptedServer([retryable_answer] * 8)
    core = make_core(server, clock, rand=lambda: 1.0)
    core.enqueue(event(0))
    core.flush()
    wait_until(lambda: core.sent_count == 1)
    core.close()
    # Two openings in a row: the second cooldown doubled (5 s, then 10 s).
    assert clock.sleeps == [0.5, 1.0, 2.0, 5.0, 0.5, 1.0, 2.0, 10.0]


# ── breaker cooldown ────────────────────────────────────────────────

def test_breaker_cooldown_has_a_250ms_floor_and_full_jitter():
    clock = FakeClock()
    draws = iter([0.0, 0.0, 0.0, 0.0, 0.5])  # three retry delays, then the cooldown draw
    server = ScriptedServer([503] * 4)
    core = make_core(server, clock, rand=lambda: next(draws, 0.0))
    core.enqueue(event(0))
    core.flush()
    wait_until(lambda: core.sent_count == 1)
    core.close()
    assert clock.sleeps == [0.25]  # rand 0 → the floor, not 5 s and not 0


# ── flush() while the breaker is open ───────────────────────────────

def test_flush_while_the_breaker_is_open_makes_one_attempt():
    server = ScriptedServer([503])
    errors = []
    core = TransportCore(api_key=SECRET, base_url="https://ingest.example.test", user_agent="t",
                         name="edge", flush_interval=3600, max_retries=0, breaker_initial=60,
                         rand=lambda: 1.0, http_transport=server.transport(), register_atexit=False,
                         on_error=errors.append)
    try:
        core.enqueue(event(0))
        core.flush(timeout=5)
        assert core.breaker_open and core.queue_size == 1
        outcome = core.flush(timeout=5)  # the 60 s breaker is open; the caller asked anyway
        assert outcome.sent == 1 and outcome.pending == 0
        assert len(server.requests) == 2
    finally:
        core.close(timeout=1)


def test_flush_while_the_breaker_is_open_reopens_it_on_failure():
    server = ScriptedServer(default=503)
    core = TransportCore(api_key=SECRET, base_url="https://ingest.example.test", user_agent="t",
                         name="edge", flush_interval=3600, max_retries=2, breaker_initial=60,
                         rand=lambda: 0.0, http_transport=server.transport(), register_atexit=False,
                         retry_base=0.001)
    try:
        core.enqueue(event(0))
        core.flush(timeout=5)
        before = len(server.requests)
        outcome = core.flush(timeout=5)
        assert len(server.requests) == before + 1  # one attempt, no retries
        assert outcome.pending == 1 and core.breaker_open
    finally:
        core.close(timeout=0)


# ── shutdown after an outage ────────────────────────────────────────

def test_shutdown_keeps_retrying_after_an_outage_until_the_deadline():
    clock = FakeClock()
    drops = []
    server = ScriptedServer([503] * 4 + [503] * 4)  # two full outages, then 202
    core = make_core(server, clock, drops=drops, shutdown_timeout=30)
    for i in range(3):
        core.enqueue(event(i))
    core.close()
    assert drops == []
    assert core.sent_count == 3
    assert len(server.requests) == 9


def test_shutdown_against_a_dead_ingestor_reports_at_the_deadline():
    clock = FakeClock()
    drops = []
    server = ScriptedServer(default=503)
    core = make_core(server, clock, drops=drops, shutdown_timeout=3, rand=lambda: 0.5)
    for i in range(2):
        core.enqueue(event(i))
    core.close()
    assert drops == [("shutdown", ["k0", "k1"])]
    assert len(server.requests) > 4  # more than one round of retries
    assert clock.now - 1000.0 <= 3.0  # never slept past the deadline


# ── a batch split in flight at shutdown (findings 6 and 10) ─────────

def test_unsent_half_of_a_split_batch_is_reported_when_close_gives_up():
    release = threading.Event()
    calls = []

    def handler(request):
        n = len(json.loads(request.content)["events"])
        calls.append(n)
        if len(calls) == 1:
            release.wait(10)  # the first half hangs past the shutdown deadline
        return httpx.Response(202, json={"data": {"accepted": n, "failed": 0}})

    drops = []
    core = TransportCore(api_key=SECRET, base_url="https://ingest.example.test", user_agent="t",
                         name="edge", flush_interval=3600, target_body_bytes=60, shutdown_timeout=0.3,
                         http_transport=httpx.MockTransport(handler), register_atexit=False,
                         on_drop=lambda items, reason: drops.append((reason, [i["idempotencyKey"] for i in items])))
    for i in range(4):
        core.enqueue(event(i))
    flushing = threading.Thread(target=core.flush, daemon=True)
    flushing.start()
    wait_until(lambda: calls)
    core.close()
    flushing.join(2)
    assert not flushing.is_alive()  # the pending flush() caller was completed
    release.set()
    wait_until(lambda: sorted(k for _, keys in drops for k in keys) == ["k0", "k1", "k2", "k3"])
    keys = sorted(k for _, keys in drops for k in keys)
    assert keys == ["k0", "k1", "k2", "k3"]  # every event once, none lost
    assert {reason for reason, _ in drops} == {"shutdown"}
    assert core.sent_count == 0 and core.queue_size == 0


def test_requeue_after_close_gave_up_is_reported_not_lost():
    """The race in finding 10: the flusher requeues an outage batch just after
    close() marked it abandoned."""
    drops = []
    core = make_core(ScriptedServer(), drops=drops)
    try:
        with core._lock:
            core._abandoned = True
        core._requeue_front([_Entry(event(7), json.dumps(event(7)))])
        assert drops == [("shutdown", ["k7"])]
        assert core.dropped_count == 1
    finally:
        with core._lock:
            core._abandoned = False
        core.close()


# ── unserializable event ────────────────────────────────────────────

class _Opaque:
    pass


def _cyclic():
    e = event(1)
    e["metadata"] = {}
    e["metadata"]["self"] = e["metadata"]
    return e


@pytest.mark.parametrize("bad", [
    lambda: dict(event(1), metadata={"x": float("nan")}),
    _cyclic,
    lambda: dict(event(1), metadata={"x": _Opaque()}),
])
def test_unserializable_event_is_dropped_at_track(bad):
    server = ScriptedServer()
    drops = []
    core = make_core(server, drops=drops)
    try:
        assert core.enqueue(bad()) is False
        assert core.dropped_count == 1 and core.queue_size == 0  # before any flush
        assert drops == [("invalid", ["k1"])]
        core.enqueue(event(2))
        core.flush()
        assert server.keys == ["k2"]
    finally:
        core.close()


def test_event_mutated_after_track_is_sent_as_tracked():
    server = ScriptedServer()
    core = make_core(server)
    e = event(1, metadata={"n": 1})
    core.enqueue(e)
    e["metadata"]["n"] = float("nan")  # would have broken the batch at send time
    core.flush()
    core.close()
    assert server.requests[0]["body"]["events"][0]["metadata"] == {"n": 1}


# ── callbacks ───────────────────────────────────────────────────────

def _run_with_deadline(fn, seconds=5.0):
    t = threading.Thread(target=fn, daemon=True)
    t.start()
    t.join(seconds)
    assert not t.is_alive(), "deadlocked"


def test_on_error_kinds_are_typed():
    errors = []
    server = ScriptedServer([400, 401, 503, 503, 503, 503])
    core = make_core(server, errors=errors, max_retries=3)
    core.enqueue(event(0))
    core.flush()  # 400: rejected
    core.enqueue(event(1))
    core.flush()  # 401: auth, kept
    wait_until(lambda: len(server.requests) >= 6)
    core.close(timeout=0)
    core.enqueue(event(9))  # closed
    kinds = [e.kind for e in errors]
    assert all(isinstance(e, TransportError) for e in errors)
    assert kinds[:2] == ["rejected", "auth"]
    assert "closed" in kinds
    rejected = errors[0]
    assert rejected.status == 400 and [i["idempotencyKey"] for i in rejected.events] == ["k0"]
    assert errors[1].will_retry and not rejected.will_retry
    closed = [e for e in errors if e.kind == "closed"][0]
    assert [i["idempotencyKey"] for i in closed.events] == ["k9"]


def test_shutdown_leftovers_are_reported_as_a_shutdown_error():
    errors = []
    core = make_core(ScriptedServer(default=503), errors=errors, shutdown_timeout=0)
    core.enqueue(event(0))
    core.close()
    assert [e.kind for e in errors][-1] == "shutdown"
    assert [i["idempotencyKey"] for i in errors[-1].events] == ["k0"]


def test_on_accepted_gets_the_unwrapped_body_and_the_events():
    seen = []

    def answer(request):
        n = len(json.loads(request.content)["events"])
        return httpx.Response(202, json={"success": True, "data": {
            "accepted": n, "failed": 0, "killedSessionIds": ["s-1"]}})

    core = make_core(ScriptedServer([answer]), on_accepted=lambda body, items: seen.append((body, items)))
    core.enqueue(event(0))
    core.flush()
    core.close()
    assert seen[0][0]["killedSessionIds"] == ["s-1"]
    assert [i["idempotencyKey"] for i in seen[0][1]] == ["k0"]


def test_callbacks_may_flush_or_close_and_their_exceptions_are_caught(caplog):
    holder = {}

    def on_error(err):
        holder["core"].flush()
        holder["core"].close()
        raise RuntimeError("boom in on_error")

    def on_accepted(body, items):
        holder["core"].flush()
        raise RuntimeError("boom in on_accepted")

    def on_drop(items, reason):
        holder["core"].flush()
        raise RuntimeError("boom in on_drop")

    server = ScriptedServer([202, 400])
    core = make_core(server, on_error=on_error, on_accepted=on_accepted, on_drop=on_drop)
    holder["core"] = core
    with caplog.at_level(logging.DEBUG, logger="aforo.transport"):
        core.enqueue(event(0))
        _run_with_deadline(core.flush)
        core.enqueue(event(1))
        _run_with_deadline(core.flush)  # 400 → on_drop + on_error (which closes)
        _run_with_deadline(core.close)
    assert core.closed
    assert "on_accepted hook raised" in caplog.text
    assert "on_drop hook raised" in caplog.text
    assert "on_error hook raised" in caplog.text


# ── errors[] is authoritative ───────────────────────────────────────

@pytest.mark.parametrize("failed", [0, None])
def test_errors_list_counts_even_when_failed_is_missing_or_zero(failed):
    def answer(request):
        data = {"accepted": 3, "errors": [{"index": 1, "message": "bad", "retryable": False},
                                          {"index": 2, "message": "busy", "retryable": True}]}
        if failed is not None:
            data["failed"] = failed
        return httpx.Response(202, json={"data": data})

    drops = []
    server = ScriptedServer([answer])
    core = make_core(server, drops=drops)
    for i in range(3):
        core.enqueue(event(i))
    core.flush()
    wait_until(lambda: len(server.requests) == 2)
    core.close()
    assert drops == [("rejected", ["k1"])]
    assert server.requests[1]["keys"] == ["k2"]  # the retryable one, same key
    assert core.sent_count == 2


# ── Retry-After ─────────────────────────────────────────────────────

def test_fractional_retry_after_is_honoured():
    clock = FakeClock()
    core = make_core(ScriptedServer([(429, {"Retry-After": "1.5"})]), clock)
    core.enqueue(event(0))
    core.flush()
    core.close()
    assert clock.sleeps == [1.5]


def test_retry_after_date_in_the_past_means_no_wait():
    clock = FakeClock()
    past = format_datetime(datetime.fromtimestamp(1_800_000_000.0, tz=timezone.utc) - timedelta(minutes=5),
                           usegmt=True)
    server = ScriptedServer([(503, {"Retry-After": past})])
    core = make_core(server, clock)
    core.enqueue(event(0))
    core.flush()
    core.close()
    assert clock.sleeps == []
    assert len(server.requests) == 2


# ── second close() ──────────────────────────────────────────────────

def test_second_close_waits_for_the_first_and_does_not_drain_again():
    release = threading.Event()

    def slow(request):
        release.wait(5)
        return httpx.Response(202, json={"data": {"accepted": 1, "failed": 0}})

    drops = []
    server = ScriptedServer([slow])
    core = TransportCore(api_key=SECRET, base_url="https://ingest.example.test", user_agent="t",
                         name="edge", flush_interval=3600, shutdown_timeout=3,
                         http_transport=server.transport(), register_atexit=False,
                         on_drop=lambda items, reason: drops.append(reason))
    core.enqueue(event(0))
    first = threading.Thread(target=core.close, daemon=True)
    first.start()
    wait_until(lambda: server.requests)
    second_done = threading.Event()
    second = threading.Thread(target=lambda: (core.close(), second_done.set()), daemon=True)
    second.start()
    assert not second_done.wait(0.2)  # waits for the first close
    release.set()
    first.join(5)
    assert second_done.wait(5)
    assert len(server.requests) == 1 and drops == [] and core.sent_count == 1
    core.close()  # a third call returns at once


def test_backoff_does_not_overflow_after_many_openings():
    from aforo._transport import breaker_cooldown, full_jitter

    assert breaker_cooldown(5000, lambda: 1.0) == 300.0
    assert full_jitter(5000, lambda: 1.0) == 30.0


def test_client_exposes_typed_on_error_and_on_accepted():
    from aforo import AforoClient, AforoOptions
    from aforo import TransportError as PublicTransportError

    errors, accepted = [], []
    server = ScriptedServer([400, 202])
    client = AforoClient(options=AforoOptions(
        api_key="k", base_url="https://ingest.example.test", flush_interval=3600, max_retries=0,
        http_transport=server.transport(), on_error=errors.append,
        on_accepted=lambda body, events: accepted.append((body, [e.idempotency_key for e in events]))))
    client.track(customer_id="c", metric_name="m", idempotency_key="bad")
    client.flush()
    client.track(customer_id="c", metric_name="m", idempotency_key="good")
    client.flush()
    client.shutdown()
    assert [(e.kind, e.status) for e in errors] == [("rejected", 400)]
    assert isinstance(errors[0], PublicTransportError)
    assert accepted == [({"accepted": 1, "failed": 0, "errors": []}, ["good"])]
