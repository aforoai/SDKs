"""Ingest-contract guard (A+ delivery-guarantee prompt 7).

Validates the OBSERVED wire request (endpoint path + body shape) against the
shared, checked-in contract fixture at contract/ingest-contract.json — which
is derived from the REAL usage-ingestor controllers/DTOs, never from this
SDK's own constants. A test that asserts the SDK against the SDK's own
endpoint constant has zero contract coverage (2026-07-05 D1 incident).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from urllib.parse import urlparse

from aforo_mcp_metering.client import AforoMcpBilling

MODULE_KEY = "python-mcp"

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


def test_posts_to_contracted_endpoint_with_contracted_body_shape():
    sdk_entry = FIXTURE["sdks"].get(MODULE_KEY)
    assert sdk_entry is not None, "module must be registered in the fixture"
    endpoint = sdk_entry["endpoint"]
    spec = FIXTURE["endpoints"][endpoint]

    billing = AforoMcpBilling(
        tenant_id="tenant_test",
        product_id="prod_mcp_001",
        api_key="sk_mcp_abc",
        ingestor_url="https://ingest.test.aforo.ai",
        heartbeat_enabled=False,
    )

    captured: list = []

    async def capturing_post(url, headers, body):
        captured.append((url, headers, body))
        return 202, ""

    # Intercept at the SDK's own HTTP seam — the URL and serialized body it
    # passes here are exactly what would hit the wire.
    billing._do_post_with_body = capturing_post  # type: ignore[method-assign]

    billing.record_tool_invocation(
        "search_documents", "agent_contract", "sess_1", "SUCCESS", 42
    )
    asyncio.run(billing.flush())

    assert captured, "no wire request observed"
    url, _headers, body = captured[0]
    assert urlparse(str(url)).path == endpoint
    assert_body_matches_contract(spec, json.loads(body))
