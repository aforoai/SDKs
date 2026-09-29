"""Client-side mirror of the ingestor's per-event field constraints.

An event that breaks one of these is rejected by the ingestor and never billed.
The server reports it per event (indexed ``errors[]`` in the batch response), but
the SDK flushes in the background, so that report reaches nobody: the usage is
simply gone. Checking the same limits in ``track()`` surfaces the problem to the
caller, at the call site that produced it, while the event can still be fixed.

Source: ``dto/IngestUsageEventRequest`` in aforo-nextgen-usage-ingestor-service —
the ``@Size`` and ``@Digits`` bean constraints, which are compiled into the server
and therefore identical in every environment.

Deliberately NOT mirrored here: the timestamp window (``max-age-days``,
``future-tolerance-minutes``) and the metadata cap (``max-metadata-bytes``) from
``validation/UsageEventValidator``. Each is a per-environment property — a tenant
may raise ``max-age-days`` to 365 for backfills — so enforcing the default here
would make the SDK refuse usage its own server would accept and bill. Refusing
real usage is a worse failure than the rejection it prevents.

Nothing here truncates or rounds: that would change what is billed. The offending
event is rejected instead, naming the field, the limit and the offending value.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, Optional

#: Characters the ingestor accepts per string field (``@Size(max=...)``).
MAX_LENGTHS = {
    "customerId": 64,
    "metricName": 255,
    "idempotencyKey": 255,
    "productType": 20,
    "traceId": 128,
    "spanId": 32,
    "sessionId": 64,
    "agentId": 36,
    "toolName": 64,
    "endpointPath": 512,
    "httpMethod": 16,
}

#: ``@Digits(integer=14, fraction=6)`` — usage_events.quantity is NUMERIC(20,6).
MAX_QUANTITY_INTEGER_DIGITS = 14
MAX_QUANTITY_DECIMAL_PLACES = 6

# ISO-8601 date-time, the shape Jackson reads into an Instant. The zone
# designator is optional: an offset-less value is not provably rejected, and
# falsely rejecting one would drop a billable event.
_ISO_DATE_TIME = re.compile(
    r"^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([Zz]|[+-]\d{2}:?\d{2})?$"
)


def _length_error(field: str, value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    limit = MAX_LENGTHS[field]
    if len(text) <= limit:
        return None
    return (
        f"{field} is {len(text)} characters, exceeding the ingestor's {limit}-character "
        f'limit (value starts "{text[:32]}"). Shorten it — the SDK will not truncate it, '
        "because a truncated id bills the wrong thing."
    )


def _quantity_error(quantity: Any) -> Optional[str]:
    try:
        # Via str() so a float is counted as it will be serialized on the wire,
        # which is the text the server parses into the BigDecimal @Digits inspects.
        decimal = Decimal(str(quantity))
    except (InvalidOperation, ValueError):
        return None  # not a number; the caller's own quantity check reports that
    sign, digits, exponent = decimal.as_tuple()
    if not isinstance(exponent, int):
        return None  # NaN / Infinity — again not this check's job
    decimal_places = max(-exponent, 0)
    integer_digits = len(digits) - decimal_places
    if integer_digits > MAX_QUANTITY_INTEGER_DIGITS:
        return (
            f"quantity {quantity} has {integer_digits} integer digits, exceeding the "
            f"ingestor's limit of {MAX_QUANTITY_INTEGER_DIGITS} "
            "(usage_events.quantity is NUMERIC(20,6))."
        )
    if decimal_places > MAX_QUANTITY_DECIMAL_PLACES:
        return (
            f"quantity {quantity} has {decimal_places} decimal places, exceeding the "
            f"ingestor's limit of {MAX_QUANTITY_DECIMAL_PLACES}. Round it yourself before "
            "tracking — the SDK will not round it, because that would change the quantity "
            "you are billed for."
        )
    return None


def _occurred_at_error(occurred_at: Any) -> Optional[str]:
    if occurred_at is None:
        return None
    if not _ISO_DATE_TIME.match(str(occurred_at)):
        return (
            f'occurred_at "{occurred_at}" is not an ISO-8601 timestamp '
            '(expected e.g. "2026-03-01T14:30:00Z").'
        )
    return None


def describe_limit_violation(event: Mapping[str, Any]) -> Optional[str]:
    """Describe the first ingestor constraint this event breaks, else ``None``.

    ``event`` keys are the wire field names (camelCase), so the message names the
    field exactly as the API documents it.
    """
    for field in MAX_LENGTHS:
        problem = _length_error(field, event.get(field))
        if problem:
            return problem

    if "quantity" in event:
        problem = _quantity_error(event["quantity"])
        if problem:
            return problem

    return _occurred_at_error(event.get("occurredAt"))
