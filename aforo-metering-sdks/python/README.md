# aforo-metering

Track API usage events from any Python service and let Aforo handle buffering, batching, and retry — plus drop-in middleware for FastAPI, Django, and Flask that meters every request without touching your handlers.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install:

```bash
pip install aforo-metering
# framework extras (pick what you use):
pip install "aforo-metering[fastapi]"
pip install "aforo-metering[django]"
pip install "aforo-metering[flask]"
```

**Install `2.0.0` or later. `1.0.0` on PyPI was built from an older copy of this code and lacks the fixes listed in the changelog.** If `2.0.0` is not on PyPI yet, install straight from GitHub:

```bash
pip install "git+https://github.com/aforoai/SDKs.git#subdirectory=aforo-metering-sdks/python"
```

Or clone the repo and install this package in editable mode, for local development:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/python          # the folder holding pyproject.toml
pip install -e .
# with a framework extra:
pip install -e ".[fastapi]"
```

The only hard dependency is `httpx>=0.25`. Framework packages (`fastapi`/`starlette`, `django`, `flask`) are pulled in by the matching extra — they're not required for the bare client.

## Quickstart

Best when you control the call site and want to emit one event per billable action. `track()` puts the event on a bounded queue and returns: it never sends and never starts a thread. One background thread per client sends batches of up to 500 events. If the ingestor is down, batches stay queued (same idempotency keys) and are retried after a pause, so an outage costs nothing unless the queue fills up.

```python
import os
from aforo import AforoClient

client = AforoClient(api_key=os.environ["AFORO_API_KEY"], product_type="API")

client.track(
    customer_id="cust_1",      # who is billed
    metric_name="api_calls",   # what you're metering
    quantity=1,
)

# Per-event productType override + optional top-level ingest fields:
client.track(customer_id="cust_1", metric_name="agent_runs", product_type="AI_AGENT",
             extra_fields={"agentId": "agent_7", "sessionId": "sess_42"})

# Ask the sender to send now and wait for it (while the ingestor is down this is one attempt; the events stay queued):
result = client.flush()        # FlushResult(sent=..., failed=...)

# Stop and flush for at most shutdown_timeout seconds. Runs at interpreter exit
# (atexit) too. Safe across fork(): a gunicorn --preload worker gets its own sender.
client.shutdown()
```

Events POST to `https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>`. The client appends `/v1/ingest/batch` to `base_url`, so set `base_url` to the host only. `base_url` must be `https://`; plain `http://` is accepted only for `localhost` / `127.0.0.1` / `::1`, or with `allow_insecure_http=True`. The API key never appears in `repr()`, logs or `on_drop` payloads.

> Tenant scope comes from the API key — there is no `tenant_id` argument on this SDK. `customer_id` is the entity you bill within that tenant. Never feed `customer_id` from a client-settable request header you don't trust.

## Configuration

Pass these as keyword args to `AforoClient(...)`, or build an `AforoOptions` and pass `options=`.

| Option | Type | Default | What it does |
|---|---|---|---|
| `api_key` | `str` | — (required) | Aforo API key, sent as `X-API-Key` on every batch. |
| `base_url` | `str` | `https://api.aforo.ai` | Ingestor host. `/v1/ingest/batch` is appended automatically. |
| `product_type` | `str` | `"API"` | Top-level `productType` on every event (`API`, `AGENTIC_API`, `AI_AGENT`, `MCP_SERVER`, `GRPC_API`, `GRAPHQL_API`, `WEBSOCKET_API`, `MQTT_BROKER`); required by the production ingestor. Trimmed + upper-cased; override per event with `track(product_type=...)`. |
| `flush_count` | `int` | `500` | Events per request, and the queue size that wakes the sender early (clamped to 1..1000, the ingestor's limit). A batch whose JSON body would exceed 4 MiB is split. |
| `flush_interval` | `float` | `5.0` | Seconds between background timer flushes. |
| `max_queue_size` | `int` | `10000` | Queue capacity. On overflow the **oldest** event is dropped (reason `overflow`). |
| `max_retries` | `int` | `3` | Retries on network errors, timeouts, 5xx, 408 and 429 before the batch is requeued. |
| `retry_base_s` | `float` | `0.5` | Full-jitter backoff: retry `n` waits `random(0, min(30, retry_base_s * 2**n))` seconds. |
| `timeout` | `float` | `10.0` | Total deadline per HTTP request, in seconds. |
| `shutdown_timeout` | `float` | `5.0` | `shutdown()` flushes for at most this long; what is still queued is dropped with reason `shutdown`. |
| `allow_insecure_http` | `bool` | `False` | Allow a plain `http://` `base_url` on a host other than localhost. |
| `heartbeat_interval` | `float` | `30.0` | Seconds between session heartbeats (see `start_session`). |

| `on_drop` | `callable?` | `None` | Opt-in hook `on_drop(events, reason)` for events the SDK loses. See [Dropped events](#dropped-events-dropped_count-on_drop). |
| `on_error` | `callable?` | `None` | Opt-in hook for delivery problems. Receives an `aforo.TransportError`; branch on `.kind`: `outage` / `auth` (still queued, retried), `rejected`, `shutdown`, `closed`. `.events` and `.status` carry the events and HTTP status. |
| `on_accepted` | `callable?` | `None` | Opt-in hook `on_accepted(body, events)` after every accepted batch, with the ingestor's response `data` (for example `killedSessionIds`). |

Retry rules, fixed in the transport and not configurable beyond the values above: retry on network errors, timeouts, **every 5xx, 408, 429**; honor `Retry-After` in both forms (seconds or an HTTP date), capped at 60 s. After the last retry, or on **401/403** (logged at ERROR: the key is wrong or revoked), the batch goes back to the front of the queue and the sender pauses: a random time up to 5 s (never under 250 ms), the ceiling doubling up to 5 min while the outage lasts. A **3xx redirect** is never followed — the API key must not reach another host — and is handled like 401/403, with an ERROR naming the host it pointed to (fix `base_url`). Events the ingestor marks `retryable` inside a 2xx are re-sent with the same keys after the same backoff, at most `max_retries` times, then treated as an outage. `timeout` covers the whole request, including reading the response body. An event that cannot be turned into JSON (a cycle, `NaN`, an object JSON does not know) is dropped as `invalid` inside `track()` and never reaches a batch. A **413** splits the batch in half. Other 4xx are never retried: the batch is dropped with reason `rejected`. No `Content-Encoding` is sent: the ingestor does not decode gzip request bodies yet.

### Reporting the request outcome (`execution_status`)

`track(..., execution_status="TIMEOUT")` (keyword-only; also a `TrackEvent` field) sends the optional `executionStatus` used by OUTCOME_BASED pricing: each event bills at the weight configured for its status, and an event without a status bills at full weight. The value is trimmed and upper-cased. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value (or one over 20 characters) is WARN-logged and left off; the event is still sent. The full rules are in the [repository README](../README.md#reporting-the-request-outcome-executionstatus).

### Dropped events (`dropped_count`, `on_drop`)

`track()` never raises. Every event the SDK loses for good is counted in `client.dropped_count`, WARN-logged, and passed to the opt-in `on_drop(events, reason)` hook. Dropped events keep their idempotency keys, so replaying them through `track()` is dedup-safe. An ingest outage is not a loss: batches stay queued.

| `reason` | When |
|---|---|
| `overflow` | The queue was full (typically during a long outage); the oldest event was evicted. |
| `shutdown` | Still queued when `shutdown()` reached `shutdown_timeout`. |
| `closed` | `track()` was called after `shutdown()`. |
| `rejected` | The ingestor answered a non-retryable 4xx for the batch, or rejected individual events in a `202` (`failed` / `errors[]`). Only the events the response names by index are passed to the hook; if it names none, they are counted only. |
| `invalid` | `track()` refused the event before queueing it: blank `customer_id` / `metric_name`, `quantity <= 0`, a malformed `occurred_at`, or a field over the ingestor's limit (`customerId` 64, `metricName` 255, `idempotencyKey` 255, `productType` 20, `quantity` 14 integer / 6 decimal digits, and the `extra_fields` limits in `aforo/limits.py`). Lengths count UTF-16 units, as the ingestor does (an emoji is 2). Never truncated or rounded. Also: a middleware request whose customer resolver returned nothing (counted, no event). The WARN is logged on the first occurrence and then every 1000th. |
| `retry_exhausted` | Kept for compatibility; no longer reported (an outage requeues). |

A failed session heartbeat is not a usage drop and is not counted.

### Framework middleware

Each adapter constructs its own `AforoClient` and emits one event per request.

- **Metric:** `metric_name` — a fixed name or a callable; default `"api_calls"` (`aforo.DEFAULT_METRIC_NAME`). The metric must exist in your tenant's Aforo catalog: the ingestor rejects an unknown metric, and because it validates a batch as a whole, one rejected event fails every event in that batch.
- **Customer (required):** `customer_resolver` — `callable(request)` (FastAPI: the ASGI scope) returning the customer id from identity your service verified: the session, a JWT subject, an API-key lookup. Django ships `aforo.middleware.django.user_id_resolver` (the authenticated user's id). To read the `X-Customer-Id` header instead, pass `trust_customer_header=True` — the caller of your API controls that header, so do it only behind a gateway that sets it. With neither, the middleware raises `ValueError` at start-up. A request whose resolver returns nothing is served normally, not metered, and counted as an `invalid` drop. `customer_id` (a callable or one fixed id) still works as the old name of `customer_resolver`. The caller's `X-Api-Key` is never used.
- **Product type:** `product_type` (Flask kwarg / `AFORO_PRODUCT_TYPE` config, Django `AFORO_PRODUCT_TYPE` setting, FastAPI kwarg) — default `"API"`.
- Every event carries top-level `endpointPath` (path without query string), `httpMethod`, `statusCode` and `responseTimeMs`. A `quantity` resolving to `<= 0` is not metered.
- `endpointPath` and `httpMethod` are read from the incoming request. A value over the ingestor's limit (512 / 16 characters, counted in UTF-16 code units) is truncated to the limit and the event is still sent; a WARNING is logged once per field per process. Fields you set yourself (`customer_id`, `metric_name`, `idempotency_key`, anything in `extra_fields`) are never truncated: an over-long one drops the event with reason `invalid`.
- **CORS preflights** (`OPTIONS`) are never metered.

```python
# FastAPI / Starlette -- callables receive the ASGI scope
from aforo.middleware.fastapi import AforoMeteringMiddleware
app.add_middleware(AforoMeteringMiddleware, api_key=os.environ["AFORO_API_KEY"],
                   customer_resolver=lambda scope: scope["user"].customer_id,  # set by your auth middleware
                   metric_name="api_calls", product_type="API")

# Flask -- metric_name(request, response), customer_resolver(request); or AFORO_* config
from flask import g
from aforo.middleware.flask import AforoMetering
AforoMetering(app, api_key=os.environ["AFORO_API_KEY"], metric_name="api_calls",
              customer_resolver=lambda req: g.current_user.customer_id)

# Django settings.py -- AFORO_CUSTOMER_RESOLVER: callable(request) or its dotted path
MIDDLEWARE = [..., "aforo.middleware.django.AforoMeteringMiddleware"]
AFORO_API_KEY = os.environ["AFORO_API_KEY"]
AFORO_CUSTOMER_RESOLVER = "aforo.middleware.django.user_id_resolver"
AFORO_METRIC_NAME = "api_calls"
AFORO_PRODUCT_TYPE = "API"
```

`MiddlewareOptions` adds `customer_resolver`, `trust_customer_header`, `product_type`, `metric_name`, `quantity`, `metadata` (callables or constants), plus `exclude_paths`, `exclude_status_codes` and `allow_insecure_http`. Each middleware exposes its client as `.client` (for `flush()`, `shutdown()`, `dropped_count`). See the [user guide](USER_GUIDE.md#configuration-reference) for the full table.

## Walk me through it

The end-to-end path — install → configure → first metered event → confirm it landed in Aforo — is in **[USER_GUIDE.md](USER_GUIDE.md)**.

## What this doesn't cover

This SDK only **emits** usage events. It does not read entitlements, enforce quotas, or block requests — middleware always returns the original response, and metering failures are swallowed so they can't break your request path. Rate plans, pricing, and which `metric_name` values map to billable lines are configured in the Aforo console, not here. Broker- and gateway-side metering (Kong, EMQ X, etc.) live in their own plugins, not in this client.
