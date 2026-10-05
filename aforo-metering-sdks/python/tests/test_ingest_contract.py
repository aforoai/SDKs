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

from unittest import mock

from aforo.client import AforoClient

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


class _CapturingClient:
    """Stand-in for httpx.Client that records the POST and returns 202."""

    captured: list = []

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def post(self, url, json=None, headers=None):
        _CapturingClient.captured.append((url, json, headers))
        resp = mock.MagicMock()
        resp.status_code = 202
        return resp


def test_posts_to_contracted_endpoint_with_contracted_body_shape():
    sdk_entry = FIXTURE["sdks"].get(MODULE_KEY)
    assert sdk_entry is not None, "module must be registered in the fixture"
    endpoint = sdk_entry["endpoint"]
    spec = FIXTURE["endpoints"][endpoint]

    _CapturingClient.captured = []
    with mock.patch("aforo.transport.httpx.Client", _CapturingClient):
        client = AforoClient(
            api_key="test-key",
            base_url="https://ingest.test.aforo.ai",
            flush_count=50,
            max_retries=0,
        )
        client.track(customer_id="cust_contract", metric_name="api_calls", quantity=1)
        client.flush()
        client.shutdown()

    assert _CapturingClient.captured, "no wire request observed"
    url, body, _headers = _CapturingClient.captured[0]
    assert urlparse(str(url)).path == endpoint
    assert_body_matches_contract(spec, body)


def test_execution_status_is_contracted_optional_field_sent_only_when_set():
    spec = FIXTURE["endpoints"][FIXTURE["sdks"][MODULE_KEY]["endpoint"]]
    status_spec = spec["eventOptionalFields"]["executionStatus"]

    _CapturingClient.captured = []
    with mock.patch("aforo.transport.httpx.Client", _CapturingClient):
        client = AforoClient(
            api_key="test-key",
            base_url="https://ingest.test.aforo.ai",
            flush_count=50,
            max_retries=0,
        )
        client.track(customer_id="cust_contract", metric_name="api_calls", execution_status="timeout")
        client.track(customer_id="cust_contract", metric_name="api_calls")
        client.flush()
        client.shutdown()

    assert _CapturingClient.captured, "no wire request observed"
    _url, body, _headers = _CapturingClient.captured[0]
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

    _CapturingClient.captured = []
    with mock.patch("aforo.transport.httpx.Client", _CapturingClient):
        client = AforoClient(
            api_key="test-key",
            base_url="https://ingest.test.aforo.ai",
            flush_count=50,
            max_retries=0,
        )
        client.track(customer_id="cust_contract", metric_name="api_calls", execution_status="bogus")
        client.track(customer_id="cust_contract", metric_name="api_calls", execution_status="X" * 25)
        client.track(customer_id="cust_contract", metric_name="api_calls", execution_status="success")
        client.flush()
        client.shutdown()

    _url, body, _headers = _CapturingClient.captured[0]
    assert_body_matches_contract(spec, body)
    bogus, too_long, ok = body[spec["batchKey"]]
    assert "executionStatus" not in bogus
    assert "executionStatus" not in too_long
    assert bogus["customerId"] == "cust_contract" and bogus["metricName"] == "api_calls"
    assert ok["executionStatus"] == "SUCCESS"
