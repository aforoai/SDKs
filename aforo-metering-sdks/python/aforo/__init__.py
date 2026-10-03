"""Aforo usage metering SDK — track API usage events with batching, retry, and framework middleware."""

from .client import AforoClient
from .middleware._common import DEFAULT_METRIC_NAME
from .types import (
    AforoOptions,
    DropReason,
    FlushResult,
    MiddlewareOptions,
    ResolvedEvent,
    TrackEvent,
)

__all__ = [
    "DEFAULT_METRIC_NAME",
    "AforoClient",
    "AforoOptions",
    "DropReason",
    "FlushResult",
    "MiddlewareOptions",
    "ResolvedEvent",
    "TrackEvent",
]

__version__ = "1.1.2"
