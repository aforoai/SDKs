"""Ingest-contract guard (A+ delivery-guarantee prompt 7).

Validates the OBSERVED wire request (endpoint path + body shape) against the
shared, checked-in contract fixture at contract/ingest-contract.json — which
is derived from the REAL usage-ingestor controllers/DTOs, never from this
SDK's own constants. A test that asserts the SDK against the SDK's own
endpoint constant has zero contract coverage (the 2026-07-05 D1 incident:
16 variant SDKs posted a batch body to a single-event endpoint, every flush
400'd, and green suites hid 100% event loss).
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlparse


from aforo.client import AforoClient
from .gzip_body import request_bytes

MODULE_KEY = "python"

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "contract" / "ingest-contract.json").read_text()
)


def _assert_required(obj: dict, field: str) -> None:
    assert field in obj, f"required field '{field}' missing from wire body"
    v = obj[field]
    assert v is not None, f"required field '{field}' is null"
    if isinstance(v, str):
        assert v.strip() != "", f"required field '{field}' is blank"


def assert_body_matches_contract(spec: dict, body) -> None:
    """Same assertion shape in every SDK suite (all languages)."""
    assert body is not None
    if spec["cardinality"] == "batch-wrapped":
        # A bare array here is the /v1/ingest/async-batch shape — wrong for this endpoint.
        assert isinstance(body, dict), "batch body must be an object, not a bare array"
        events = body.get(spec["batchKey"])
        assert isinstance(events, list) and events, f"batch body must carry non-empty '{spec['batchKey']}'"
        assert len(events) <= spec["maxEvents"]
        for ev in events:
            for field in spec["eventRequiredFields"]:
                _assert_required(ev, field)
    elif spec["cardinality"] == "single":
        assert isinstance(body, dict)
        for key in spec.get("forbiddenTopLevelKeys", []):
            assert key not in body, f"single-event body must not carry '{key}'"
        for field in spec["requiredFields"]:
            _assert_required(body, field)
    else:
        raise AssertionError(f"unhandled cardinality in fixture: {spec['cardinality']}")


class _Capture:
    """httpx transport that records each POST and answers 202."""

    captured: list = []

    @classmethod
    def transport(cls):
        import httpx

        def handle(request):
            body = json.loads(request_bytes(request))
            cls.captured.append((str(request.url), body, dict(request.headers)))
            return httpx.Response(202, json={"data": {"accepted": len(body["events"]), "failed": 0}})

        return httpx.MockTransport(handle)


def _capturing_client():
    _Capture.captured = []
    return AforoClient(api_key="test-key", base_url="https://ingest.example.test",
                       flush_count=50, max_retries=0, http_transport=_Capture.transport())


def test_posts_to_contracted_endpoint_with_contracted_body_shape():
    sdk_entry = FIXTURE["sdks"].get(MODULE_KEY)
    assert sdk_entry is not None, "module must be registered in the fixture"
    endpoint = sdk_entry["endpoint"]
    spec = FIXTURE["endpoints"][endpoint]

    if True:
        client = _capturing_client()
        client.track(customer_id="cust_contract", metric_name="api_calls", quantity=1)
        client.flush()
        client.shutdown()

    assert _Capture.captured, "no wire request observed"
    url, body, _headers = _Capture.captured[0]
    assert urlparse(str(url)).path == endpoint
    assert_body_matches_contract(spec, body)


def test_execution_status_is_contracted_optional_field_sent_only_when_set():
    spec = FIXTURE["endpoints"][FIXTURE["sdks"][MODULE_KEY]["endpoint"]]
    status_spec = spec["eventOptionalFields"]["executionStatus"]

    if True:
        client = _capturing_client()
        client.track(customer_id="cust_contract", metric_name="api_calls", execution_status="timeout")
        client.track(customer_id="cust_contract", metric_name="api_calls")
        client.flush()
        client.shutdown()

    assert _Capture.captured, "no wire request observed"
    _url, body, _headers = _Capture.captured[0]
    assert_body_matches_contract(spec, body)
    with_status, without_status = body[spec["batchKey"]]
    assert with_status["executionStatus"] == "TIMEOUT"
    assert with_status["executionStatus"] in status_spec["values"]
    assert len(with_status["executionStatus"]) <= status_spec["maxLength"]
    assert "executionStatus" not in without_status


def test_canonical_statuses_match_contract():
    from aforo.types import EXECUTION_STATUSES, normalize_execution_status

    spec = FIXTURE["endpoints"][FIXTURE["sdks"][MODULE_KEY]["endpoint"]]
    status_spec = spec["eventOptionalFields"]["executionStatus"]
    assert EXECUTION_STATUSES == frozenset(status_spec["values"])
    for v in status_spec["values"]:
        assert len(v) <= status_spec["maxLength"]
        assert normalize_execution_status(v.lower()) == v


def test_unknown_execution_status_is_left_off_and_batch_still_valid():
    spec = FIXTURE["endpoints"][FIXTURE["sdks"][MODULE_KEY]["endpoint"]]

    if True:
        client = _capturing_client()
        client.track(customer_id="cust_contract", metric_name="api_calls", execution_status="bogus")
        client.track(customer_id="cust_contract", metric_name="api_calls", execution_status="X" * 25)
        client.track(customer_id="cust_contract", metric_name="api_calls", execution_status="success")
        client.flush()
        client.shutdown()

    _url, body, _headers = _Capture.captured[0]
    assert_body_matches_contract(spec, body)
    bogus, too_long, ok = body[spec["batchKey"]]
    assert "executionStatus" not in bogus
    assert "executionStatus" not in too_long
    assert bogus["customerId"] == "cust_contract" and bogus["metricName"] == "api_calls"
    assert ok["executionStatus"] == "SUCCESS"


def test_transport_defaults_match_the_contract_policy():
    """Every number the transport uses comes from transportPolicy."""
    from aforo._transport import policy
    from aforo.types import AforoOptions

    tp = FIXTURE["transportPolicy"]
    assert tp["endpoint"] == policy.INGEST_PATH
    assert tp["batch"]["defaultEvents"] == policy.DEFAULT_FLUSH_COUNT == AforoOptions(api_key="k").flush_count
    assert tp["batch"]["maxEvents"] == policy.MAX_BATCH_EVENTS
    assert tp["batch"]["targetRequestBodyBytes"] == policy.TARGET_REQUEST_BODY_BYTES
    assert tp["batch"]["maxRequestBodyBytes"] == policy.MAX_REQUEST_BODY_BYTES
    assert tp["queue"]["defaultCapacity"] == policy.DEFAULT_QUEUE_CAPACITY == AforoOptions(api_key="k").max_queue_size
    assert tp["timeouts"]["requestMs"] / 1000 == policy.REQUEST_TIMEOUT_S == AforoOptions(api_key="k").timeout
    assert tp["timeouts"]["connectMs"] / 1000 == policy.CONNECT_TIMEOUT_S
    assert tp["timeouts"]["shutdownMs"] / 1000 == policy.SHUTDOWN_TIMEOUT_S == AforoOptions(api_key="k").shutdown_timeout
    retry = tp["retry"]
    assert retry["maxRetries"] == policy.MAX_RETRIES == AforoOptions(api_key="k").max_retries
    assert retry["baseMs"] / 1000 == policy.RETRY_BASE_S == AforoOptions(api_key="k").retry_base_s
    assert retry["maxDelayMs"] / 1000 == policy.RETRY_MAX_DELAY_S
    assert retry["retryAfter"]["maxMs"] / 1000 == policy.RETRY_AFTER_MAX_S
    assert set(retry["retryOnStatus"]) == set(policy.RETRY_STATUSES) | set(policy.RETRY_STATUS_CLASSES)
    assert all(policy.is_retry_status(s) for s in (408, 429, 500, 501, 502, 503, 504, 505, 599))
    assert not any(policy.is_retry_status(s) for s in (301, 400, 401, 404, 413, 422))
    assert set(retry["splitOnStatus"]) == set(policy.SPLIT_STATUSES)
    assert set(retry["authFailureStatus"]) == set(policy.AUTH_FAILURE_STATUSES)
    breaker = tp["afterRetriesExhausted"]["breakerCooldownMs"]
    assert breaker["floor"] / 1000 == policy.BREAKER_FLOOR_S
    assert breaker["initial"] / 1000 == policy.BREAKER_INITIAL_S
    assert breaker["max"] / 1000 == policy.BREAKER_MAX_S
    assert breaker["multiplier"] == policy.BREAKER_MULTIPLIER
    assert tp["compression"]["gzip"] is policy.GZIP is True
    assert tp["compression"]["minBytes"] == policy.COMPRESSION_MIN_BYTES
    assert set(tp["security"]["plainHttpAllowedHosts"]) == set(policy.PLAIN_HTTP_HOSTS)
    assert tuple(tp["dropReasons"]) == policy.DROP_REASONS


def test_wire_request_carries_contract_headers_and_no_content_encoding():
    client = _capturing_client()
    client.track(customer_id="cust_contract", metric_name="api_calls")
    client.flush()
    client.shutdown()
    _url, _body, headers = _Capture.captured[0]
    assert headers["content-type"] == "application/json"
    assert headers["x-api-key"] == "test-key"
    assert "content-encoding" not in headers
    assert "authorization" not in headers
    assert headers["user-agent"].startswith("aforo-python/")
