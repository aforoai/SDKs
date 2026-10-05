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

    WARNING - collapse hazard: two legitimately DISTINCT events with
    identical fields in the same timestamp instant produce the SAME key, so
    the second dedups away (silent under-billing). The SDK therefore no
    longer uses this as the automatic fallback for keyless track() calls
    (2026-07-05 - mirrors Aforo ingest's April 2026 H4 fix). Use it only
    when your events are guaranteed unique per
    (customer, metric, quantity, occurred_at).
    """
    data = f"{customer_id}:{metric_name}:{quantity}:{occurred_at}"
    return hashlib.sha256(data.encode()).hexdigest()[:32]


def generate_random_key() -> str:
    """Random UUID key - the automatic fallback for keyless track() calls.

    No caller key = dedup opt-out: every call is a distinct event; the key is
    stamped once at enqueue so the SDK's own flush retries stay dedup-safe.
    """
    return str(uuid.uuid4())
