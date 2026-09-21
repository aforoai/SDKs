"""Aforo usage metering SDK — track API usage events with batching, retry, and framework middleware."""

from .client import AforoClient
from .middleware._common import DEFAULT_METRIC_NAME
from .types import AforoOptions, FlushResult, MiddlewareOptions, TrackEvent

__all__ = [
    "DEFAULT_METRIC_NAME",
    "AforoClient",
    "AforoOptions",
    "FlushResult",
    "MiddlewareOptions",
    "TrackEvent",
]

__version__ = "1.0.0"
