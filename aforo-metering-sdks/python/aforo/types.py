"""Type definitions for the Aforo metering SDK."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional


@dataclass
class AforoOptions:
    """Options for creating an AforoClient instance."""

    api_key: str
    """Aforo API key for authentication."""

    base_url: str = "https://ingest.aforo.ai"
    """Base URL for the Aforo ingestor service."""

    flush_count: int = 50
    """Maximum events to buffer before flushing."""

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
    """Override for idempotency key. Auto-generated if omitted."""

    occurred_at: Optional[str] = None
    """When the event occurred (ISO 8601). Defaults to now."""

    metadata: Optional[dict[str, Any]] = None
    """Arbitrary key-value metadata attached to the event."""


@dataclass
class ResolvedEvent:
    """Internal event with all fields resolved."""

    customer_id: str
    metric_name: str
    quantity: float
    idempotency_key: str
    occurred_at: str
    metadata: Optional[dict[str, Any]] = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "customerId": self.customer_id,
            "metricName": self.metric_name,
            "quantity": self.quantity,
            "idempotencyKey": self.idempotency_key,
            "occurredAt": self.occurred_at,
        }
        if self.metadata:
            d["metadata"] = self.metadata
        return d


@dataclass
class FlushResult:
    """Result of a flush operation."""

    sent: int = 0
    failed: int = 0


@dataclass
class MiddlewareOptions:
    """Options for framework middleware."""

    api_key: str
    base_url: str = "https://ingest.aforo.ai"
    metric_name: Optional[Callable | str] = None
    quantity: Optional[Callable | float] = None
    customer_id: Optional[Callable | str] = None
    exclude_paths: list[str] = field(
        default_factory=lambda: ["/health", "/ready", "/metrics", "/favicon.ico"]
    )
    exclude_status_codes: list[int] = field(default_factory=list)
    metadata: Optional[Callable] = None
    flush_count: int = 50
    flush_interval: float = 5.0
    max_queue_size: int = 10_000
