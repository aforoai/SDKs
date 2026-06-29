"""Thread-safe bounded ring buffer for usage events."""

from __future__ import annotations

import threading
from collections import deque
from typing import Optional

from .types import ResolvedEvent


class RingBuffer:
    """Bounded, thread-safe ring buffer.

    When full, the oldest event is dropped (FIFO overflow).
    Uses ``collections.deque(maxlen=capacity)`` which handles
    the ring semantics natively, plus a ``threading.Lock`` for
    thread safety between the application thread and the flush thread.
    """

    def __init__(self, capacity: int = 10_000) -> None:
        if capacity < 1:
            raise ValueError("Buffer capacity must be >= 1")
        self._capacity = capacity
        self._buf: deque[ResolvedEvent] = deque(maxlen=capacity)
        self._lock = threading.Lock()

    def push(self, event: ResolvedEvent) -> bool:
        """Add an event. Returns True if added without overflow."""
        with self._lock:
            was_full = len(self._buf) == self._capacity
            self._buf.append(event)  # deque(maxlen) auto-drops oldest
            return not was_full

    def drain(self) -> list[ResolvedEvent]:
        """Remove and return all events."""
        with self._lock:
            items = list(self._buf)
            self._buf.clear()
            return items

    def drain_up_to(self, max_count: int) -> list[ResolvedEvent]:
        """Remove and return up to ``max_count`` events from the front."""
        with self._lock:
            take = min(max_count, len(self._buf))
            items = [self._buf.popleft() for _ in range(take)]
            return items

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._buf)

    @property
    def is_empty(self) -> bool:
        with self._lock:
            return len(self._buf) == 0

    @property
    def is_full(self) -> bool:
        with self._lock:
            return len(self._buf) == self._capacity
