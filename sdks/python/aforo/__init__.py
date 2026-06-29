"""Aforo usage metering SDK — track API usage events with batching, retry, and framework middleware."""

from .client import AforoClient
from .types import AforoOptions, FlushResult, MiddlewareOptions, TrackEvent

__all__ = [
    "AforoClient",
    "AforoOptions",
    "FlushResult",
    "MiddlewareOptions",
    "TrackEvent",
]

__version__ = "1.0.0"
