"""Drop observability + opt-in on_drop hook tests."""

from unittest.mock import patch

import pytest

from aforo import AforoClient, AforoOptions
from aforo.types import FlushResult


def _client(**kwargs) -> AforoClient:
    opts = AforoOptions(
        api_key="test-key",
        base_url="https://ingest.test.aforo.ai",
        flush_count=100,
        flush_interval=60.0,  # long — control flushing manually
        max_retries=0,
        **kwargs,
    )
    return AforoClient(options=opts)


class TestDropObservability:
    def test_overflow_evicts_oldest_counts_warns_and_fires_hook(self, caplog):
        drops = []
        client = _client(
            max_queue_size=2,
            on_drop=lambda events, reason: drops.append((events, reason)),
        )
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
            assert len(events) == 1
            assert events[0].idempotency_key == "k1"  # oldest evicted
            assert any("Buffer overflow" in r.message for r in caplog.records)
        finally:
            client._closed = True  # avoid network flush on shutdown

    def test_send_failure_drops_batch_counts_warns_and_fires_hook(self, caplog):
        drops = []
        client = _client(on_drop=lambda events, reason: drops.append((events, reason)))
        try:
            client.track("cust_1", "api_calls", idempotency_key="k1")
            client.track("cust_2", "api_calls", idempotency_key="k2")

            with patch.object(
                client._transport, "send_sync",
                return_value=FlushResult(failed=2, reason="retry_exhausted"),
            ):
                with caplog.at_level("WARNING", logger="aforo.client"):
                    result = client.flush()

            assert result.failed == 2
            assert client.dropped_count == 2
            assert len(drops) == 1
            events, reason = drops[0]
            assert reason == "retry_exhausted"
            assert [e.idempotency_key for e in events] == ["k1", "k2"]
            assert any("retry_exhausted" in r.message for r in caplog.records)
        finally:
            client._closed = True

    def test_rejected_4xx_fires_hook_with_rejected_reason(self):
        reasons = []
        client = _client(on_drop=lambda events, reason: reasons.append(reason))
        try:
            client.track("cust_1", "api_calls")
            with patch.object(
                client._transport, "send_sync",
                return_value=FlushResult(failed=1, reason="rejected"),
            ):
                client.flush()

            assert client.dropped_count == 1
            assert reasons == ["rejected"]
        finally:
            client._closed = True

    def test_default_no_hook_counts_and_warns_result_unchanged(self, caplog):
        client = _client()
        try:
            client.track("cust_1", "api_calls")
            with patch.object(
                client._transport, "send_sync",
                return_value=FlushResult(failed=1, reason="retry_exhausted"),
            ):
                with caplog.at_level("WARNING", logger="aforo.client"):
                    result = client.flush()

            # Same result values as before the hardening
            assert result.sent == 0
            assert result.failed == 1
            assert client.dropped_count == 1
            assert any("Dropped" in r.message for r in caplog.records)
        finally:
            client._closed = True

    def test_raising_hook_never_breaks_flush(self):
        def bad_hook(events, reason):
            raise RuntimeError("hook bug")

        client = _client(on_drop=bad_hook)
        try:
            client.track("cust_1", "api_calls")
            with patch.object(
                client._transport, "send_sync",
                return_value=FlushResult(failed=1, reason="retry_exhausted"),
            ):
                result = client.flush()

            assert result.failed == 1
            assert client.dropped_count == 1
        finally:
            client._closed = True

    def test_hook_calling_flush_does_not_deadlock(self):
        # Regression: _record_drop fires inside _do_flush while the flush lock
        # is held. With a plain (non-reentrant) Lock, a hook that calls
        # client.flush() synchronously deadlocked the flush thread forever.
        client = _client()
        client._on_drop = lambda events, reason: client.flush()
        try:
            client.track("cust_1", "api_calls")
            with patch.object(
                client._transport, "send_sync",
                return_value=FlushResult(failed=1, reason="retry_exhausted"),
            ):
                result = client.flush()  # must return, not hang

            assert result.failed == 1
            assert client.dropped_count == 1
        finally:
            client._closed = True

    def test_happy_path_unchanged_no_drops_no_warns(self, caplog):
        calls = []
        client = _client(on_drop=lambda events, reason: calls.append(reason))
        try:
            client.track("cust_1", "api_calls")
            with patch.object(
                client._transport, "send_sync",
                return_value=FlushResult(sent=1),
            ):
                with caplog.at_level("WARNING", logger="aforo.client"):
                    result = client.flush()

            assert result.sent == 1
            assert result.failed == 0
            assert client.dropped_count == 0
            assert calls == []
            assert not caplog.records
        finally:
            client._closed = True
