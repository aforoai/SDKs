"""Idempotency key generation for usage events."""

from __future__ import annotations

import hashlib
import uuid


def generate_idempotency_key(
    customer_id: str,
    metric_name: str,
    quantity: float,
    occurred_at: str,
) -> str:
    """Generate a deterministic idempotency key via SHA-256.

    Returns 32 hex chars.
    """
    data = f"{customer_id}:{metric_name}:{quantity}:{occurred_at}"
    return hashlib.sha256(data.encode()).hexdigest()[:32]


def generate_random_key() -> str:
    """Generate a random UUID key."""
    return str(uuid.uuid4())
