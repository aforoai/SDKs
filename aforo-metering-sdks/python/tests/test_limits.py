"""The ingestor's compiled-in field limits, enforced before an event is buffered.

An event that breaks one is rejected server-side and never billed; since the SDK
flushes in the background, that rejection reaches nobody. These tests pin that
the caller is told at track() instead — and that limits the server makes
configurable are deliberately left to the server.
"""

import pytest

from aforo.client import AforoClient
from aforo.limits import MAX_LENGTHS, describe_limit_violation


def _client():
    # base_url points at a closed port: these tests assert on what is buffered,
    # and the shutdown flush must never reach a real ingestor.
    return AforoClient(
        api_key="sk_test_limits",
        base_url="http://127.0.0.1:1",
        flush_count=1_000_000,
        flush_interval=1_000_000,
        max_retries=0,
    )


def _valid():
    return {"customer_id": "cust_1", "metric_name": "api_calls", "quantity": 1}


@pytest.mark.parametrize(
    "field,kwarg",
    [("customerId", "customer_id"), ("metricName", "metric_name"), ("idempotencyKey", "idempotency_key")],
)
def test_string_length_limit(field, kwarg):
    limit = MAX_LENGTHS[field]
    client = _client()

    client.track(**{**_valid(), kwarg: "x" * limit})
    assert client._buffer.size == 1

    with pytest.raises(ValueError, match=field):
        client.track(**{**_valid(), kwarg: "x" * (limit + 1)})
    assert client._buffer.size == 1, "the rejected event must not be buffered"


def test_quantity_decimal_places_rejected_not_rounded():
    client = _client()
    with pytest.raises(ValueError, match="decimal places"):
        client.track(**{**_valid(), "quantity": 1.1234567})
    assert client._buffer.size == 0


def test_quantity_at_six_decimal_places_accepted():
    client = _client()
    client.track(**{**_valid(), "quantity": 1.123456})
    assert client._buffer.size == 1


def test_quantity_integer_digits_rejected():
    client = _client()
    with pytest.raises(ValueError, match="integer digits"):
        client.track(**{**_valid(), "quantity": 10**15})
    assert client._buffer.size == 0


def test_malformed_occurred_at_rejected():
    client = _client()
    with pytest.raises(ValueError, match="ISO-8601"):
        client.track(**{**_valid(), "occurred_at": "last tuesday"})
    assert client._buffer.size == 0


def test_server_configurable_limits_left_to_the_server():
    # max-age-days, future-tolerance-minutes and max-metadata-bytes are
    # per-environment properties. Enforcing their defaults here would make the
    # SDK refuse usage a deployment configured differently would accept and bill.
    client = _client()
    client.track(**{**_valid(), "occurred_at": "2020-01-01T00:00:00Z"})
    client.track(**{**_valid(), "metadata": {"blob": "x" * 20_000}})
    assert client._buffer.size == 2


def test_rejected_event_leaves_buffered_events_alone():
    client = _client()
    client.track(**{**_valid(), "customer_id": "cust_1"})
    with pytest.raises(ValueError):
        client.track(**{**_valid(), "customer_id": "c" * 65})
    client.track(**{**_valid(), "customer_id": "cust_3"})

    assert client._buffer.size == 2


def test_describe_limit_violation_names_field_limit_and_size():
    violation = describe_limit_violation({"customerId": "c" * 65})
    assert "customerId" in violation and "65" in violation and "64" in violation

    assert describe_limit_violation(
        {"customerId": "cust_1", "metricName": "api_calls", "quantity": 1,
         "occurredAt": "2026-09-29T10:00:00Z"}
    ) is None
