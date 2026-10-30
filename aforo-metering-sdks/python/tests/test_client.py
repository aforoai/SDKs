"""Tests for aforo.client — AforoClient."""

import re
import time
from unittest.mock import patch

import httpx
import pytest

from aforo.client import AforoClient
from aforo.types import TrackEvent

from .fakes import ScriptedServer, wait_until
from .gzip_body import request_bytes

URL = "https://ingest.example.test"


def _client(server=None, **kw):
    server = server or ScriptedServer()
    kw.setdefault("flush_interval", 999)
    return AforoClient(api_key="key", base_url=URL, http_transport=server.transport(), **kw), server


def _usage(server):
    """Usage events the server received (heartbeats excluded)."""
    return [e for r in server.requests for e in r["body"]["events"]
            if e["metricName"] != "system.session.heartbeat"]


def _heartbeats(server):
    return [r["body"]["events"] for r in server.requests
            if any(e["metricName"] == "system.session.heartbeat" for e in r["body"]["events"])]


class TestAforoClient:
    def test_sessions_send_heartbeats_alone_never_in_usage_batch(self):
        """Heartbeats go in their own request (so the ingestor intercepts them on
        the synchronous path), with quantity 1 -- never mixed into a usage batch."""
        client, server = _client()
        try:
            client.start_session("sess_1", product_type=" mcp_server ", customer_id="cust_9")
            client.track(customer_id="cust_1", metric_name="api_calls")
            client.end_session()

            assert [e["metricName"] for e in _usage(server)] == ["api_calls"]
            for request in server.requests:
                names = {e["metricName"] for e in request["body"]["events"]}
                assert len(names) == 1  # never mixed
            hbs = [batch[0] for batch in _heartbeats(server)]
            assert all(len(batch) == 1 for batch in _heartbeats(server))
            assert [hb["sessionBoundary"] for hb in hbs] == ["HEARTBEAT", "SESSION_END"]
            for d in hbs:
                assert d["metricName"] == "system.session.heartbeat"
                assert d["quantity"] == 1
                assert d["customerId"] == "cust_9"
                assert d["productType"] == "MCP_SERVER"
                assert d["sessionId"] == "sess_1"
                assert d["occurredAt"].endswith("Z")
                assert d["metadata"]["sessionId"] == "sess_1"
                assert d["metadata"]["productType"] == "MCP_SERVER"
                assert d["metadata"]["sessionBoundary"] == d["sessionBoundary"]
            assert hbs[1]["metadata"]["heartbeatType"] == "SESSION_END"
            assert len({hb["idempotencyKey"] for hb in hbs}) == 2
        finally:
            client.shutdown()

    def test_periodic_heartbeats_until_end_session(self):
        client, server = _client(heartbeat_interval=0.02)
        try:
            client.start_session("sess_1")
            wait_until(lambda: len(_heartbeats(server)) >= 3)
            client.end_session()
            count = len(_heartbeats(server))
            first = _heartbeats(server)[0][0]
            assert first["customerId"] == "system"
            assert first["productType"] == "AI_AGENT"
            assert first["metadata"]["heartbeatType"] == "PERIODIC"
            assert client._heartbeat_thread is None
            assert len(_heartbeats(server)) == count  # stopped
        finally:
            client.shutdown()

    def test_heartbeat_failure_never_affects_usage(self):
        def handle(request):
            import json

            if json.loads(request_bytes(request))["events"][0]["metricName"] == "system.session.heartbeat":
                raise httpx.ConnectError("boom")
            return httpx.Response(202, json={"data": {"failed": 0}})

        client, server = _client(ScriptedServer([handle] * 10))
        try:
            client.start_session("sess_1")
            client.track(customer_id="cust_1", metric_name="api_calls")
            client.end_session()
            assert client.dropped_count == 0
            assert any(e["metricName"] == "api_calls" for r in server.requests for e in r["body"]["events"])
        finally:
            client.shutdown()

    def test_shutdown_stops_heartbeats(self):
        client, server = _client(heartbeat_interval=0.02)
        client.start_session("sess_1")
        wait_until(lambda: len(_heartbeats(server)) >= 1)
        client.shutdown()
        count = len(_heartbeats(server))
        assert client._heartbeat_thread is None
        assert len(_heartbeats(server)) == count

    def test_product_type_default_client_option_and_per_event_override(self):
        client, server = _client()
        assert client.product_type == "API"
        client.track(customer_id="c", metric_name="m")
        client.flush()
        assert _usage(server)[0]["productType"] == "API"
        client.shutdown()

        client, server = _client(product_type=" agentic_api ")
        try:
            assert client.product_type == "AGENTIC_API"
            client.track(customer_id="c", metric_name="m")
            client.track(customer_id="c", metric_name="m", product_type="ai_agent",
                         extra_fields={"agentId": "a1", "sessionId": "s1"})
            client.track(event=TrackEvent(customer_id="c", metric_name="m", product_type="Custom_Type"))
            client.flush()
            dicts = _usage(server)
            assert [d["productType"] for d in dicts] == ["AGENTIC_API", "AI_AGENT", "CUSTOM_TYPE"]
            assert dicts[1]["agentId"] == "a1" and dicts[1]["sessionId"] == "s1"
        finally:
            client.shutdown()

    def test_flush_count_clamped_to_batch_limit(self):
        client, _ = _client(flush_count=5000)
        assert client._core.flush_count == 1000
        client.shutdown()
        client, _ = _client(flush_count=0)
        assert client._core.flush_count == 1
        client.shutdown()

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
        queued or sent; it is counted, WARN-logged and handed to on_drop
        with reason "invalid" (keeping its idempotency key)."""
        drops = []
        client, server = _client(on_drop=lambda events, reason: drops.append((events, reason)))
        try:
            with caplog.at_level("WARNING", logger="aforo.client"):
                client.track(**kwargs)  # must not raise
            assert client.buffered_count == 0
            assert client.dropped_count == 1
            assert len(drops) == 1 and drops[0][1] == "invalid"
            assert len(drops[0][0]) == 1 and drops[0][0][0].idempotency_key
            assert "Invalid event not sent" in caplog.text
            client.flush()
            assert server.requests == []
        finally:
            client.shutdown()

    def test_invalid_event_warning_is_throttled(self, caplog):
        client, _ = _client()
        try:
            with caplog.at_level("WARNING", logger="aforo.client"):
                for _ in range(1000):
                    client.track(customer_id="", metric_name="m")
            assert client.dropped_count == 1000
            # first occurrence, then every 1000th
            assert caplog.text.count("Invalid event not sent") == 2
        finally:
            client.shutdown()

    def test_partial_rejection_drops_only_the_rejected_events(self):
        partial = lambda request: httpx.Response(202, json={"data": {  # noqa: E731
            "accepted": 2, "failed": 1, "errors": [{"index": 1, "message": "unknown metric"}]}})
        drops = []
        client, _ = _client(ScriptedServer([partial]),
                            on_drop=lambda events, reason: drops.append((events, reason)))
        try:
            for key in ("k0", "k1", "k2"):
                client.track(customer_id="c", metric_name="m", idempotency_key=key)
            result = client.flush()
            assert (result.sent, result.failed) == (2, 1)
            assert client.dropped_count == 1
            assert [(e.idempotency_key, r) for evs, r in drops for e in evs] == [("k1", "rejected")]
        finally:
            client.shutdown()

    def test_partial_rejection_without_indices_counts_but_names_no_event(self):
        partial = lambda request: httpx.Response(202, json={"data": {"failed": 1}})  # noqa: E731
        drops = []
        client, _ = _client(ScriptedServer([partial]),
                            on_drop=lambda events, reason: drops.append((events, reason)))
        try:
            for _ in range(3):
                client.track(customer_id="c", metric_name="m")
            client.flush()
            assert client.dropped_count == 1
            assert drops == []
        finally:
            client.shutdown()

    def test_failed_heartbeat_is_not_a_usage_drop(self):
        drops = []
        client, _ = _client(ScriptedServer([503, 503]),
                            on_drop=lambda events, reason: drops.append(reason))
        try:
            client.start_session("sess_1")
            client.end_session()
            assert client.dropped_count == 0 and drops == []
            assert client.buffered_count == 0
        finally:
            client.shutdown()

    def test_requires_api_key(self):
        with pytest.raises(ValueError, match="api_key is required"):
            AforoClient(api_key="")

    def test_track_buffers_event(self):
        client, _ = _client()
        try:
            client.track(customer_id="cust_1", metric_name="api_calls", quantity=1)
            assert client.buffered_count == 1
        finally:
            client.shutdown()

    def test_flush_sends_events(self):
        client, _ = _client()
        try:
            client.track(customer_id="cust_1", metric_name="api_calls")
            client.track(customer_id="cust_2", metric_name="ai_tokens", quantity=500)

            result = client.flush()
            assert result.sent == 2
            assert client.buffered_count == 0
        finally:
            client.shutdown()

    def test_auto_flush_at_threshold(self):
        client, server = _client(flush_count=3)
        try:
            for i in range(3):
                client.track(customer_id=f"cust_{i}", metric_name="api_calls")
            # The background thread sends without a flush() call.
            wait_until(lambda: len(_usage(server)) == 3)
        finally:
            client.shutdown()

    def test_shutdown_flushes(self):
        client, server = _client()
        client.track(customer_id="cust_1", metric_name="api_calls")
        client.track(customer_id="cust_2", metric_name="api_calls")

        client.shutdown()
        assert len(_usage(server)) == 2
        assert client.is_shutdown

    def test_track_after_shutdown_is_dropped_as_closed(self):
        drops = []
        client, server = _client(on_drop=lambda events, reason: drops.append(reason))
        client.shutdown()
        client.track(customer_id="cust_1", metric_name="api_calls")  # no exception
        assert drops == ["closed"]
        assert server.requests == []

    def test_double_shutdown_safe(self):
        client, _ = _client()
        client.shutdown()
        client.shutdown()  # No error

    def test_auto_idempotency_key(self):
        # No caller key = dedup opt-out. Two same-instant identical events
        # must get DISTINCT random keys (the old content-hash fallback
        # collapsed them - the H4 bug Aforo ingest fixed in April 2026).
        import uuid as _uuid

        client, server = _client()
        try:
            client.track(customer_id="cust_1", metric_name="api_calls", quantity=1)
            client.track(customer_id="cust_1", metric_name="api_calls", quantity=1)
            client.flush()

            key_a, key_b = server.keys
            _uuid.UUID(key_a)  # parses as a UUID
            _uuid.UUID(key_b)
            assert key_a != key_b
        finally:
            client.shutdown()

    def test_same_millisecond_events_get_distinct_keys(self):
        """Regression: the default key used to be
        SHA256(customer_id:metric_name:quantity:occurred_at). ``occurred_at`` has
        millisecond precision, so two distinct events inside one millisecond
        hashed to the same key and the ingestor answered DUPLICATE and dropped
        the second one -- real usage silently lost (under-billing).
        """
        frozen = "2026-03-21T00:00:00.000Z"
        client, server = _client()
        try:
            with patch("aforo.client._utc_now_iso", return_value=frozen):
                client.track(customer_id="cust_1", metric_name="sms.sent", quantity=1)
                client.track(customer_id="cust_1", metric_name="sms.sent", quantity=1)
            client.flush()

            sent = _usage(server)
            assert len(sent) == 2
            assert sent[0]["occurredAt"] == sent[1]["occurredAt"] == frozen
            assert sent[0]["idempotencyKey"] != sent[1]["idempotencyKey"]
        finally:
            client.shutdown()

    def test_explicit_key_preserved_verbatim_for_colliding_events(self):
        """An explicit key is how a caller opts INTO dedup -- never rewritten."""
        client, server = _client()
        try:
            for _ in range(2):
                client.track(
                    customer_id="cust_1",
                    metric_name="sms.sent",
                    quantity=1,
                    occurred_at="2026-03-21T00:00:00.000Z",
                    idempotency_key="caller-owned-key",
                )
            client.flush()
            assert server.keys == ["caller-owned-key", "caller-owned-key"]
        finally:
            client.shutdown()

    def test_custom_idempotency_key(self):
        client, server = _client()
        try:
            client.track(customer_id="cust_1", metric_name="api_calls", idempotency_key="my-custom-key")
            client.flush()
            assert server.keys == ["my-custom-key"]
        finally:
            client.shutdown()

    def test_metadata_included(self):
        client, server = _client()
        try:
            client.track(customer_id="cust_1", metric_name="ai_tokens", quantity=1500,
                         metadata={"model": "gpt-4o"})
            client.flush()
            assert _usage(server)[0]["metadata"] == {"model": "gpt-4o"}
        finally:
            client.shutdown()

    def test_execution_status_normalized_and_serialized(self):
        client, server = _client()
        try:
            client.track(customer_id="cust_1", metric_name="api_calls", execution_status=" timeout ")
            client.track(event=TrackEvent(customer_id="cust_1", metric_name="api_calls", execution_status="partial"))
            client.flush()

            events = _usage(server)
            assert events[0]["executionStatus"] == "TIMEOUT"
            assert events[1]["executionStatus"] == "PARTIAL"
        finally:
            client.shutdown()

    def test_execution_status_omitted_when_absent_or_blank(self):
        client, server = _client()
        try:
            client.track(customer_id="cust_1", metric_name="api_calls")
            client.track(customer_id="cust_1", metric_name="api_calls", execution_status="   ")
            client.flush()
            assert all("executionStatus" not in e for e in _usage(server))
        finally:
            client.shutdown()

    def test_unknown_execution_status_is_omitted_with_warning(self, caplog):
        client, server = _client()
        try:
            with caplog.at_level("WARNING", logger="aforo.client"):
                client.track(customer_id="cust_1", metric_name="api_calls", execution_status="bogus")
                client.track(event=TrackEvent(
                    customer_id="cust_1", metric_name="api_calls", execution_status="X" * 25,
                ))
            client.flush()

            events = _usage(server)
            assert len(events) == 2
            assert all("executionStatus" not in e for e in events)
            assert events[0]["metricName"] == "api_calls"
            assert "Ignoring unknown executionStatus" in caplog.text
        finally:
            client.shutdown()
