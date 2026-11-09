"""Regression tests for the 2026-11-09 SDK review (transport core and client).

Each test names the finding it pins. They run against an in-memory transport,
except the multiprocessing one, which needs a real loopback HTTP server because
the child process cannot see the parent's memory.
"""

from __future__ import annotations

import gzip
import http.server
import json
import logging
import multiprocessing
import sys
import threading

import httpx
import pytest

from aforo import AforoClient
from aforo._transport import TransportCore, wire_problem, without_unreadable_numbers
from aforo.limits import describe_limit_violation

from .fakes import ScriptedServer, event, wait_until

_clients = []


@pytest.fixture(autouse=True)
def _close_all():
    yield
    while _clients:
        _clients.pop().shutdown(timeout=0)


def _client(transport, **kw):
    kw.setdefault("flush_interval", 3600)
    kw.setdefault("retry_base_s", 0.001)
    c = AforoClient(api_key=kw.pop("api_key", "sk_test_review_fixes"), base_url="https://ingest.example.test",
                    http_transport=transport, **kw)
    _clients.append(c)
    return c


def _decode(request: httpx.Request):
    raw = request.content
    if request.headers.get("content-encoding") == "gzip":
        raw = gzip.decompress(raw)  # raises on a body that is not gzip
    return json.loads(raw)


# ── 1. A lone surrogate must not stop the sender ─────────────────────────


def test_lone_surrogate_is_dropped_at_track_and_the_sender_keeps_running():
    server = ScriptedServer()
    drops = []
    c = _client(server.transport(), on_drop=lambda ev, r: drops.append((r, [e.customer_id for e in ev])))
    c.track(customer_id="c_bad", metric_name="api_calls", metadata={"prompt": json.loads('"hi \\ud800"')})
    c.track(customer_id="c_ok", metric_name="api_calls", idempotency_key="ok-1")
    assert drops == [("invalid", ["c_bad"])]
    c.flush(5)
    c.track(customer_id="c_ok", metric_name="api_calls", idempotency_key="ok-2")
    c.flush(5)
    assert c._core._thread.is_alive()
    assert server.keys == ["ok-1", "ok-2"]


def test_an_unexpected_error_while_sending_is_reported_and_the_sender_survives(monkeypatch):
    server = ScriptedServer()
    drops = []
    c = _client(server.transport(), on_drop=lambda ev, r: drops.append((r, len(ev))))
    real = c._core._send_group
    calls = {"n": 0}

    def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("boom")
        return real(*args, **kwargs)

    monkeypatch.setattr(c._core, "_send_group", flaky)
    c.track(customer_id="c1", metric_name="api_calls", idempotency_key="lost")
    c.flush(5)
    assert drops == [("invalid", 1)]
    c.track(customer_id="c1", metric_name="api_calls", idempotency_key="after")
    c.flush(5)
    assert c._core._thread.is_alive()
    assert server.keys == ["after"]


# ── 2. The per-event retry re-encodes its smaller body ───────────────────


def test_retryable_resend_body_matches_its_content_encoding():
    seen = []

    def handler(request):
        body = _decode(request)  # fails the test if the encoding header lies
        seen.append((request.headers.get("content-encoding"), [e["idempotencyKey"] for e in body["events"]]))
        if len(seen) == 1:
            return httpx.Response(202, json={"success": True, "data": {
                "accepted": 4, "failed": 1, "errors": [{"index": 0, "message": "busy", "retryable": True}]}})
        return httpx.Response(202, json={"success": True, "data": {"accepted": len(body["events"]), "failed": 0}})

    drops = []
    c = _client(httpx.MockTransport(handler), on_drop=lambda ev, r: drops.append(r))
    for i in range(5):
        c.track(customer_id="c1", metric_name="api_calls", idempotency_key=f"k{i}", metadata={"pad": "x" * 300})
    c.flush(5)
    assert seen[0][0] == "gzip" and len(seen[0][1]) == 5
    assert seen[1] == (None, ["k0"])  # small enough to go plain, and labelled so
    assert drops == []


# ── 3. Values that would fail the whole batch body ───────────────────────


@pytest.mark.parametrize("value", [
    "2026-11-09T07:17:47.294542",      # datetime.utcnow().isoformat()
    "2026-11-09T07:17:47",
    "2026-11-09T10:00Z",               # no seconds
    "2026-11-09T10:00:00+0530",        # offset without a colon
])
def test_occurred_at_jackson_cannot_read_is_dropped_as_invalid(value):
    server = ScriptedServer()
    drops = []
    c = _client(server.transport(), on_drop=lambda ev, r: drops.append(r))
    c.track(customer_id="c1", metric_name="api_calls", occurred_at=value)
    assert drops == ["invalid"] and c.buffered_count == 0


@pytest.mark.parametrize("value", ["2026-11-09T07:17:47Z", "2026-11-09T07:17:47.294+00:00",
                                   "2026-11-09T07:17:47.123456789+05:30", "2026-11-09t07:17:47z"])
def test_occurred_at_jackson_reads_is_kept(value):
    c = _client(ScriptedServer().transport())
    c.track(customer_id="c1", metric_name="api_calls", occurred_at=value)
    assert c.buffered_count == 1


def test_non_dict_metadata_is_dropped_as_invalid():
    drops = []
    c = _client(ScriptedServer().transport(), on_drop=lambda ev, r: drops.append(r))
    c.track(customer_id="c1", metric_name="api_calls", metadata=["a", "b"])
    c.track(customer_id="c1", metric_name="api_calls", metadata="text")
    assert drops == ["invalid", "invalid"] and c.buffered_count == 0


def test_out_of_range_integer_field_is_left_off_and_the_event_kept():
    server = ScriptedServer()
    c = _client(server.transport())
    c.track(customer_id="c1", metric_name="api_calls",
            extra_fields={"executionDurationMs": 3_000_000_000, "statusCode": 70000, "messageCount": 3})
    c.flush(5)
    sent = server.requests[0]["body"]["events"][0]
    assert "executionDurationMs" not in sent and "statusCode" not in sent
    assert sent["messageCount"] == 3


def test_wire_checks_cover_raw_dict_events():
    assert wire_problem(event(1)) is None
    assert "occurredAt" in wire_problem(event(1, occurredAt="2026-10-26T00:00:00"))
    assert "metadata" in wire_problem(event(1, metadata=[1]))
    assert "trace" in wire_problem(event(1, trace="x"))
    assert "quantity" in wire_problem(event(1, quantity="lots"))
    assert "customerId" in wire_problem(event(1, customerId={"id": 1}))
    kept, left_off = without_unreadable_numbers(event(1, dataBytes=2 ** 70, mqttQos=1))
    assert left_off == ("dataBytes",) and kept["mqttQos"] == 1


# ── 4. The API key never reaches a log line or on_error ─────────────────


def test_api_key_with_trailing_newline_is_stripped_before_sending():
    server = ScriptedServer()
    c = _client(server.transport(), api_key="sk_live_SECRET12345\n")
    c.track(customer_id="c1", metric_name="api_calls")
    c.flush(5)
    assert server.requests[0]["headers"]["x-api-key"] == "sk_live_SECRET12345"


@pytest.mark.parametrize("key", ["sk_live_SE CRET", "sk_live_\x00SECRET", "sk_live_…SECRET"])
def test_api_key_that_cannot_be_a_header_is_refused_without_echoing_it(key):
    with pytest.raises(ValueError) as info:
        TransportCore(api_key=key, base_url="https://ingest.example.test", user_agent="t",
                      register_atexit=False, http_transport=ScriptedServer().transport())
    assert "SECRET" not in str(info.value)


def test_failure_text_with_the_key_is_redacted_in_logs_and_on_error(caplog):
    key = "sk_live_SUPERSECRET123"
    server = ScriptedServer([httpx.ConnectError(f"proxy refused header X-API-Key: {key}")] * 3)
    errors = []
    c = _client(server.transport(), api_key=key, max_retries=0, on_error=lambda e: errors.append(str(e)))
    with caplog.at_level(logging.DEBUG):
        c.track(customer_id="c1", metric_name="api_calls")
        c.flush(5)
    assert errors and all("SUPERSECRET" not in e for e in errors)
    assert "SUPERSECRET" not in caplog.text and "[redacted]" in caplog.text


# ── 5. A multiprocessing child flushes what it tracked ──────────────────


class _Recorder(http.server.BaseHTTPRequestHandler):
    keys: list = []

    def do_POST(self):  # noqa: N802
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        if self.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        _Recorder.keys.extend(e["idempotencyKey"] for e in json.loads(raw)["events"])
        out = json.dumps({"success": True, "data": {"accepted": 1, "failed": 0}}).encode()
        self.send_response(202)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


def _child_work(client):
    for i in range(3):
        client.track(customer_id="cust_mp", metric_name="api_calls", idempotency_key=f"mp-{i}")


@pytest.mark.skipif(sys.platform == "win32" or "fork" not in multiprocessing.get_all_start_methods(),
                    reason="needs the fork start method")
def test_multiprocessing_child_flushes_its_events_at_exit():
    _Recorder.keys = []
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Recorder)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        c = AforoClient(api_key="sk_test_review_fixes", base_url=f"http://127.0.0.1:{httpd.server_port}",
                        flush_interval=3600)
        _clients.append(c)
        p = multiprocessing.get_context("fork").Process(target=_child_work, args=(c,))
        p.start()
        p.join(30)
        assert p.exitcode == 0
        assert sorted(_Recorder.keys) == ["mp-0", "mp-1", "mp-2"]
    finally:
        httpd.shutdown()


# ── R5. 429 with a per-key limit below the batch size ───────────────────


def test_429_with_rate_limit_below_batch_size_splits_into_parts_in_order():
    def handler(request):
        events = _decode(request)["events"]
        keys = [e["idempotencyKey"] for e in events]
        handler.seen.append(keys)
        if len(events) > 2:
            return httpx.Response(429, headers={"X-RateLimit-Limit": "2", "Retry-After": "0"},
                                  json={"title": "Too Many Requests"})
        return httpx.Response(202, headers={"X-RateLimit-Limit": "2"},
                              json={"success": True, "data": {"accepted": len(events), "failed": 0}})

    handler.seen = []
    drops = []
    c = _client(httpx.MockTransport(handler), on_drop=lambda ev, r: drops.append(r))
    for i in range(5):
        c.track(customer_id="c1", metric_name="api_calls", idempotency_key=f"k{i}")
    c.flush(10)
    assert handler.seen == [["k0", "k1", "k2", "k3", "k4"], ["k0", "k1"], ["k2", "k3"], ["k4"]]
    assert drops == [] and c.buffered_count == 0


def test_429_without_a_lower_limit_keeps_the_normal_retry():
    server = ScriptedServer([(429, {"Retry-After": "0"}), 202])
    c = _client(server.transport())
    for i in range(3):
        c.track(customer_id="c1", metric_name="api_calls", idempotency_key=f"k{i}")
    c.flush(10)
    assert [r["keys"] for r in server.requests] == [["k0", "k1", "k2"], ["k0", "k1", "k2"]]


# ── Lesser: quantity written with an exponent ───────────────────────────


@pytest.mark.parametrize("quantity", [1e16, 1e15])
def test_exponent_quantity_over_the_digit_limit_is_invalid(quantity):
    assert describe_limit_violation({"quantity": quantity}) is not None


def test_exponent_quantity_within_the_limit_is_kept():
    assert describe_limit_violation({"quantity": 1e13}) is None
    assert describe_limit_violation({"quantity": 1.5e-3}) is None
