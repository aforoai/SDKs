"""Ingest-contract guard (A+ delivery-guarantee prompt 7).

Validates the OBSERVED wire request (endpoint path + body shape) against
the shared, checked-in contract fixture at
``contract/ingest-contract.json`` — derived from the REAL usage-ingestor
controllers/DTOs, never from this SDK's own constants. A test that
asserts the SDK against its own endpoint constant has zero contract
coverage (2026-07-05 D1 incident).

python-agent is contracted to ``/v1/ingest/batch`` (IngestUsageEventRequest,
batch-wrapped). This guard locks the resolved path AND that every event
inside the batch carries the required top-level fields.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Dict, List, Tuple
from urllib.parse import urlparse

import pytest

from aforo_agent_metering import AforoAgentClient

MODULE_KEY = "python-agent"

FIXTURE_PATH = (
    Path(__file__).resolve().parents[2] / "contract" / "ingest-contract.json"
)
FIXTURE = json.loads(FIXTURE_PATH.read_text())


def _assert_required(obj: Dict[str, Any], field: str) -> None:
    assert field in obj, f"required field '{field}' missing from wire body"
    v = obj[field]
    assert v is not None, f"required field '{field}' is null"
    if isinstance(v, str):
        assert v.strip() != "", f"required field '{field}' is blank"


def assert_body_matches_contract(spec: Dict[str, Any], body: Any) -> None:
    """Shared assertion shape (all languages have an equivalent)."""
    assert body is not None
    if spec["cardinality"] == "batch-wrapped":
        # A bare array here is the /v1/ingest/async-batch shape — wrong
        # for this endpoint (2026-07-05 D1 bug).
        assert isinstance(body, dict), "batch body must be an object, not a bare array"
        events = body.get(spec["batchKey"])
        assert isinstance(events, list) and events, (
            f"batch body must carry non-empty '{spec['batchKey']}'"
        )
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
    else:  # pragma: no cover
        raise AssertionError(f"unhandled cardinality: {spec['cardinality']}")


def _client(**overrides: Any) -> AforoAgentClient:
    return AforoAgentClient(
        tenant_id="tenant_test",
        product_id="prod_ai_001",
        api_key="sk_agent_abc",
        ingestor_url="https://ingest.test.aforo.ai",
        flush_interval_sec=3600.0,
        **overrides,
    )


def _capturing_transport(status: int = 202, body: str = "") -> Tuple[
    List[Tuple[str, Dict[str, str], str]],
    Any,
]:
    """Return (captured_calls, post_fn) — the post_fn matches the
    :mod:`aforo_agent_metering.transport` PostFn signature."""
    captured: List[Tuple[str, Dict[str, str], str]] = []

    async def post_fn(url: str, headers: Dict[str, str], body_arg: str) -> Tuple[int, str]:
        captured.append((url, headers, body_arg))
        return status, body

    return captured, post_fn


@pytest.mark.asyncio
async def test_module_is_registered_in_fixture() -> None:
    sdk_entry = FIXTURE["sdks"].get(MODULE_KEY)
    assert sdk_entry is not None, (
        f"'{MODULE_KEY}' must be registered in contract/ingest-contract.json"
    )
    endpoint = sdk_entry["endpoint"]
    assert endpoint in FIXTURE["endpoints"], (
        f"registered endpoint '{endpoint}' has no spec"
    )


@pytest.mark.asyncio
async def test_posts_to_contracted_endpoint_with_contracted_body_shape() -> None:
    sdk_entry = FIXTURE["sdks"][MODULE_KEY]
    endpoint: str = sdk_entry["endpoint"]
    spec = FIXTURE["endpoints"][endpoint]

    captured, post_fn = _capturing_transport()
    client = _client(post_fn=post_fn)

    client.record_capability(
        capability_name="summarize_email",
        agent_id="agent_contract",
        customer_id="cust_1",
        session_id="sess_1",
        input_tokens=100,
        output_tokens=40,
        execution_duration_ms=42,
    )
    await client.flush()

    assert captured, "no wire request observed"
    url, headers, body = captured[0]
    assert urlparse(url).path == endpoint
    assert_body_matches_contract(spec, json.loads(body))
    # The API key travels as X-API-Key; no Authorization header is sent (the
    # ingestor accepts X-API-Key for every key, Bearer only for sk_live_/sk_test_).
    assert headers["X-API-Key"] == "sk_agent_abc"
    assert "Authorization" not in headers
    assert headers["X-Tenant-Id"] == "tenant_test"
    event = json.loads(body)["events"][0]
    assert event["productType"] == "AI_AGENT"
    assert event["occurredAt"].endswith("Z")


@pytest.mark.asyncio
async def test_capability_name_lands_in_metadata_snake_case() -> None:
    """metadata.capability_name (snake_case) is the key
    ProductTypeEventExtractor reads to fan out per-capability billing.
    Losing it silently degrades to metric-level rating."""
    captured, post_fn = _capturing_transport()
    client = _client(post_fn=post_fn)

    client.record_capability(
        capability_name="translate_document",
        agent_id="agt_007",
        customer_id="cust_x",
    )
    await client.flush()

    body = json.loads(captured[0][2])
    event = body["events"][0]
    metadata = event["metadata"]
    assert metadata["capability_name"] == "translate_document", (
        "snake_case capability_name missing — extractor won't fan out"
    )
    # camelCase parity keeps JS analytics consumers readable.
    assert metadata["capabilityName"] == "translate_document"
    # Product type must be stamped for the descriptor router.
    assert event["productType"] == "AI_AGENT"
    # Idempotency key is 'agent:{uuid}' — mirrors node-agent format.
    assert event["idempotencyKey"].startswith("agent:")


@pytest.mark.asyncio
async def test_batch_wrapper_never_a_bare_array() -> None:
    """The 2026-07-05 D1 regression: SDKs posted {events:[...]} to
    /v1/ingest/events (single-event endpoint) — every flush 400'd. The
    inverse mistake (bare array here) would also 400. Lock both."""
    captured, post_fn = _capturing_transport()
    client = _client(post_fn=post_fn)

    client.record_capability(capability_name="x", agent_id="a")
    await client.flush()

    parsed = json.loads(captured[0][2])
    assert isinstance(parsed, dict), (
        "/v1/ingest/batch expects an object body, not a bare array"
    )
    assert "events" in parsed
    assert isinstance(parsed["events"], list)


# ── Execution status (P6 item 13, 2026-09-30) ──────────────────────────


def test_execution_statuses_match_contract() -> None:
    """The SDK's canonical set is exactly the contract's list."""
    from aforo_agent_metering import EXECUTION_STATUSES

    canonical = FIXTURE["endpoints"]["/v1/ingest/batch"]["eventOptionalFields"][
        "executionStatus"
    ]["values"]
    assert sorted(EXECUTION_STATUSES) == sorted(canonical)


@pytest.mark.asyncio
async def test_execution_status_normalized_and_omitted_when_blank() -> None:
    captured, post_fn = _capturing_transport()
    client = _client(post_fn=post_fn)
    client.record_capability("c", "agt", execution_status=" partial ")
    client.record_capability("c", "agt", execution_status="BLOCKED")
    client.record_capability("c", "agt", execution_status="   ")
    client.record_capability("c", "agt", execution_status=None)
    client.record_capability("c", "agt")  # default stays SUCCESS
    await client.flush()

    events = [ev for _, _, body in captured for ev in json.loads(body)["events"]]
    assert [ev.get("executionStatus") for ev in events] == [
        "PARTIAL",
        "BLOCKED",
        None,
        None,
        "SUCCESS",
    ]
    assert "executionStatus" not in events[2]
    assert "executionStatus" not in events[3]


@pytest.mark.asyncio
async def test_unknown_execution_status_is_left_off_not_sent(caplog) -> None:
    # An unknown executionStatus makes the ingestor reject the WHOLE batch,
    # so the other events in it would be lost too.
    captured, post_fn = _capturing_transport()
    client = _client(post_fn=post_fn)
    client.record_capability("c", "agt", execution_status="PENDNG")
    client.record_capability("c", "agt", execution_status="VALIDATION_FAILED_EXTRA")
    client.record_capability("c", "agt", execution_status="SUCCESS")
    await client.flush()

    events = [ev for _, _, body in captured for ev in json.loads(body)["events"]]
    assert [ev.get("executionStatus") for ev in events] == [None, None, "SUCCESS"]
    assert "not an execution status" in caplog.text
