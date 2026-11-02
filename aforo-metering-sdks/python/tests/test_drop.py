"""Drop observability + opt-in on_drop hook tests (wave 5 semantics:
an outage requeues instead of dropping; overflow, rejected, invalid,
shutdown and closed are the ways an event is lost)."""

import pytest

from aforo import AforoClient, AforoOptions

from .fakes import ScriptedServer


def _client(server=None, **kwargs) -> AforoClient:
    server = server or ScriptedServer()
    opts = AforoOptions(
        api_key="test-key",
        base_url="https://ingest.example.test",
        flush_count=100,
        flush_interval=60.0,  # long — control flushing manually
        max_retries=0,
        http_transport=server.transport(),
        **kwargs,
    )
    return AforoClient(options=opts)


class TestDropObservability:
    def test_overflow_evicts_oldest_counts_warns_and_fires_hook(self, caplog):
        drops = []
        client = _client(max_queue_size=2, on_drop=lambda events, reason: drops.append((events, reason)))
        try:
            with caplog.at_level("WARNING", logger="aforo.client"):
                client.track("cust_1", "api_calls", idempotency_key="k1")
                client.track("cust_2", "api_calls", idempotency_key="k2")
                client.track("cust_3", "api_calls", idempotency_key="k3")

            assert client.dropped_count == 1
            assert client.buffered_count == 2
            assert len(drops) == 1
            events, reason = drops[0]
            assert reason == "overflow"
            assert [e.idempotency_key for e in events] == ["k1"]  # oldest evicted
            assert any("Queue full" in r.message for r in caplog.records)
        finally:
            client.shutdown()

    def test_send_failure_keeps_the_batch_queued_instead_of_dropping(self, caplog):
        drops = []
        client = _client(ScriptedServer([503]), on_drop=lambda events, reason: drops.append((events, reason)))
        try:
            client.track("cust_1", "api_calls", idempotency_key="k1")
            client.track("cust_2", "api_calls", idempotency_key="k2")
            with caplog.at_level("WARNING", logger="aforo.client"):
                result = client.flush()

            assert result.failed == 0
            assert client.dropped_count == 0
            assert client.buffered_count == 2  # requeued with the same keys
            assert drops == []
            assert any("unreachable" in r.message for r in caplog.records)
        finally:
            client.shutdown(timeout=0)

    def test_rejected_4xx_fires_hook_with_rejected_reason(self):
        reasons = []
        client = _client(ScriptedServer([400]), on_drop=lambda events, reason: reasons.append(reason))
        try:
            client.track("cust_1", "api_calls")
            client.flush()
            assert client.dropped_count == 1
            assert reasons == ["rejected"]
        finally:
            client.shutdown()

    def test_default_no_hook_counts_and_warns(self, caplog):
        client = _client(ScriptedServer([422]))
        try:
            client.track("cust_1", "api_calls")
            with caplog.at_level("WARNING", logger="aforo.client"):
                result = client.flush()
            assert result.sent == 0
            assert result.failed == 1
            assert client.dropped_count == 1
            assert any("Dropped" in r.message for r in caplog.records)
        finally:
            client.shutdown()

    def test_raising_hook_never_breaks_flush(self):
        def bad_hook(events, reason):
            raise RuntimeError("hook bug")

        client = _client(ScriptedServer([400]), on_drop=bad_hook)
        try:
            client.track("cust_1", "api_calls")
            result = client.flush()
            assert result.failed == 1
            assert client.dropped_count == 1
        finally:
            client.shutdown()

    def test_hook_calling_flush_does_not_deadlock(self):
        holder = {}
        client = _client(ScriptedServer([400]), on_drop=lambda events, reason: holder["c"].flush())
        holder["c"] = client
        try:
            client.track("cust_1", "api_calls")
            result = client.flush()  # must return, not hang
            assert result.failed == 1
            assert client.dropped_count == 1
        finally:
            client.shutdown()

    def test_hook_calling_shutdown_does_not_deadlock(self):
        holder = {}
        client = _client(ScriptedServer([400]), on_drop=lambda events, reason: holder["c"].shutdown())
        holder["c"] = client
        client.track("cust_1", "api_calls")
        client.flush(timeout=5)
        client.shutdown()
        assert client.is_shutdown

    def test_shutdown_deadline_reports_leftovers(self):
        drops = []
        client = _client(ScriptedServer(default=503), shutdown_timeout=0.2, retry_base_s=0.05,
                         on_drop=lambda events, reason: drops.append((reason, len(events))))
        for _ in range(3):
            client.track("cust_1", "api_calls")
        client.shutdown()
        assert drops == [("shutdown", 3)]
        assert client.dropped_count == 3

    def test_happy_path_no_drops_no_warns(self, caplog):
        calls = []
        client = _client(on_drop=lambda events, reason: calls.append(reason))
        try:
            client.track("cust_1", "api_calls")
            with caplog.at_level("WARNING", logger="aforo.client"):
                result = client.flush()
            assert result.sent == 1
            assert result.failed == 0
            assert client.dropped_count == 0
            assert calls == []
            assert not caplog.records
        finally:
            client.shutdown()
