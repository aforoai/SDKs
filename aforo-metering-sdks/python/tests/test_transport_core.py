"""Transport core (contract/TRANSPORT-SPEC.md) with a scripted HTTP transport.

Retry, backoff and breaker timing run on an injected clock / sleep / random,
so nothing here waits on the wall clock.
"""

from __future__ import annotations

import logging
import threading
from email.utils import format_datetime
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from aforo._transport import (
    TransportCore,
    breaker_cooldown,
    full_jitter,
    parse_retry_after,
    retry_delay,
    too_long,
    truncate_utf16,
    utf16_length,
    validate_base_url,
)

from .fakes import FakeClock, ScriptedServer, event, wait_until

SECRET = "sk_live_supersecret_key_value"


def make_core(server: ScriptedServer, clock: FakeClock = None, drops=None, **kw) -> TransportCore:
    clock = clock or FakeClock()
    drops = drops if drops is not None else []
    params = dict(
        api_key=SECRET, base_url="https://ingest.example.test", user_agent="aforo-test/0",
        name="test", flush_interval=3600, clock=clock, sleep=clock.sleep, rand=lambda: 0.0,
        wall_clock=lambda: 1_800_000_000.0, http_transport=server.transport(),
        on_drop=lambda items, reason: drops.append((reason, [i["idempotencyKey"] for i in items])),
        register_atexit=False,
    )
    params.update(kw)
    return TransportCore(**params)


# ── queue and flusher ───────────────────────────────────────────────

def test_enqueue_never_starts_a_thread_or_sends(monkeypatch):
    server = ScriptedServer()
    core = make_core(server, flush_count=10)
    started = []
    real_start = threading.Thread.start
    monkeypatch.setattr(threading.Thread, "start", lambda self: (started.append(self.name), real_start(self)))
    try:
        for i in range(3000):
            assert core.enqueue(event(i)) is True
        assert started == []
    finally:
        monkeypatch.undo()
        core.flush()
        core.close()
    assert len(server.keys) == 3000


def test_one_flusher_thread_sends_every_batch():
    server = ScriptedServer()
    core = make_core(server, flush_count=7)
    for i in range(50):
        core.enqueue(event(i))
    core.flush()
    core.close()
    assert server.threads == {"test-flusher"}
    assert [len(r["keys"]) for r in server.requests] == [7] * 7 + [1]


def test_reaching_flush_count_wakes_the_flusher_without_flush_call():
    server = ScriptedServer()
    core = make_core(server, flush_count=5)
    try:
        for i in range(5):
            core.enqueue(event(i))
        wait_until(lambda: len(server.keys) == 5)
    finally:
        core.close()


def test_flush_count_defaults_to_500_and_is_clamped_to_1000():
    server = ScriptedServer()
    assert make_core(server).flush_count == 500
    core = make_core(server, flush_count=5000)
    assert core.flush_count == 1000
    core.close()


def test_one_pooled_http_client_for_every_request(monkeypatch):
    server = ScriptedServer()
    core = make_core(server, flush_count=2)
    created = []
    real_init = httpx.Client.__init__
    monkeypatch.setattr(httpx.Client, "__init__",
                        lambda self, *a, **k: (created.append(1), real_init(self, *a, **k))[1])
    for i in range(10):
        core.enqueue(event(i))
    core.flush()
    core.close()
    assert len(server.requests) == 5
    assert created == []


def test_overflow_evicts_oldest_and_reports_it():
    server = ScriptedServer()
    drops = []
    core = make_core(server, drops=drops, max_queue_size=3, flush_count=100)
    for i in range(5):
        core.enqueue(event(i))
    assert drops == [("overflow", ["k0"]), ("overflow", ["k1"])]
    core.flush()
    core.close()
    assert server.keys == ["k2", "k3", "k4"]


def test_track_after_close_is_reported_as_closed_and_does_not_raise():
    server = ScriptedServer()
    drops = []
    core = make_core(server, drops=drops)
    core.close()
    assert core.enqueue(event(1)) is False
    assert drops == [("closed", ["k1"])]
    assert core.dropped_count == 1


# ── retries ─────────────────────────────────────────────────────────

def test_retries_use_full_jitter_from_the_injected_random():
    clock = FakeClock()
    server = ScriptedServer([503, 502, 202])
    core = make_core(server, clock, rand=lambda: 0.5)
    core.enqueue(event(1))
    core.flush()
    core.close()
    # attempt 0: random * min(30, 0.5 * 1) ; attempt 1: random * min(30, 0.5 * 2)
    assert clock.sleeps == [0.25, 0.5]
    assert server.keys == ["k1", "k1", "k1"]


def test_retry_after_delta_seconds_is_honoured():
    clock = FakeClock()
    core = make_core(ScriptedServer([(429, {"Retry-After": "2"}), 202]), clock)
    core.enqueue(event(1))
    core.flush()
    core.close()
    assert clock.sleeps == [2.0]


def test_retry_after_http_date_is_honoured():
    clock = FakeClock()
    now = 1_800_000_000.0
    date = format_datetime(datetime.fromtimestamp(now, timezone.utc) + timedelta(seconds=7), usegmt=True)
    core = make_core(ScriptedServer([(503, {"Retry-After": date}), 202]), clock, wall_clock=lambda: now)
    core.enqueue(event(1))
    core.flush()
    core.close()
    assert clock.sleeps == [pytest.approx(7.0)]


def test_retry_after_is_capped_at_60_seconds():
    clock = FakeClock()
    core = make_core(ScriptedServer([(429, {"Retry-After": "3600"}), 202]), clock)
    core.enqueue(event(1))
    core.flush()
    core.close()
    assert clock.sleeps == [60.0]


def test_unreadable_retry_after_falls_back_to_jitter():
    clock = FakeClock()
    core = make_core(ScriptedServer([(429, {"Retry-After": "soon"}), 202]), clock, rand=lambda: 1.0)
    core.enqueue(event(1))
    core.flush()
    core.close()
    assert clock.sleeps == [0.5]


def test_track_is_not_blocked_while_the_flusher_sleeps_between_retries():
    clock = FakeClock()
    in_sleep = threading.Event()
    release = threading.Event()

    def blocking_sleep(seconds):
        in_sleep.set()
        release.wait(5)
        clock.sleep(seconds)

    server = ScriptedServer([503, 202])
    core = make_core(server, clock, sleep=blocking_sleep, rand=lambda: 1.0)
    core.enqueue(event(0))
    flusher = threading.Thread(target=core.flush)
    flusher.start()
    assert in_sleep.wait(5)
    done = threading.Event()
    threading.Thread(target=lambda: (core.enqueue(event(1)), done.set())).start()
    assert done.wait(1), "enqueue blocked while the flusher slept"
    release.set()
    flusher.join(5)
    core.flush()
    core.close()
    assert set(server.keys) == {"k0", "k1"}


# ── status handling ────────────────────────────────────────────────

def test_outage_requeues_the_batch_with_the_same_keys_and_opens_the_breaker():
    clock = FakeClock()
    drops = []
    server = ScriptedServer([503, 503, 503, 503, 202])
    core = make_core(server, clock, drops=drops)
    for i in range(3):
        core.enqueue(event(i))
    first = core.flush()
    assert first.dropped == 0
    wait_until(lambda: core.sent_count == 3)
    core.close()
    assert drops == []
    assert [r["keys"] for r in server.requests] == [["k0", "k1", "k2"]] * 5
    # three jittered retries with random 0 (no wait), then the breaker pause:
    # max(0.25 s floor, random 0 * 5 s ceiling)
    assert clock.sleeps == [0.25]


def test_breaker_pause_grows_with_jitter_between_openings():
    # max(250 ms, random(0, min(300 s, 5 s * 2**n)))
    assert breaker_cooldown(0, lambda: 1.0) == 5.0
    assert breaker_cooldown(0, lambda: 0.5) == 2.5
    assert breaker_cooldown(1, lambda: 1.0) == 10.0
    assert breaker_cooldown(1, lambda: 0.0) == 0.25
    assert breaker_cooldown(1, lambda: 0.01) == 0.25
    assert breaker_cooldown(20, lambda: 1.0) == 300.0


@pytest.mark.parametrize("status", [401, 403])
def test_auth_failure_keeps_events_and_logs_error_once_per_opening(status, caplog):
    clock = FakeClock()
    drops = []
    server = ScriptedServer([status, status, 202])
    core = make_core(server, clock, drops=drops, logger=logging.getLogger("aforo.test.auth"))
    core.enqueue(event(1))
    with caplog.at_level(logging.WARNING, logger="aforo.test.auth"):
        core.flush()
        wait_until(lambda: core.sent_count == 1)
    core.close()
    assert drops == []
    errors = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert len(errors) == 1 and str(status) in errors[0].getMessage()
    assert SECRET not in caplog.text


def test_other_4xx_drops_the_batch_as_rejected_without_retry():
    drops = []
    server = ScriptedServer([422])
    core = make_core(server, drops=drops)
    core.enqueue(event(1))
    core.flush()
    core.close()
    assert drops == [("rejected", ["k1"])]
    assert len(server.requests) == 1


def test_413_splits_the_batch_and_a_single_oversized_event_is_rejected():
    drops = []
    server = ScriptedServer([413, 202, 413])
    core = make_core(server, drops=drops)
    for i in range(4):
        core.enqueue(event(i))
    core.flush()
    core.close()
    assert [r["keys"] for r in server.requests] == [
        ["k0", "k1", "k2", "k3"], ["k0", "k1"], ["k2", "k3"], ["k2"], ["k3"]]
    assert drops == []
    single = ScriptedServer([413])
    drops2 = []
    core = make_core(single, drops=drops2)
    core.enqueue(event(9))
    core.flush()
    core.close()
    assert drops2 == [("rejected", ["k9"])]


def test_partial_failure_requeues_retryable_events_and_drops_the_rest():
    def partial(request):
        return httpx.Response(202, json={"success": True, "data": {
            "accepted": 1, "failed": 2, "errors": [
                {"index": 0, "message": "busy", "retryable": True},
                {"index": 1, "message": "bad metric", "retryable": False}]}})

    drops = []
    server = ScriptedServer([partial])
    core = make_core(server, drops=drops)
    for i in range(3):
        core.enqueue(event(i))
    core.flush()
    core.flush()
    core.close()
    assert drops == [("rejected", ["k1"])]
    assert server.requests[1]["keys"] == ["k0"]


def test_failed_count_without_indexes_is_counted_but_no_event_is_named():
    def partial(request):
        return httpx.Response(202, json={"data": {"accepted": 1, "failed": 1, "errors": []}})

    drops = []
    core = make_core(ScriptedServer([partial]), drops=drops)
    core.enqueue(event(1))
    core.enqueue(event(2))
    core.flush()
    core.close()
    assert core.dropped_count == 1
    assert drops == []


def test_network_errors_and_timeouts_are_retried():
    clock = FakeClock()
    server = ScriptedServer([httpx.ConnectError("refused"), httpx.ReadTimeout("slow"), 202])
    core = make_core(server, clock)
    core.enqueue(event(1))
    core.flush()
    core.close()
    assert core.sent_count == 1 and len(server.requests) == 3


def test_batch_over_target_body_size_is_split_before_sending():
    server = ScriptedServer()
    core = make_core(server, target_body_bytes=400)
    for i in range(8):
        core.enqueue(event(i, metadata={"pad": "x" * 60}))
    core.flush()
    core.close()
    assert len(server.requests) > 1
    assert sorted(server.keys) == sorted(f"k{i}" for i in range(8))


def test_unserializable_event_is_dropped_as_invalid_and_the_rest_are_sent():
    drops = []
    server = ScriptedServer()
    core = make_core(server, drops=drops)
    core.enqueue(event(1, metadata={"when": object()}))
    core.enqueue(event(2))
    core.flush()
    core.close()
    assert drops == [("invalid", ["k1"])]
    assert server.keys == ["k2"]


# ── shutdown ────────────────────────────────────────────────────────

def test_close_stops_at_the_shutdown_deadline_and_reports_leftovers():
    clock = FakeClock()
    drops = []
    server = ScriptedServer(default=503)
    core = make_core(server, clock, drops=drops, rand=lambda: 1.0, shutdown_timeout=3.0, flush_count=2)
    for i in range(4):
        core.enqueue(event(i))
    start = clock()
    core.close()
    assert clock() - start <= 3.0
    assert sorted(k for _, keys in drops for k in keys) == ["k0", "k1", "k2", "k3"]
    assert {reason for reason, _ in drops} == {"shutdown"}


def test_close_flushes_what_it_can_within_the_deadline():
    server = ScriptedServer()
    core = make_core(server, flush_count=500)
    for i in range(1200):
        core.enqueue(event(i))
    core.close()
    assert len(server.keys) == 1200
    assert core.dropped_count == 0


def test_close_is_idempotent_and_flush_after_close_returns():
    core = make_core(ScriptedServer())
    core.close()
    core.close()
    assert core.flush().pending == 0


# ── hooks, secrets, wire ───────────────────────────────────────────

def test_on_drop_exception_is_caught_and_logged(caplog):
    core = make_core(ScriptedServer([422]), on_drop=lambda items, reason: 1 / 0,
                     logger=logging.getLogger("aforo.test.hook"))
    core.enqueue(event(1))
    with caplog.at_level(logging.DEBUG, logger="aforo.test.hook"):
        core.flush()
    core.close()
    assert core.dropped_count == 1
    assert "on_drop hook raised" in caplog.text


def test_flush_called_from_on_drop_hook_does_not_deadlock():
    holder = {}

    def hook(items, reason):
        holder["result"] = holder["core"].flush()

    core = make_core(ScriptedServer([422]), on_drop=hook)
    holder["core"] = core
    core.enqueue(event(1))
    core.flush(timeout=5)
    core.close()
    assert "result" in holder


def test_api_key_only_in_x_api_key_header_and_never_in_repr_or_logs(caplog):
    server = ScriptedServer([503, 400])
    core = make_core(server, logger=logging.getLogger("aforo.test.secret"))
    core.enqueue(event(1))
    with caplog.at_level(logging.DEBUG, logger="aforo.test.secret"):
        core.flush()
    core.close()
    headers = server.requests[0]["headers"]
    assert headers["x-api-key"] == SECRET
    assert "authorization" not in headers
    assert "content-encoding" not in headers
    assert headers["content-type"] == "application/json"
    assert headers["user-agent"] == "aforo-test/0"
    assert SECRET not in repr(core)
    assert SECRET not in caplog.text


def test_blank_api_key_is_refused():
    with pytest.raises(ValueError, match="api_key"):
        make_core(ScriptedServer(), api_key="  ")


# ── helpers ─────────────────────────────────────────────────────────

def test_base_url_must_be_https_except_for_loopback():
    assert validate_base_url("https://api.aforo.ai/") == "https://api.aforo.ai"
    assert validate_base_url("http://localhost:8084") == "http://localhost:8084"
    assert validate_base_url("http://127.0.0.1:1") == "http://127.0.0.1:1"
    assert validate_base_url("http://[::1]:1") == "http://[::1]:1"
    with pytest.raises(ValueError, match="https"):
        validate_base_url("http://ingest.example.com")
    assert validate_base_url("http://ingest.internal", allow_insecure_http=True) == "http://ingest.internal"
    with pytest.raises(ValueError):
        validate_base_url("ftp://x")
    with pytest.raises(ValueError, match="credentials"):
        validate_base_url("https://user:pw@api.aforo.ai")


def test_full_jitter_bounds():
    assert full_jitter(0, lambda: 1.0) == 0.5
    assert full_jitter(3, lambda: 1.0) == 4.0
    assert full_jitter(10, lambda: 1.0) == 30.0
    assert full_jitter(5, lambda: 0.0) == 0.0


def test_parse_retry_after_both_forms():
    now = 1_800_000_000.0
    assert parse_retry_after("5", now) == 5.0
    assert parse_retry_after(" 0 ", now) == 0.0
    date = format_datetime(datetime.fromtimestamp(now + 30, timezone.utc), usegmt=True)
    assert parse_retry_after(date, now) == pytest.approx(30.0)
    past = format_datetime(datetime.fromtimestamp(now - 30, timezone.utc), usegmt=True)
    assert parse_retry_after(past, now) == 0.0
    for bad in (None, "", "-1", "nan", "tomorrow"):
        assert parse_retry_after(bad, now) is None


def test_retry_delay_takes_the_larger_and_caps_at_60():
    assert retry_delay(0, 2.0, lambda: 1.0) == 2.0
    assert retry_delay(5, 1.0, lambda: 1.0) == 16.0
    assert retry_delay(0, 600.0, lambda: 0.0) == 60.0


def test_utf16_helpers_count_like_java():
    assert utf16_length("abc") == 3
    assert utf16_length("😀") == 2
    assert truncate_utf16("a😀b", 2) == "a"
    assert too_long("customerId", "😀" * 33, 64) is not None
    assert too_long("customerId", "😀" * 32, 64) is None
