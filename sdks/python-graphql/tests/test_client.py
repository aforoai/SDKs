"""Tests for aforo_graphql_metering.client.AforoGraphQlBilling.

Unique bits vs. gRPC family canary:
  - AST-accurate complexity scoring via graphql-core's visit()
  - Operation type detection (QUERY / MUTATION / SUBSCRIPTION)
  - Anonymous operation handling
"""

from __future__ import annotations

import json
import time
from typing import List
from unittest import mock

import pytest
from graphql import parse

from aforo_graphql_metering.client import (
    AforoGraphQlBilling,
    default_complexity_scorer,
)


# ── Shared HTTP collector (same pattern as the gRPC test) ────────────────


class FakeHttp:
    def __init__(self, status: int = 204):
        self.status = status
        self.requests: List[dict] = []

    def urlopen(self, req, timeout=None):
        body = req.data.decode("utf-8") if req.data else ""
        self.requests.append({
            "url": req.full_url,
            "headers": dict(req.header_items()),
            "body": json.loads(body) if body else {},
        })
        outer = self.status

        class _R:
            status = outer
            def __enter__(self_i): return self_i
            def __exit__(self_i, *_a): return False
            def read(self_i): return b""

        return _R()


@pytest.fixture
def http(monkeypatch):
    from aforo_graphql_metering import client as mod
    monkeypatch.setattr(mod, "HAS_HTTPX", False, raising=False)
    c = FakeHttp()
    with mock.patch("urllib.request.urlopen", side_effect=c.urlopen):
        yield c


@pytest.fixture
def cfg():
    return dict(
        tenant_id="tenant-001",
        product_id="prod-gql-001",
        api_key="sk_gql_abc",
        ingestor_url="https://ingestor.aforo.ai",
        schema_version="v2.1",
    )


def wait_until(pred, timeout=1.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return
        time.sleep(0.01)
    raise AssertionError("timeout")


# ── Complexity scoring ──────────────────────────────────────────────────


def test_complexity_flat_query():
    doc = parse("{ a b c }")
    score, fc = default_complexity_scorer(doc)
    assert fc == 3
    assert score == 3 + 5 * 1  # 3 fields at depth 1


def test_complexity_nested_query():
    doc = parse("{ user { profile { name email } } }")
    score, fc = default_complexity_scorer(doc)
    assert fc == 4
    assert score == 4 + 5 * 3  # 4 fields, depth 3


def test_complexity_mutation():
    doc = parse("mutation Create { createUser { id } }")
    score, fc = default_complexity_scorer(doc)
    assert fc == 2
    assert score > 0


# ── record() happy path + shape ─────────────────────────────────────────


def test_record_emits_event_shape(http, cfg):
    b = AforoGraphQlBilling(**cfg, flush_count=1, flush_interval_sec=60)
    b.record(
        customer_id="cust_001",
        query="query GetUser { user { id } }",
        operation_name="GetUser",
        duration_ms=14,
        has_errors=False,
    )
    wait_until(lambda: len(http.requests) == 1)

    ev = http.requests[0]["body"]["events"][0]
    assert ev["productType"] == "GRAPHQL_API"
    assert ev["gqlOperationType"] == "QUERY"
    assert ev["gqlOperationName"] == "GetUser"
    assert ev["gqlHasErrors"] is False
    assert ev["executionDurationMs"] == 14
    assert ev["customerId"] == "cust_001"
    assert ev["metadata"]["schemaVersion"] == "v2.1"
    assert ev["metricName"] == "graphql_api.operations"
    b.shutdown()


def test_record_detects_anonymous_operation(http, cfg):
    b = AforoGraphQlBilling(**cfg, flush_count=1, flush_interval_sec=60)
    b.record(
        customer_id="cust_001",
        query="{ user { id } }",
        operation_name=None,
        duration_ms=5,
        has_errors=False,
    )
    wait_until(lambda: len(http.requests) == 1)
    ev = http.requests[0]["body"]["events"][0]
    assert ev["gqlOperationType"] == "QUERY"
    assert ev["gqlOperationName"] == "anonymous"
    b.shutdown()


def test_record_detects_mutation(http, cfg):
    b = AforoGraphQlBilling(**cfg, flush_count=1, flush_interval_sec=60)
    b.record(
        customer_id="cust_001",
        query="mutation DoThing { createUser { id } }",
        operation_name="DoThing",
        duration_ms=5,
        has_errors=False,
    )
    wait_until(lambda: len(http.requests) == 1)
    assert http.requests[0]["body"]["events"][0]["gqlOperationType"] == "MUTATION"
    b.shutdown()


def test_record_detects_subscription(http, cfg):
    b = AforoGraphQlBilling(**cfg, flush_count=1, flush_interval_sec=60)
    b.record(
        customer_id="cust_001",
        query="subscription OnNew { newUser { id } }",
        operation_name="OnNew",
        duration_ms=5,
        has_errors=False,
    )
    wait_until(lambda: len(http.requests) == 1)
    assert http.requests[0]["body"]["events"][0]["gqlOperationType"] == "SUBSCRIPTION"
    b.shutdown()


def test_invalid_query_silently_dropped(http, cfg):
    b = AforoGraphQlBilling(**cfg, flush_count=1, flush_interval_sec=60)
    # Must not raise
    b.record(
        customer_id="cust_001",
        query="{ this is not valid",
        operation_name=None,
        duration_ms=5,
        has_errors=False,
    )
    b.shutdown()
    assert http.requests == []


def test_no_customer_id_silently_dropped(http, cfg):
    b = AforoGraphQlBilling(**cfg, flush_count=1, flush_interval_sec=60)
    b.record(
        customer_id="",
        query="{ a }",
        operation_name=None,
        duration_ms=5,
        has_errors=False,
    )
    b.shutdown()
    assert http.requests == []


def test_has_errors_is_forwarded(http, cfg):
    b = AforoGraphQlBilling(**cfg, flush_count=1, flush_interval_sec=60)
    b.record(
        customer_id="cust_001",
        query="{ a }",
        operation_name=None,
        duration_ms=5,
        has_errors=True,
    )
    wait_until(lambda: len(http.requests) == 1)
    assert http.requests[0]["body"]["events"][0]["gqlHasErrors"] is True
    b.shutdown()


def test_idempotency_key_format(http, cfg):
    import re
    b = AforoGraphQlBilling(**cfg, flush_count=1, flush_interval_sec=60)
    b.record(
        customer_id="cust_001",
        query="query MyOp { a }",
        operation_name="MyOp",
        duration_ms=5,
        has_errors=False,
    )
    wait_until(lambda: len(http.requests) == 1)
    key = http.requests[0]["body"]["events"][0]["idempotencyKey"]
    assert re.match(r"^gql:tenant-001:prod-gql-001:MyOp:\d+:[0-9a-f]{8}$", key)
    b.shutdown()


def test_shutdown_flushes_pending(http, cfg):
    b = AforoGraphQlBilling(**cfg, flush_count=100, flush_interval_sec=60)
    for i in range(3):
        b.record(
            customer_id="cust_001",
            query=f"{{ a{i} }}",
            operation_name=None,
            duration_ms=5,
            has_errors=False,
        )
    b.shutdown()
    assert len(http.requests) == 1
    assert len(http.requests[0]["body"]["events"]) == 3
