"""
Bounded in-memory event buffer.

Client pushes events with :meth:`EventBuffer.add`; buffer signals when
it's at or above the configured high-water mark so the client can flush.
Drain returns a copy and empties the buffer atomically (single-threaded
asyncio; no lock needed because ``list.copy`` / ``list.clear`` are
individually atomic under the GIL and callers hold the event loop
between them).

The buffer is intentionally dumb — no timing, no HTTP, no retry.
Those live in :mod:`aforo_agent_metering.transport` and
:mod:`aforo_agent_metering.client`.
"""

from __future__ import annotations

from typing import Any, Dict, List


class EventBuffer:
    """Bounded buffer for outgoing usage events."""

    def __init__(self, max_events: int = 50) -> None:
        if max_events <= 0:
            raise ValueError("max_events must be > 0")
        self._events: List[Dict[str, Any]] = []
        self.max_events = max_events

    def add(self, event: Dict[str, Any]) -> bool:
        """Append an event. Returns True when the buffer is at or above
        ``max_events`` and the caller should flush now."""
        self._events.append(event)
        return len(self._events) >= self.max_events

    def drain(self) -> List[Dict[str, Any]]:
        """Return and clear all buffered events atomically."""
        events = self._events[:]
        self._events.clear()
        return events

    def __len__(self) -> int:
        return len(self._events)
