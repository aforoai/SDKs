"""Tests for aforo.idempotency — SHA256 key generation."""

import re
from aforo.idempotency import generate_idempotency_key, generate_random_key


class TestIdempotencyKey:
    def test_deterministic(self):
        k1 = generate_idempotency_key("cust_1", "api_calls", 1, "2026-03-21T00:00:00Z")
        k2 = generate_idempotency_key("cust_1", "api_calls", 1, "2026-03-21T00:00:00Z")
        assert k1 == k2

    def test_different_inputs(self):
        k1 = generate_idempotency_key("cust_1", "api_calls", 1, "2026-03-21T00:00:00Z")
        k2 = generate_idempotency_key("cust_2", "api_calls", 1, "2026-03-21T00:00:00Z")
        assert k1 != k2

    def test_32_hex_chars(self):
        key = generate_idempotency_key("cust_1", "metric", 5, "2026-01-01T00:00:00Z")
        assert len(key) == 32
        assert re.match(r"^[0-9a-f]{32}$", key)


class TestRandomKey:
    def test_unique(self):
        k1 = generate_random_key()
        k2 = generate_random_key()
        assert k1 != k2

    def test_uuid_format(self):
        key = generate_random_key()
        assert re.match(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", key
        )
