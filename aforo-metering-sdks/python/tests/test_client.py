"""Tests for aforo.client — AforoClient."""

import re
import time
from unittest.mock import patch, MagicMock

import pytest

from aforo.client import AforoClient
from aforo.types import FlushResult, TrackEvent


class TestAforoClient:
    def _mock_transport(self):
        """Patch the transport to avoid real HTTP."""
        patcher = patch("aforo.client.Transport")
        mock_cls = patcher.start()
        mock_transport = MagicMock()
        mock_transport.send_sync.return_value = FlushResult(sent=1)
        mock_cls.return_value = mock_transport
        return patcher, mock_transport

    def test_sessions_send_heartbeats_alone_never_in_usage_batch(self):
        """Heartbeats go in their own request (so the ingestor intercepts them on
        the synchronous path), with quantity 1 -- never mixed into a usage batch."""
        patcher, mock_transport = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            client.start_session("sess_1", product_type=" mcp_server ", customer_id="cust_9")
            client.track(customer_id="cust_1", metric_name="api_calls")
            client.end_session()

            sent = [e for call in mock_transport.send_sync.call_args_list for e in call.args[0]]
            assert [e.metric_name for e in sent] == ["api_calls"]
            assert all(e.quantity > 0 for e in sent)

            hbs = [call.args[0] for call in mock_transport.send_heartbeat.call_args_list]
            assert [hb.to_dict()["sessionBoundary"] for hb in hbs] == ["HEARTBEAT", "SESSION_END"]
            for hb in hbs:
                d = hb.to_dict()
                assert d["metricName"] == "system.session.heartbeat"
                assert d["quantity"] == 1
                assert d["customerId"] == "cust_9"
                assert d["productType"] == "MCP_SERVER"
                assert d["sessionId"] == "sess_1"
                assert d["occurredAt"].endswith("Z")
                assert d["metadata"]["sessionId"] == "sess_1"
                assert d["metadata"]["productType"] == "MCP_SERVER"
                assert d["metadata"]["sessionBoundary"] == d["sessionBoundary"]
            assert hbs[1].metadata["heartbeatType"] == "SESSION_END"
            assert len({hb.idempotency_key for hb in hbs}) == 2
        finally:
            client.shutdown()
            patcher.stop()

    def test_periodic_heartbeats_until_end_session(self):
        patcher, mock_transport = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999, heartbeat_interval=0.02)
            client.start_session("sess_1")
            time.sleep(0.15)
            client.end_session()
            count = mock_transport.send_heartbeat.call_count
            assert count >= 3
            first = mock_transport.send_heartbeat.call_args_list[0].args[0]
            assert first.customer_id == "system"
            assert first.product_type == "AI_AGENT"
            assert first.metadata["heartbeatType"] == "PERIODIC"
            time.sleep(0.08)
            assert mock_transport.send_heartbeat.call_count == count  # stopped
        finally:
            client.shutdown()
            patcher.stop()

    def test_heartbeat_failure_never_affects_usage(self):
        patcher, mock_transport = self._mock_transport()
        mock_transport.send_heartbeat.side_effect = RuntimeError("boom")
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            client.start_session("sess_1")
            client.track(customer_id="cust_1", metric_name="api_calls")
            client.end_session()
            assert mock_transport.send_sync.called
        finally:
            client.shutdown()
            patcher.stop()

    def test_shutdown_stops_heartbeats(self):
        patcher, mock_transport = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999, heartbeat_interval=0.02)
            client.start_session("sess_1")
            time.sleep(0.05)
            client.shutdown()
            count = mock_transport.send_heartbeat.call_count
            time.sleep(0.08)
            assert mock_transport.send_heartbeat.call_count == count
            assert client._heartbeat_thread is None
        finally:
            patcher.stop()

    def test_product_type_default_client_option_and_per_event_override(self):
        patcher, mock_transport = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            assert client.product_type == "API"
            client.track(customer_id="c", metric_name="m")
            client.flush()
            assert mock_transport.send_sync.call_args[0][0][0].to_dict()["productType"] == "API"
            client.shutdown()

            client = AforoClient(api_key="key", flush_interval=999, product_type=" agentic_api ")
            assert client.product_type == "AGENTIC_API"
            client.track(customer_id="c", metric_name="m")
            client.track(customer_id="c", metric_name="m", product_type="ai_agent",
                         extra_fields={"agentId": "a1", "sessionId": "s1"})
            client.track(event=TrackEvent(customer_id="c", metric_name="m", product_type="Custom_Type"))
            client.flush()
            dicts = [e.to_dict() for e in mock_transport.send_sync.call_args[0][0]]
            assert [d["productType"] for d in dicts] == ["AGENTIC_API", "AI_AGENT", "CUSTOM_TYPE"]
            assert dicts[1]["agentId"] == "a1" and dicts[1]["sessionId"] == "s1"
        finally:
            client.shutdown()
            patcher.stop()

    def test_flush_count_clamped_to_batch_limit(self):
        patcher, _ = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999, flush_count=5000)
            assert client._flush_count == 1000
            client.shutdown()
            client = AforoClient(api_key="key", flush_interval=999, flush_count=0)
            assert client._flush_count == 1
        finally:
            client.shutdown()
            patcher.stop()

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"customer_id": "  ", "metric_name": "m"},
            {"customer_id": "c", "metric_name": " "},
            {"customer_id": None, "metric_name": "m"},
            {"customer_id": "c", "metric_name": "m", "quantity": 0},
            {"customer_id": "c", "metric_name": "m", "quantity": -1},
            {"customer_id": "c", "metric_name": "m", "quantity": None},
            {"customer_id": "c", "metric_name": "m", "quantity": "lots"},
        ],
    )
    def test_invalid_event_is_dropped_not_raised(self, kwargs, caplog):
        """Rule: track() never raises for event content. An invalid event is not
        buffered or sent; it is counted, WARN-logged and handed to on_drop
        with reason "invalid" (keeping its idempotency key)."""
        patcher, mock_transport = self._mock_transport()
        drops = []
        try:
            client = AforoClient(
                api_key="key", flush_interval=999,
                on_drop=lambda events, reason: drops.append((events, reason)),
            )
            with caplog.at_level("WARNING", logger="aforo.client"):
                client.track(**kwargs)  # must not raise
            assert client.buffered_count == 0
            assert client.dropped_count == 1
            assert len(drops) == 1 and drops[0][1] == "invalid"
            assert len(drops[0][0]) == 1 and drops[0][0][0].idempotency_key
            assert "Invalid event not sent" in caplog.text
            client.flush()
            assert not mock_transport.send_sync.called
        finally:
            client.shutdown()
            patcher.stop()

    def test_invalid_event_warning_is_throttled(self, caplog):
        patcher, _ = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            with caplog.at_level("WARNING", logger="aforo.client"):
                for _ in range(1000):
                    client.track(customer_id="", metric_name="m")
            assert client.dropped_count == 1000
            # first occurrence, then every 1000th
            assert caplog.text.count("Invalid event not sent") == 2
        finally:
            client.shutdown()
            patcher.stop()

    def test_partial_rejection_drops_only_the_rejected_events(self):
        patcher, mock_transport = self._mock_transport()
        mock_transport.send_sync.return_value = FlushResult(
            sent=2, failed=1, reason="rejected", failed_indices=[1],
        )
        drops = []
        try:
            client = AforoClient(
                api_key="key", flush_interval=999,
                on_drop=lambda events, reason: drops.append((events, reason)),
            )
            for key in ("k0", "k1", "k2"):
                client.track(customer_id="c", metric_name="m", idempotency_key=key)
            result = client.flush()
            assert (result.sent, result.failed) == (2, 1)
            assert client.dropped_count == 1
            assert [(e.idempotency_key, r) for evs, r in drops for e in evs] == [("k1", "rejected")]
        finally:
            client.shutdown()
            patcher.stop()

    def test_partial_rejection_without_indices_counts_but_names_no_event(self):
        patcher, mock_transport = self._mock_transport()
        mock_transport.send_sync.return_value = FlushResult(sent=2, failed=1, reason="rejected")
        drops = []
        try:
            client = AforoClient(
                api_key="key", flush_interval=999,
                on_drop=lambda events, reason: drops.append((events, reason)),
            )
            for _ in range(3):
                client.track(customer_id="c", metric_name="m")
            client.flush()
            assert client.dropped_count == 1
            assert drops == []
        finally:
            client.shutdown()
            patcher.stop()

    def test_failed_heartbeat_is_not_a_usage_drop(self):
        patcher, mock_transport = self._mock_transport()
        mock_transport.send_heartbeat.return_value = None
        drops = []
        try:
            client = AforoClient(
                api_key="key", flush_interval=999,
                on_drop=lambda events, reason: drops.append(reason),
            )
            client.start_session("sess_1")
            client.end_session()
            assert client.dropped_count == 0 and drops == []
            assert client.buffered_count == 0
        finally:
            client.shutdown()
            patcher.stop()

    def test_requires_api_key(self):
        with pytest.raises(ValueError, match="api_key is required"):
            AforoClient(api_key="")

    def test_track_buffers_event(self):
        patcher, _ = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            client.track(customer_id="cust_1", metric_name="api_calls", quantity=1)
            assert client.buffered_count == 1
        finally:
            client.shutdown()
            patcher.stop()

    def test_flush_sends_events(self):
        patcher, mock_transport = self._mock_transport()
        mock_transport.send_sync.return_value = FlushResult(sent=2)
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            client.track(customer_id="cust_1", metric_name="api_calls")
            client.track(customer_id="cust_2", metric_name="ai_tokens", quantity=500)

            result = client.flush()
            assert result.sent == 2
            assert client.buffered_count == 0
        finally:
            client.shutdown()
            patcher.stop()

    def test_auto_flush_at_threshold(self):
        patcher, mock_transport = self._mock_transport()
        mock_transport.send_sync.return_value = FlushResult(sent=3)
        try:
            client = AforoClient(api_key="key", flush_count=3, flush_interval=999)
            for i in range(3):
                client.track(customer_id=f"cust_{i}", metric_name="api_calls")

            # Give background thread time to flush
            time.sleep(0.1)
            assert mock_transport.send_sync.called
        finally:
            client.shutdown()
            patcher.stop()

    def test_shutdown_flushes(self):
        patcher, mock_transport = self._mock_transport()
        mock_transport.send_sync.return_value = FlushResult(sent=2)
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            client.track(customer_id="cust_1", metric_name="api_calls")
            client.track(customer_id="cust_2", metric_name="api_calls")

            client.shutdown()
            assert mock_transport.send_sync.called
            assert client.is_shutdown
        finally:
            patcher.stop()

    def test_track_after_shutdown_raises(self):
        patcher, _ = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            client.shutdown()

            with pytest.raises(RuntimeError, match="shut down"):
                client.track(customer_id="cust_1", metric_name="api_calls")
        finally:
            patcher.stop()

    def test_double_shutdown_safe(self):
        patcher, _ = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            client.shutdown()
            client.shutdown()  # No error
        finally:
            patcher.stop()

    def test_auto_idempotency_key(self):
        # No caller key = dedup opt-out. Two same-instant identical events
        # must get DISTINCT random keys (the old content-hash fallback
        # collapsed them - the H4 bug Aforo ingest fixed in April 2026).
        import uuid as _uuid

        patcher, mock_transport = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            client.track(customer_id="cust_1", metric_name="api_calls", quantity=1)
            client.track(customer_id="cust_1", metric_name="api_calls", quantity=1)
            client.flush()

            call_args = mock_transport.send_sync.call_args[0][0]
            key_a = call_args[0].idempotency_key
            key_b = call_args[1].idempotency_key
            _uuid.UUID(key_a)  # parses as a UUID
            _uuid.UUID(key_b)
            assert key_a != key_b
        finally:
            client.shutdown()
            patcher.stop()

    def test_same_millisecond_events_get_distinct_keys(self):
        """Regression: the default key used to be
        SHA256(customer_id:metric_name:quantity:occurred_at). ``occurred_at`` has
        millisecond precision, so two distinct events inside one millisecond
        hashed to the same key and the ingestor answered DUPLICATE and dropped
        the second one -- real usage silently lost (under-billing).
        """
        patcher, mock_transport = self._mock_transport()
        frozen = "2026-03-21T00:00:00.000Z"
        try:
            with patch("aforo.client._utc_now_iso", return_value=frozen):
                client = AforoClient(api_key="key", flush_interval=999)
                client.track(customer_id="cust_1", metric_name="sms.sent", quantity=1)
                client.track(customer_id="cust_1", metric_name="sms.sent", quantity=1)
                client.flush()

            sent = mock_transport.send_sync.call_args[0][0]
            assert len(sent) == 2
            # Identical customer, metric, quantity AND occurred_at -- the frozen
            # clock reproduces exactly what the old SHA-256 default hashed.
            assert sent[0].occurred_at == sent[1].occurred_at == frozen
            assert sent[0].idempotency_key != sent[1].idempotency_key
        finally:
            client.shutdown()
            patcher.stop()

    def test_explicit_key_preserved_verbatim_for_colliding_events(self):
        """An explicit key is how a caller opts INTO dedup -- never rewritten."""
        patcher, mock_transport = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            for _ in range(2):
                client.track(
                    customer_id="cust_1",
                    metric_name="sms.sent",
                    quantity=1,
                    occurred_at="2026-03-21T00:00:00.000Z",
                    idempotency_key="caller-owned-key",
                )
            client.flush()

            sent = mock_transport.send_sync.call_args[0][0]
            assert [e.idempotency_key for e in sent] == [
                "caller-owned-key",
                "caller-owned-key",
            ]
        finally:
            client.shutdown()
            patcher.stop()

    def test_custom_idempotency_key(self):
        patcher, mock_transport = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            client.track(
                customer_id="cust_1",
                metric_name="api_calls",
                idempotency_key="my-custom-key",
            )
            client.flush()

            call_args = mock_transport.send_sync.call_args[0][0]
            assert call_args[0].idempotency_key == "my-custom-key"
        finally:
            client.shutdown()
            patcher.stop()

    def test_metadata_included(self):
        patcher, mock_transport = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            client.track(
                customer_id="cust_1",
                metric_name="ai_tokens",
                quantity=1500,
                metadata={"model": "gpt-4o"},
            )
            client.flush()

            call_args = mock_transport.send_sync.call_args[0][0]
            assert call_args[0].metadata == {"model": "gpt-4o"}
        finally:
            client.shutdown()
            patcher.stop()

    def test_execution_status_normalized_and_serialized(self):
        patcher, mock_transport = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            client.track(customer_id="cust_1", metric_name="api_calls", execution_status=" timeout ")
            client.track(event=TrackEvent(customer_id="cust_1", metric_name="api_calls", execution_status="partial"))
            client.flush()

            events = mock_transport.send_sync.call_args[0][0]
            assert events[0].execution_status == "TIMEOUT"
            assert events[0].to_dict()["executionStatus"] == "TIMEOUT"
            assert events[1].to_dict()["executionStatus"] == "PARTIAL"
        finally:
            client.shutdown()
            patcher.stop()

    def test_execution_status_omitted_when_absent_or_blank(self):
        patcher, mock_transport = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            client.track(customer_id="cust_1", metric_name="api_calls")
            client.track(customer_id="cust_1", metric_name="api_calls", execution_status="   ")
            client.flush()

            events = mock_transport.send_sync.call_args[0][0]
            assert all(e.execution_status is None for e in events)
            assert all("executionStatus" not in e.to_dict() for e in events)
        finally:
            client.shutdown()
            patcher.stop()

    def test_unknown_execution_status_is_omitted_with_warning(self, caplog):
        patcher, mock_transport = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            with caplog.at_level("WARNING", logger="aforo.client"):
                client.track(customer_id="cust_1", metric_name="api_calls", execution_status="bogus")
                client.track(event=TrackEvent(
                    customer_id="cust_1", metric_name="api_calls", execution_status="X" * 25,
                ))
            client.flush()

            events = mock_transport.send_sync.call_args[0][0]
            assert len(events) == 2
            assert all(e.execution_status is None for e in events)
            assert all("executionStatus" not in e.to_dict() for e in events)
            assert events[0].to_dict()["metricName"] == "api_calls"
            assert "Ignoring unknown executionStatus" in caplog.text
        finally:
            client.shutdown()
            patcher.stop()
