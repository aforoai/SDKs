"""The operation name comes from the client's query. An over-long one is cut to
the ingestor's 255-character limit and the event is still sent; caller-set
fields still drop the event as ``invalid``."""

from __future__ import annotations

import logging

import pytest

from aforo_graphql_metering import client as mod
from aforo_graphql_metering.client import (
    AforoGraphQlBilling,
    _fit_idempotency_key,
    _sha256_hex,
    _truncate_utf16,
    _utf16_length,
)

ASTRAL = "\U0001F600"


@pytest.fixture
def sent(monkeypatch):
    batches: list = []

    def post(url, body, headers):
        batches.append(body["events"])
        return 202, None, b""

    monkeypatch.setattr(mod, "_post_json", post)
    return batches


def _billing(**kwargs):
    return AforoGraphQlBilling(
        tenant_id="tenant-001", product_id="prod-gql-001", api_key="k",
        ingestor_url="https://api.aforo.ai", flush_interval_sec=3600, flush_count=1000, **kwargs,
    )


def _record(b, name, customer_id="cust_1"):
    b.record(customer_id=customer_id, query=f"query {name} {{ a }}", operation_name=name,
             duration_ms=1, has_errors=False)


def test_truncate_utf16_never_splits_a_surrogate_pair():
    text = "a" * 254 + ASTRAL
    assert _truncate_utf16(text, 255) == "a" * 254
    assert _truncate_utf16("a" * 253 + ASTRAL, 255) == "a" * 253 + ASTRAL
    assert _utf16_length(_truncate_utf16(ASTRAL * 200, 255)) == 254


def test_over_long_operation_name_is_truncated_and_event_is_sent(sent, caplog):
    drops: list = []
    b = _billing(on_drop=lambda evs, reason: drops.append(reason))
    first, second = "A" * 300, "A" * 255 + "B" * 45  # share the first 255 characters
    with caplog.at_level(logging.WARNING, logger="aforo_graphql_metering"):
        _record(b, first)
        _record(b, second)
    b.shutdown()

    events = [e for batch in sent for e in batch]
    assert len(events) == 2 and drops == [] and b.dropped_count == 0
    assert all(e["gqlOperationName"] == "A" * 255 for e in events)
    warnings = [r for r in caplog.records if "truncated" in r.getMessage()]
    assert len(warnings) == 1 and "gqlOperationName" in warnings[0].getMessage()

    for event, full in zip(events, (first, second)):
        key = event["idempotencyKey"]
        assert len(key) <= 255
        _, tenant, product, name_part, millis, nonce = key.split(":")
        # Built from the full name, before truncation: the over-long name is in
        # the key as its SHA-256 digest, not as the truncated label.
        assert name_part == _sha256_hex(full)
        assert key == _fit_idempotency_key(["gql", tenant, product, full, millis, nonce], (3,))
    assert events[0]["idempotencyKey"].split(":")[3] != events[1]["idempotencyKey"].split(":")[3]


def test_key_is_deterministic_and_unchanged_when_it_fits():
    parts = ["gql", "tenant-001", "prod-gql-001", "MyOp", 1700000000000, "abcd1234"]
    assert _fit_idempotency_key(parts, (3,)) == "gql:tenant-001:prod-gql-001:MyOp:1700000000000:abcd1234"
    long_a = ["gql", "t", "p", "A" * 300, 1, "n"]
    long_b = ["gql", "t", "p", "A" * 299 + "B", 1, "n"]
    assert _fit_idempotency_key(long_a, (3,)) == _fit_idempotency_key(list(long_a), (3,))
    assert _fit_idempotency_key(long_a, (3,)) != _fit_idempotency_key(long_b, (3,))
    assert len(_fit_idempotency_key(long_a, (3,))) <= 255
    # Still too long after hashing the request-derived part: digest of the whole key.
    huge = ["gql", "t" * 300, "p", "op", 1, "n"]
    assert _fit_idempotency_key(huge, (3,)) == "gql:" + _sha256_hex(":".join(str(p) for p in huge))


def test_over_long_customer_id_still_dropped_as_invalid(sent):
    drops: list = []
    b = _billing(on_drop=lambda evs, reason: drops.append((evs, reason)))
    _record(b, "MyOp", customer_id="c" * 65)
    b.shutdown()
    assert sent == [] and b.dropped_count == 1
    assert [reason for _evs, reason in drops] == ["invalid"]
    assert drops[0][0][0]["customerId"] == "c" * 65  # not altered
