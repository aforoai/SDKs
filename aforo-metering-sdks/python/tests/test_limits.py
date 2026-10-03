"""The ingestor's compiled-in field limits, enforced before an event is buffered.

An event that breaks one is rejected server-side and never billed; since the SDK
flushes in the background, that rejection reaches nobody. These tests pin that
track() refuses such an event before buffering it — without raising: it is
counted in dropped_count and handed to on_drop with reason "invalid" — and that
limits the server makes configurable are deliberately left to the server.
"""

import pytest

from aforo.client import AforoClient
from aforo.limits import MAX_LENGTHS, describe_limit_violation


def _client(drops=None):
    # base_url points at a closed port: these tests assert on what is buffered,
    # and the shutdown flush must never reach a real ingestor.
    return AforoClient(
        api_key="sk_test_limits",
        base_url="http://127.0.0.1:1",
        flush_count=1_000_000,
        flush_interval=1_000_000,
        max_retries=0,
        on_drop=(lambda events, reason: drops.append((events, reason))) if drops is not None else None,
    )


def _assert_invalid_drop(client, drops, before=0):
    assert client.dropped_count == before + 1
    events, reason = drops[-1]
    assert reason == "invalid"
    assert len(events) == 1 and events[0].idempotency_key


def _valid():
    return {"customer_id": "cust_1", "metric_name": "api_calls", "quantity": 1}


@pytest.mark.parametrize(
    "field,kwarg",
    [("customerId", "customer_id"), ("metricName", "metric_name"), ("idempotencyKey", "idempotency_key")],
)
def test_string_length_limit(field, kwarg, caplog):
    limit = MAX_LENGTHS[field]
    drops = []
    client = _client(drops)

    client.track(**{**_valid(), kwarg: "x" * limit})
    assert client._buffer.size == 1
    assert client.dropped_count == 0

    with caplog.at_level("WARNING", logger="aforo.client"):
        client.track(**{**_valid(), kwarg: "x" * (limit + 1)})  # must not raise
    assert client._buffer.size == 1, "the invalid event must not be buffered"
    _assert_invalid_drop(client, drops)
    assert field in caplog.text and str(limit) in caplog.text


def test_quantity_decimal_places_rejected_not_rounded(caplog):
    drops = []
    client = _client(drops)
    with caplog.at_level("WARNING", logger="aforo.client"):
        client.track(**{**_valid(), "quantity": 1.1234567})
    assert client._buffer.size == 0
    _assert_invalid_drop(client, drops)
    assert "decimal places" in caplog.text
    assert drops[-1][0][0].quantity == 1.1234567


def test_quantity_at_six_decimal_places_accepted():
    client = _client()
    client.track(**{**_valid(), "quantity": 1.123456})
    assert client._buffer.size == 1


def test_quantity_integer_digits_rejected(caplog):
    drops = []
    client = _client(drops)
    with caplog.at_level("WARNING", logger="aforo.client"):
        client.track(**{**_valid(), "quantity": 10**15})
    assert client._buffer.size == 0
    _assert_invalid_drop(client, drops)
    assert "integer digits" in caplog.text


def test_malformed_occurred_at_rejected(caplog):
    drops = []
    client = _client(drops)
    with caplog.at_level("WARNING", logger="aforo.client"):
        client.track(**{**_valid(), "occurred_at": "last tuesday"})
    assert client._buffer.size == 0
    _assert_invalid_drop(client, drops)
    assert "ISO-8601" in caplog.text


def test_server_configurable_limits_left_to_the_server():
    # max-age-days, future-tolerance-minutes and max-metadata-bytes are
    # per-environment properties. Enforcing their defaults here would make the
    # SDK refuse usage a deployment configured differently would accept and bill.
    client = _client()
    client.track(**{**_valid(), "occurred_at": "2020-01-01T00:00:00Z"})
    client.track(**{**_valid(), "metadata": {"blob": "x" * 20_000}})
    assert client._buffer.size == 2


def test_rejected_event_leaves_buffered_events_alone():
    drops = []
    client = _client(drops)
    client.track(**{**_valid(), "customer_id": "cust_1"})
    client.track(**{**_valid(), "customer_id": "c" * 65})
    client.track(**{**_valid(), "customer_id": "cust_3"})

    assert client._buffer.size == 2
    _assert_invalid_drop(client, drops)


def test_extra_field_limits_mirror_the_server_dto():
    assert MAX_LENGTHS == {
        "customerId": 64, "metricName": 255, "idempotencyKey": 255, "productType": 20,
        "traceId": 128, "spanId": 32, "sessionId": 64, "agentId": 36, "toolName": 64,
        "capabilityName": 64, "subscriptionId": 64, "endpointPath": 512, "httpMethod": 16,
        "grpcService": 255, "grpcMethod": 128, "gqlOperationName": 255,
        "wsConnectionId": 64, "mqttTopic": 500, "mqttClientId": 128,
    }
    drops = []
    client = _client(drops)
    client.track(**_valid(), extra_fields={"agentId": "a" * 36})
    assert client._buffer.size == 1
    client.track(**_valid(), extra_fields={"agentId": "a" * 37})
    assert client._buffer.size == 1
    _assert_invalid_drop(client, drops)


def test_unknown_execution_status_is_not_an_invalid_event():
    client = _client()
    client.track(**_valid(), execution_status="bogus")
    assert client._buffer.size == 1 and client.dropped_count == 0


def test_describe_limit_violation_names_field_limit_and_size():
    violation = describe_limit_violation({"customerId": "c" * 65})
    assert "customerId" in violation and "65" in violation and "64" in violation

    assert describe_limit_violation(
        {"customerId": "cust_1", "metricName": "api_calls", "quantity": 1,
         "occurredAt": "2026-09-29T10:00:00Z"}
    ) is None
