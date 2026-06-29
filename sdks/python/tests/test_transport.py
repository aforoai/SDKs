"""Tests for aforo.transport — HTTP transport with retry."""

from unittest.mock import patch, MagicMock

import httpx
import pytest

from aforo.transport import Transport
from aforo.types import ResolvedEvent


def _events(n: int = 1) -> list[ResolvedEvent]:
    return [
        ResolvedEvent(
            customer_id=f"cust_{i}",
            metric_name="api_calls",
            quantity=1,
            idempotency_key=f"key_{i}",
            occurred_at="2026-03-21T00:00:00Z",
        )
        for i in range(n)
    ]


class TestTransport:
    def _transport(self, max_retries: int = 2) -> Transport:
        return Transport(
            base_url="https://ingest.test.aforo.ai",
            api_key="test-key",
            timeout=5.0,
            max_retries=max_retries,
            retry_base_s=0.01,  # Fast for tests
        )

    @patch("aforo.transport.httpx.Client")
    def test_send_success(self, mock_client_cls):
        mock_resp = MagicMock()
        mock_resp.status_code = 202
        mock_client = MagicMock()
        mock_client.post.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client_cls.return_value = mock_client

        t = self._transport()
        result = t.send_sync(_events(3))

        assert result.sent == 3
        assert result.failed == 0

    @patch("aforo.transport.httpx.Client")
    def test_no_retry_on_400(self, mock_client_cls):
        mock_resp = MagicMock()
        mock_resp.status_code = 400
        mock_client = MagicMock()
        mock_client.post.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client_cls.return_value = mock_client

        t = self._transport()
        result = t.send_sync(_events(1))

        assert result.sent == 0
        assert result.failed == 1
        assert mock_client.post.call_count == 1  # No retry

    @patch("aforo.transport.httpx.Client")
    def test_retry_on_500(self, mock_client_cls):
        mock_resp_500 = MagicMock()
        mock_resp_500.status_code = 500
        mock_resp_200 = MagicMock()
        mock_resp_200.status_code = 200
        mock_client = MagicMock()
        mock_client.post.side_effect = [mock_resp_500, mock_resp_500, mock_resp_200]
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client_cls.return_value = mock_client

        t = self._transport()
        result = t.send_sync(_events(1))

        assert result.sent == 1
        assert mock_client.post.call_count == 3

    @patch("aforo.transport.httpx.Client")
    def test_retry_on_429_with_retry_after(self, mock_client_cls):
        mock_resp_429 = MagicMock()
        mock_resp_429.status_code = 429
        mock_resp_429.headers = {"Retry-After": "1"}
        mock_resp_200 = MagicMock()
        mock_resp_200.status_code = 200
        mock_client = MagicMock()
        mock_client.post.side_effect = [mock_resp_429, mock_resp_200]
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client_cls.return_value = mock_client

        t = self._transport()
        result = t.send_sync(_events(1))

        assert result.sent == 1

    def test_empty_events(self):
        t = self._transport()
        result = t.send_sync([])
        assert result.sent == 0
        assert result.failed == 0

    @patch("aforo.transport.httpx.Client")
    def test_network_error_retry(self, mock_client_cls):
        mock_client = MagicMock()
        mock_resp_ok = MagicMock()
        mock_resp_ok.status_code = 200
        mock_client.post.side_effect = [httpx.ConnectError("refused"), mock_resp_ok]
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client_cls.return_value = mock_client

        t = self._transport()
        result = t.send_sync(_events(1))

        assert result.sent == 1
