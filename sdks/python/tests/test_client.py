"""Tests for aforo.client — AforoClient."""

import time
from unittest.mock import patch, MagicMock

import pytest

from aforo.client import AforoClient
from aforo.types import FlushResult


class TestAforoClient:
    def _mock_transport(self):
        """Patch the transport to avoid real HTTP."""
        patcher = patch("aforo.client.Transport")
        mock_cls = patcher.start()
        mock_transport = MagicMock()
        mock_transport.send_sync.return_value = FlushResult(sent=1)
        mock_cls.return_value = mock_transport
        return patcher, mock_transport

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
        patcher, mock_transport = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            client.track(customer_id="cust_1", metric_name="api_calls", quantity=1)
            client.flush()

            call_args = mock_transport.send_sync.call_args[0][0]
            assert len(call_args[0].idempotency_key) == 32
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

    def test_requires_customer_id_and_metric(self):
        patcher, _ = self._mock_transport()
        try:
            client = AforoClient(api_key="key", flush_interval=999)
            with pytest.raises(ValueError, match="customer_id and metric_name"):
                client.track(customer_id="", metric_name="api_calls")
        finally:
            client.shutdown()
            patcher.stop()
