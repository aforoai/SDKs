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

    NOT the client default any more. ``occurred_at`` only carries millisecond
    precision, so two genuinely distinct events for the same customer + metric
    + quantity inside one millisecond hash to the same key and the ingestor
    drops the second as a DUPLICATE — silent under-billing. Kept public for
    callers who deliberately want content-addressed dedup (e.g. replaying a
    fixed batch) and pass the result to ``track(idempotency_key=...)``.
    """
    data = f"{customer_id}:{metric_name}:{quantity}:{occurred_at}"
    return hashlib.sha256(data.encode()).hexdigest()[:32]


def generate_random_key() -> str:
    """Generate a random UUID v4 key.

    This is the default key for an event whose caller supplied none: every
    event gets its own key, so no two distinct events can collide. Dedup stays
    opt-in via an explicit ``idempotency_key``.
    """
    return str(uuid.uuid4())
