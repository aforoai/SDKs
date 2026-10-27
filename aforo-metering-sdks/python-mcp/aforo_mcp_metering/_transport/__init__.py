"""Aforo transport core (wave 5): one bounded queue, one flusher, one pooled client.

Source of truth: ``python/aforo/_transport``. Every Python variant carries a
byte-identical copy made by ``scripts/sync-transport.sh python``; never edit a
copy. Imports inside this package are relative only, so the copy works under
any parent package.
"""

from .backoff import breaker_cooldown, full_jitter, parse_retry_after, retry_delay
from .core import ERROR_KINDS, FlushOutcome, TransportCore, TransportError, unwrap_envelope
from .identity import clean_customer_id, require_customer_source
from .urls import validate_base_url
from .utf16 import too_long, truncate_utf16, utf16_length
from . import policy

__all__ = [
    "ERROR_KINDS",
    "TransportError",
    "FlushOutcome",
    "TransportCore",
    "breaker_cooldown",
    "clean_customer_id",
    "full_jitter",
    "parse_retry_after",
    "policy",
    "require_customer_source",
    "retry_delay",
    "too_long",
    "truncate_utf16",
    "unwrap_envelope",
    "utf16_length",
    "validate_base_url",
]
