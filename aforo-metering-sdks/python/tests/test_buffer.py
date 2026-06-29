"""Tests for aforo.buffer — thread-safe ring buffer."""

import pytest
from aforo.buffer import RingBuffer
from aforo.types import ResolvedEvent


def _event(n: int) -> ResolvedEvent:
    return ResolvedEvent(
        customer_id=f"cust_{n}",
        metric_name="api_calls",
        quantity=1,
        idempotency_key=f"key_{n}",
        occurred_at="2026-03-21T00:00:00Z",
    )


class TestRingBuffer:
    def test_push_and_drain(self):
        buf = RingBuffer(10)
        buf.push(_event(1))
        buf.push(_event(2))
        buf.push(_event(3))

        assert buf.size == 3
        assert not buf.is_empty

        items = buf.drain()
        assert len(items) == 3
        assert items[0].customer_id == "cust_1"
        assert items[2].customer_id == "cust_3"
        assert buf.size == 0
        assert buf.is_empty

    def test_overflow_drops_oldest(self):
        buf = RingBuffer(3)
        assert buf.push(_event(1)) is True
        assert buf.push(_event(2)) is True
        assert buf.push(_event(3)) is True
        assert buf.is_full

        # Overflow — drops event 1
        assert buf.push(_event(4)) is False
        assert buf.size == 3

        items = buf.drain()
        assert items[0].customer_id == "cust_2"
        assert items[1].customer_id == "cust_3"
        assert items[2].customer_id == "cust_4"

    def test_drain_up_to(self):
        buf = RingBuffer(100)
        for i in range(10):
            buf.push(_event(i))

        batch = buf.drain_up_to(3)
        assert len(batch) == 3
        assert batch[0].customer_id == "cust_0"
        assert buf.size == 7

        batch2 = buf.drain_up_to(5)
        assert len(batch2) == 5
        assert batch2[0].customer_id == "cust_3"
        assert buf.size == 2

    def test_drain_empty(self):
        buf = RingBuffer(10)
        assert buf.drain() == []
        assert buf.drain_up_to(5) == []

    def test_invalid_capacity(self):
        with pytest.raises(ValueError, match="capacity must be >= 1"):
            RingBuffer(0)
        with pytest.raises(ValueError, match="capacity must be >= 1"):
            RingBuffer(-5)
