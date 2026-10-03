"""Client-side mirror of the ingestor's per-event field constraints.

An event that breaks one of these is rejected by the ingestor and never billed.
The server reports it per event (indexed ``errors[]`` in the batch response), but
the SDK flushes in the background, so that report reaches nobody: the usage is
simply gone. ``track()`` checks the same limits before buffering: an event that
breaks one is not sent; it is counted in ``dropped_count``, WARN-logged with the
field, the limit and the offending value, and passed to the ``on_drop`` hook with
reason ``"invalid"``. ``track()`` does not raise for it.

Source: ``dto/IngestUsageEventRequest`` in aforo-nextgen-usage-ingestor-service —
the ``@Size`` and ``@Digits`` bean constraints, which are compiled into the server
and therefore identical in every environment.

Deliberately NOT mirrored here: the timestamp window (``max-age-days``,
``future-tolerance-minutes``) and the metadata cap (``max-metadata-bytes``) from
``validation/UsageEventValidator``. Each is a per-environment property — a tenant
may raise ``max-age-days`` to 365 for backfills — so enforcing the default here
would make the SDK refuse usage its own server would accept and bill. Refusing
real usage is a worse failure than the rejection it prevents.

``describe_limit_violation`` never truncates or rounds: that would change what is
billed. The offending event is dropped instead, naming the field, the limit and
the offending value. That holds for every field the SDK caller sets.

The one exception is a label the SDK itself copies from the incoming request
(the middlewares' ``endpointPath`` and ``httpMethod``): those go through
``truncate_label`` where they are derived, so an API consumer cannot avoid being
metered by sending an over-long path. The event is still sent, with the label cut
to the server limit.

``executionStatus`` is not checked here: an unknown or over-length status is left
off the event and the event is still sent (see ``normalize_execution_status``).
"""

from __future__ import annotations

import logging
import re
import threading
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
    "capabilityName": 64,
    "subscriptionId": 64,
    "endpointPath": 512,
    "httpMethod": 16,
    "grpcService": 255,
    "grpcMethod": 128,
    "gqlOperationName": 255,
    "wsConnectionId": 64,
    "mqttTopic": 500,
    "mqttClientId": 128,
}

logger = logging.getLogger("aforo.limits")

_truncation_warned: set = set()
_truncation_lock = threading.Lock()


def utf16_length(text: str) -> int:
    """Length as the ingestor counts it (Java ``String.length()``): UTF-16 code
    units, so a character outside the Basic Multilingual Plane counts as 2."""
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in text)


def truncate_utf16(text: str, limit: int) -> str:
    """Longest prefix of ``text`` that is at most ``limit`` UTF-16 code units.

    Cuts between characters, so a surrogate pair is never split: a character
    that needs 2 units and has only 1 left is left out entirely.
    """
    if len(text) * 2 <= limit:
        return text
    units = 0
    for index, ch in enumerate(text):
        units += 2 if ord(ch) > 0xFFFF else 1
        if units > limit:
            return text[:index]
    return text


def truncate_label(field: str, value: Any) -> Any:
    """Cut a request-derived label to the ingestor's limit for ``field``.

    For labels the SDK copies from the incoming request only -- never for a
    field the caller sets (those are dropped as ``"invalid"`` when over-long).
    Logs one WARNING per field name per process. Non-strings pass through.
    """
    if not isinstance(value, str):
        return value
    limit = MAX_LENGTHS[field]
    cut = truncate_utf16(value, limit)
    if len(cut) == len(value):
        return value
    with _truncation_lock:
        first = field not in _truncation_warned
        _truncation_warned.add(field)
    if first:
        logger.warning(
            "[aforo] %s taken from the request was longer than the ingestor's limit and "
            "was truncated to %d characters; the event is still sent. Logged once per field.",
            field, limit,
        )
    return cut


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
        f'limit (value starts "{text[:80]}"). Shorten it — the SDK will not truncate it, '
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
