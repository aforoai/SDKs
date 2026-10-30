"""Transport numbers from ``contract/ingest-contract.json`` -> ``transportPolicy``.

This package is copied, byte for byte, into every Python variant by
``scripts/sync-transport.sh``. Edit it only in ``python/aforo/_transport`` and
run the sync. Each module's contract test checks these values against the JSON.
"""

INGEST_PATH = "/v1/ingest/batch"

#: Events per request: default, and the ingestor's hard limit.
DEFAULT_FLUSH_COUNT = 500
MAX_BATCH_EVENTS = 1000

#: A batch whose JSON body would exceed this is split before it is sent.
TARGET_REQUEST_BODY_BYTES = 4 * 1024 * 1024
#: The ingestor answers 413 above this.
MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024

DEFAULT_QUEUE_CAPACITY = 10_000
DEFAULT_FLUSH_INTERVAL_S = 5.0

REQUEST_TIMEOUT_S = 10.0
CONNECT_TIMEOUT_S = 5.0
SHUTDOWN_TIMEOUT_S = 5.0

MAX_RETRIES = 3
RETRY_BASE_S = 0.5
RETRY_MAX_DELAY_S = 30.0
RETRY_AFTER_MAX_S = 60.0
#: Retried statuses: these two plus every 5xx (``RETRY_STATUS_CLASSES``).
RETRY_STATUSES = frozenset({408, 429})
RETRY_STATUS_CLASSES = frozenset({"5xx"})
SPLIT_STATUSES = frozenset({413})
AUTH_FAILURE_STATUSES = frozenset({401, 403})

#: Breaker cooldown: max(floor, random(0, min(max, initial * multiplier**n))).
BREAKER_FLOOR_S = 0.25
BREAKER_INITIAL_S = 5.0
BREAKER_MAX_S = 300.0
BREAKER_MULTIPLIER = 2.0

#: Hosts that may use plain http:// without ``allow_insecure_http``.
PLAIN_HTTP_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

#: Batches are gzip-encoded by default (wave 8, G269); usage-ingestor decodes them.
GZIP = True

#: Bodies smaller than this are sent plain: gzip's header and dictionary cost more than they save.
COMPRESSION_MIN_BYTES = 1024

#: How much of a response body the core reads (the ingestor's bodies are small).
MAX_RESPONSE_BODY_BYTES = 1024 * 1024

DROP_REASONS = ("overflow", "rejected", "invalid", "shutdown", "closed", "retry_exhausted")


def is_retry_status(status: int) -> bool:
    """True for 408, 429 and every 5xx."""
    return status in RETRY_STATUSES or 500 <= status <= 599
