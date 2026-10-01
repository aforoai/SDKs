"""Type definitions for the Aforo metering SDK."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Optional

# Same logger as AforoClient -- normalize_execution_status runs inside track().
logger = logging.getLogger("aforo.client")

DropReason = Literal["overflow", "retry_exhausted", "rejected", "invalid"]
"""Why a buffered event was permanently dropped by the SDK.

- ``overflow``: the ring buffer was full -- the OLDEST event was evicted.
- ``retry_exhausted``: a batch failed after all transport retries (ingest outage).
- ``rejected``: the ingestor rejected the batch with a non-retryable 4xx, or
  rejected individual events in a partial (202 ``failed`` / ``errors[]``) response.
- ``invalid``: ``track()`` refused the event before buffering it (blank
  customer/metric, quantity <= 0, or a field over the ingestor's limit). It was
  never sent.
"""

DEFAULT_PRODUCT_TYPE = "API"
"""Default ``productType`` stamped on every event by the base SDK."""

MAX_BATCH_SIZE = 1000
"""The ingestor accepts at most 1000 events per ``POST /v1/ingest/batch``."""


@dataclass
class AforoOptions:
    """Options for creating an AforoClient instance."""

    api_key: str
    """Aforo API key for authentication."""

    base_url: str = "https://api.aforo.ai"
    """Base URL for the Aforo ingestor service."""

    flush_count: int = 50
    """Maximum events to buffer before flushing (clamped to 1..1000, the ingestor's batch limit)."""

    flush_interval: float = 5.0
    """Flush interval in seconds."""

    max_queue_size: int = 10_000
    """Maximum events in the ring buffer. Oldest dropped on overflow."""

    max_retries: int = 3
    """Maximum retries on 5xx/timeout."""

    retry_base_s: float = 1.0
    """Base delay in seconds for exponential backoff."""

    timeout: float = 10.0
    """Request timeout in seconds."""

    shutdown_timeout: float = 5.0
    """Graceful shutdown timeout in seconds."""

    on_drop: Optional[Callable[[list["ResolvedEvent"], DropReason], None]] = None
    """OPT-IN hook invoked with events the SDK is about to lose permanently
    (buffer overflow, retry exhaustion, non-retryable rejection, or an event
    ``track()`` refused as invalid), so the
    app can persist / alert / replay them. Dropped events keep their
    idempotency keys -- re-submitting them via track() after recovery is
    dedup-safe. Default: None (drops are still counted in dropped_count and
    WARN-logged). Exceptions raised by the hook are swallowed."""

    product_type: str = DEFAULT_PRODUCT_TYPE
    """Default top-level ``productType`` for every event (``API``, ``AGENTIC_API``,
    ``AI_AGENT``, ``MCP_SERVER``, ``GRPC_API``, ``GRAPHQL_API``, ``WEBSOCKET_API``,
    ``MQTT_BROKER``). Required by the production ingestor. Trimmed and upper-cased;
    unknown values are passed through. Override per event with ``track(product_type=...)``."""

    heartbeat_interval: float = 30.0
    """Seconds between session heartbeats while a session is active (see ``start_session``)."""


@dataclass
class TrackEvent:
    """A usage event to track."""

    customer_id: str
    """Customer identifier (who is being billed)."""

    metric_name: str
    """Metric name (e.g., 'api_calls', 'ai_tokens')."""

    quantity: float = 1
    """Quantity of usage."""

    idempotency_key: Optional[str] = None
    """Idempotency key -- supply a STABLE value to dedup retries of the same
    logical event. Omitted = dedup opt-out: the SDK stamps a unique random
    key per track() call (still stable across the SDK's own flush retries).
    """

    occurred_at: Optional[str] = None
    """When the event occurred (ISO 8601). Defaults to now."""

    metadata: Optional[dict[str, Any]] = None
    """Arbitrary key-value metadata attached to the event."""

    execution_status: Optional[str] = None
    """Optional outcome of the request, used by OUTCOME_BASED pricing (each
    event bills at the weight set for its status; events without a status bill
    at full price). Trimmed and upper-cased by the SDK; blank is treated as
    absent. Accepted values: SUCCESS, PARTIAL, TIMEOUT, ERROR,
    VALIDATION_FAILED, FAILED, FAILURE, CANCELLED, PENDING, BLOCKED,
    HITL_REQUIRED (max 20 chars). The server is authoritative -- any other
    value makes it reject the event."""

    product_type: Optional[str] = None
    """Per-event ``productType`` override. Defaults to the client's ``product_type``."""

    extra_fields: Optional[dict[str, Any]] = None
    """Optional top-level ingest fields, using their exact camelCase wire names
    (e.g. ``{"agentId": "a1", "sessionId": "s1"}`` for ``AI_AGENT``)."""


@dataclass
class ResolvedEvent:
    """Internal event with all fields resolved."""

    customer_id: str
    metric_name: str
    quantity: float
    idempotency_key: str
    occurred_at: str
    metadata: Optional[dict[str, Any]] = None
    execution_status: Optional[str] = None
    """Normalized (trimmed, upper-cased) status; omitted from the wire when None."""

    product_type: Optional[str] = None
    extra_fields: Optional[dict[str, Any]] = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {}
        # Optional top-level fields first so the required fields below always win.
        if self.extra_fields:
            d.update({k: v for k, v in self.extra_fields.items() if v is not None})
        d.update({
            "customerId": self.customer_id,
            "metricName": self.metric_name,
            "quantity": self.quantity,
            "idempotencyKey": self.idempotency_key,
            "occurredAt": self.occurred_at,
        })
        if self.product_type:
            d["productType"] = self.product_type
        if self.metadata:
            d["metadata"] = self.metadata
        if self.execution_status:
            d["executionStatus"] = self.execution_status
        return d


@dataclass
class FlushResult:
    """Result of a flush operation."""

    sent: int = 0
    failed: int = 0
    reason: Optional[DropReason] = None
    """Why the batch failed, when ``failed`` > 0. None on success."""
    failed_indices: Optional[list[int]] = None
    """Batch positions of the events the ingestor rejected individually in a
    partial response, when it identified them (``errors[].index``). None when
    the whole batch failed or the response did not say which events failed."""


@dataclass
class MiddlewareOptions:
    """Options for framework middleware."""

    api_key: str
    base_url: str = "https://api.aforo.ai"
    product_type: str = DEFAULT_PRODUCT_TYPE
    """``productType`` stamped on every request event. Default ``"API"``."""
    metric_name: Optional[Callable | str] = None
    """Fixed metric or callable. Default ``"api_calls"``; must exist in your Aforo catalog."""
    quantity: Optional[Callable | float] = None
    customer_id: Optional[Callable | str] = None
    """Fixed id or callable. Default: ``X-Customer-Id`` header (never ``X-Api-Key``)."""
    exclude_paths: list[str] = field(
        default_factory=lambda: ["/health", "/ready", "/metrics", "/favicon.ico"]
    )
    exclude_status_codes: list[int] = field(default_factory=list)
    metadata: Optional[Callable] = None
    flush_count: int = 50
    flush_interval: float = 5.0
    max_queue_size: int = 10_000


# Canonical execution statuses accepted by the usage-ingestor (mirrors
# contract/ingest-contract.json ``executionStatus.values``; maxLength 20).
EXECUTION_STATUSES = frozenset({
    "SUCCESS", "PARTIAL", "TIMEOUT", "ERROR", "VALIDATION_FAILED", "FAILED",
    "FAILURE", "CANCELLED", "PENDING", "BLOCKED", "HITL_REQUIRED",
})


def normalize_execution_status(value: Optional[str]) -> Optional[str]:
    """Trim + upper-case an execution status; blank or non-string -> None.

    A value outside the canonical set (see ``EXECUTION_STATUSES``) is logged
    and dropped (None): the ingestor rejects an unknown status with a 400 for
    that event, so its usage would be lost.
    """
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    normalized = trimmed.upper()
    if normalized not in EXECUTION_STATUSES:
        logger.warning(
            "Ignoring unknown executionStatus %r; expected one of %s",
            value[:40], ", ".join(sorted(EXECUTION_STATUSES)),
        )
        return None
    return normalized
