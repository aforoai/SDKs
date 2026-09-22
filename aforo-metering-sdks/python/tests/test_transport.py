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
    def test_sends_api_key_header_not_bearer(self, mock_client_cls):
        """The ingestor authenticates X-API-Key only; Bearer is parsed as a JWT and 401s."""
        mock_resp = MagicMock()
        mock_resp.status_code = 202
        mock_client = MagicMock()
        mock_client.post.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client_cls.return_value = mock_client

        self._transport().send_sync(_events(1))

        headers = mock_client.post.call_args.kwargs["headers"]
        assert headers["X-API-Key"] == "test-key"
        assert "Authorization" not in headers

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


def _mock_http(mock_client_cls, *responses):
    mock_client = MagicMock()
    mock_client.post.side_effect = list(responses)
    mock_client.__enter__ = MagicMock(return_value=mock_client)
    mock_client.__exit__ = MagicMock(return_value=False)
    mock_client_cls.return_value = mock_client
    return mock_client


def _resp(status, body=None, headers=None):
    r = MagicMock()
    r.status_code = status
    r.headers = headers or {}
    if body is None:
        r.json.side_effect = ValueError("no body")
    else:
        r.json.return_value = body
    return r


def _t(max_retries=2):
    return Transport(base_url="https://ingest.test", api_key="k", max_retries=max_retries, retry_base_s=0.01)


@patch("aforo.transport.httpx.Client")
def test_partial_failure_parsed_from_errors_message(mock_client_cls, caplog):
    _mock_http(mock_client_cls, _resp(202, {
        "accepted": 1, "duplicates": 0, "failed": 1,
        "errors": [{"index": 1, "message": "unknown metric"}],
    }))
    with caplog.at_level("WARNING", logger="aforo.transport"):
        result = _t().send_sync(_events(2))
    assert (result.sent, result.failed) == (1, 1)
    assert "unknown metric" in caplog.text


@patch("aforo.transport.httpx.Client")
def test_400_logs_errors_message_and_does_not_retry(mock_client_cls, caplog):
    client = _mock_http(mock_client_cls, _resp(400, {"errors": [{"index": 0, "message": "quantity must be positive"}]}))
    with caplog.at_level("WARNING", logger="aforo.transport"):
        result = _t().send_sync(_events(1))
    assert result.failed == 1
    assert client.post.call_count == 1
    assert "quantity must be positive" in caplog.text


@patch("aforo.transport.httpx.Client")
@patch("time.sleep")
def test_429_honours_retry_after_and_tolerates_http_date(mock_sleep, mock_client_cls):
    _mock_http(
        mock_client_cls,
        _resp(429, headers={"Retry-After": "7"}),
        _resp(429, headers={"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}),
        _resp(202, {"accepted": 1, "failed": 0}),
    )
    result = _t().send_sync(_events(1))
    assert result.sent == 1
    assert mock_sleep.call_args_list[0].args[0] == 7.0
    assert mock_sleep.call_args_list[1].args[0] == pytest.approx(0.02)


@patch("aforo.transport.httpx.Client")
def test_408_is_retried(mock_client_cls):
    client = _mock_http(mock_client_cls, _resp(408), _resp(202))
    assert _t().send_sync(_events(1)).sent == 1
    assert client.post.call_count == 2


def test_event_wire_format_has_product_type_and_extra_fields():
    e = ResolvedEvent(
        customer_id="c", metric_name="m", quantity=1, idempotency_key="k",
        occurred_at="2026-03-21T00:00:00Z", product_type="API",
        extra_fields={"endpointPath": "/x", "customerId": "ignored", "statusCode": None},
    )
    d = e.to_dict()
    assert d["productType"] == "API"
    assert d["endpointPath"] == "/x"
    assert d["customerId"] == "c"
    assert "statusCode" not in d


@patch("aforo.transport.httpx.Client")
def test_send_heartbeat_single_event_request_no_retry(mock_client_cls):
    client = _mock_http(mock_client_cls, _resp(503))
    hb = _events(1)[0]
    assert _t().send_heartbeat(hb) is None
    assert client.post.call_count == 1
    body = client.post.call_args.kwargs["json"]
    assert body == {"events": [hb.to_dict()]}
    assert client.post.call_args.kwargs["headers"]["X-API-Key"] == "k"
    assert "Authorization" not in client.post.call_args.kwargs["headers"]


@patch("aforo.transport.httpx.Client")
def test_send_heartbeat_swallows_errors_and_returns_body(mock_client_cls):
    _mock_http(mock_client_cls, httpx.ConnectError("refused"))
    assert _t().send_heartbeat(_events(1)[0]) is None
    _mock_http(mock_client_cls, _resp(202, {"accepted": 0, "killedSessionIds": ["s1"]}))
    assert _t().send_heartbeat(_events(1)[0]) == {"accepted": 0, "killedSessionIds": ["s1"]}
