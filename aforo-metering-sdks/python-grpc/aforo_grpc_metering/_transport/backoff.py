"""Retry delays: full jitter, Retry-After in both forms, breaker cooldown."""

from __future__ import annotations

from email.utils import parsedate_to_datetime
from typing import Callable, Optional

from .policy import (
    BREAKER_FLOOR_S,
    BREAKER_INITIAL_S,
    BREAKER_MAX_S,
    BREAKER_MULTIPLIER,
    RETRY_AFTER_MAX_S,
    RETRY_BASE_S,
    RETRY_MAX_DELAY_S,
)


#: Beyond this the ceiling is long past every cap; stops 2**n overflowing a float.
_MAX_EXPONENT = 62


def full_jitter(attempt: int, rand: Callable[[], float],
                base: float = RETRY_BASE_S, max_delay: float = RETRY_MAX_DELAY_S) -> float:
    """``random(0, min(max_delay, base * 2**attempt))``."""
    ceiling = min(max_delay, base * (2 ** min(max(0, attempt), _MAX_EXPONENT)))
    return max(0.0, rand() * ceiling)


def parse_retry_after(value: Optional[str], now_epoch: float) -> Optional[float]:
    """Seconds to wait from a ``Retry-After`` header.

    Accepts delta-seconds (``"2"``) and an HTTP-date
    (``"Wed, 21 Oct 2026 07:28:00 GMT"``). Returns None for a missing or
    unreadable value, so the caller uses its own delay.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        seconds = float(text)
    except ValueError:
        seconds = None
    if seconds is not None:
        if seconds != seconds or seconds < 0:  # NaN or negative
            return None
        return seconds
    try:
        when = parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError):
        return None
    if when is None or when.tzinfo is None:
        return None
    return max(0.0, when.timestamp() - now_epoch)


def retry_delay(attempt: int, retry_after: Optional[float], rand: Callable[[], float],
                base: float = RETRY_BASE_S, max_delay: float = RETRY_MAX_DELAY_S,
                retry_after_cap: float = RETRY_AFTER_MAX_S) -> float:
    """Delay before retry number ``attempt + 1``.

    ``max(retry_after, jittered delay)``, capped at ``retry_after_cap``.
    """
    delay = full_jitter(attempt, rand, base, max_delay)
    if retry_after is not None:
        delay = max(retry_after, delay)
    return min(delay, retry_after_cap)


def breaker_cooldown(openings: int, rand: Callable[[], float],
                     initial: float = BREAKER_INITIAL_S, maximum: float = BREAKER_MAX_S,
                     multiplier: float = BREAKER_MULTIPLIER, floor: float = BREAKER_FLOOR_S) -> float:
    """Pause after an outage: ``max(floor, random(0, ceiling))`` with
    ``ceiling = min(maximum, initial * multiplier**openings)``. Full jitter, so
    a fleet of clients does not retry in step; the floor stops a zero draw from
    turning the pause into a tight loop."""
    ceiling = min(maximum, initial * (multiplier ** min(max(0, openings), _MAX_EXPONENT)))
    return max(floor, rand() * max(0.0, ceiling))
