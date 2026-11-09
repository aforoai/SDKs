"""Wire checks for one event, made before it is queued.

usage-ingestor reads the whole ``{"events": [...]}`` body with Jackson before it
validates any single event. A value Jackson cannot read into the request DTO
(``IngestUsageEventRequest``) therefore fails the WHOLE request with 400, and
every other event in that batch, other customers' included, is lost with it.
The core runs these checks in ``enqueue()`` so such an event never reaches a
batch:

* ``wire_problem`` names a value that would fail the whole body: an
  ``occurredAt`` that is not an ISO-8601 instant with seconds and a zone, a
  ``metadata`` / ``trace`` that is not an object, a ``quantity`` that is not a
  number, or an object / array where the DTO holds a string. The core drops
  that event as ``"invalid"``.
* ``without_unreadable_numbers`` leaves off an optional integer field whose
  value the DTO's ``Integer`` / ``Short`` / ``Long`` cannot hold (for example a
  WebSocket ``executionDurationMs`` past 2^31 ms). The field is descriptive, so
  the event is kept and sent without it.
"""

from __future__ import annotations

import math
import re
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Optional, Tuple

#: What Jackson reads into ``java.time.Instant`` (``DateTimeFormatter.ISO_INSTANT``):
#: date, ``T``, hours, minutes AND seconds, optional fraction, and ``Z`` or an
#: offset written ``+HH:MM``. No zone, no seconds, or ``+HHMM`` all fail to parse.
ISO_INSTANT = re.compile(
    r"^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$"
)

_INT32 = (-(2 ** 31), 2 ** 31 - 1)
_INT16 = (-(2 ** 15), 2 ** 15 - 1)
_INT64 = (-(2 ** 63), 2 ** 63 - 1)

#: Optional integer fields and the range of the DTO type that holds them.
INTEGER_FIELDS: Dict[str, Tuple[int, int]] = {
    "stepNumber": _INT32,
    "executionDurationMs": _INT32,
    "messageCount": _INT32,
    "gqlComplexity": _INT32,
    "gqlFieldCount": _INT32,
    "responseTimeMs": _INT32,
    "rateLimitRpm": _INT32,
    "rateLimitRpd": _INT32,
    "mqttQos": _INT16,
    "statusCode": _INT16,
    "dataBytes": _INT64,
}

#: Fields the DTO holds as a String: a JSON object or array there fails the body.
STRING_FIELDS = frozenset({
    "customerId", "metricName", "idempotencyKey", "traceId", "spanId", "sessionId",
    "parentStepId", "subscriptionId", "productType", "agentId", "toolName",
    "capabilityName", "executionStatus", "grpcService", "grpcMethod", "grpcStatusCode",
    "grpcCallType", "gqlOperationType", "gqlOperationName", "wsConnectionId", "wsDirection",
    "wsFrameType", "wsCloseReason", "mqttTopic", "mqttEventType", "mqttClientId",
    "sessionBoundary", "endpointPath", "httpMethod", "teamId",
})

#: Fields the DTO holds as an object (``Map`` / ``TraceContext``).
OBJECT_FIELDS = ("metadata", "trace")


def occurred_at_problem(value: Any) -> Optional[str]:
    """Why ``value`` is not an ``occurredAt`` the ingestor can read, or None."""
    if value is None:
        return None
    if not isinstance(value, str) or not ISO_INSTANT.match(value):
        return (
            f'occurredAt "{str(value)[:80]}" is not an ISO-8601 instant with seconds and a zone '
            '(expected e.g. "2026-03-01T14:30:00Z" or "2026-03-01T14:30:00+05:30")'
        )
    return None


def _quantity_problem(value: Any) -> Optional[str]:
    if value is None or (isinstance(value, (int, float)) and not isinstance(value, bool)):
        return None
    if isinstance(value, str):
        try:
            Decimal(value.strip())
            return None
        except (InvalidOperation, ValueError):
            pass
    return f"quantity must be a number (got {type(value).__name__})"


def wire_problem(event: Any) -> Optional[str]:
    """Why the ingestor could not read this wire event at all (which would fail
    every event of its batch), or None. Non-dict events are not checked."""
    if not isinstance(event, dict):
        return None
    if "occurredAt" in event:
        problem = occurred_at_problem(event["occurredAt"])
        if problem:
            return problem
    for name in OBJECT_FIELDS:
        value = event.get(name)
        if value is not None and not isinstance(value, dict):
            return f"{name} must be an object (got {type(value).__name__})"
    if "quantity" in event:
        problem = _quantity_problem(event["quantity"])
        if problem:
            return problem
    for name in STRING_FIELDS:
        if isinstance(event.get(name), (dict, list, tuple)):
            return f"{name} must be a string (got {type(event[name]).__name__})"
    return None


def _fits(value: Any, bounds: Tuple[int, int]) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        number = value
    elif isinstance(value, float):
        if not math.isfinite(value):
            return False
        number = int(value)
    elif isinstance(value, str):
        try:
            number = int(value.strip())
        except ValueError:
            return False
    else:
        return False
    return bounds[0] <= number <= bounds[1]


def without_unreadable_numbers(event: Any) -> Tuple[Any, Tuple[str, ...]]:
    """``event`` minus the optional integer fields its DTO type cannot hold, and
    the names of the fields left off. The event itself is never modified: a
    copy is returned when something is left off."""
    if not isinstance(event, dict):
        return event, ()
    bad = tuple(name for name, bounds in INTEGER_FIELDS.items()
                if event.get(name) is not None and not _fits(event[name], bounds))
    if not bad:
        return event, ()
    return {k: v for k, v in event.items() if k not in bad}, bad
