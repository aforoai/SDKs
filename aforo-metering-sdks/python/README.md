# aforo-metering

Track API usage events from any Python service and let Aforo handle buffering, batching, and retry — plus drop-in middleware for FastAPI, Django, and Flask that meters every request without touching your handlers.

**Version:** 1.1.2 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install:

```bash
pip install aforo-metering
# framework extras (pick what you use):
pip install "aforo-metering[fastapi]"
pip install "aforo-metering[django]"
pip install "aforo-metering[flask]"
```

**Install `1.1.2` or later. `1.0.0` on PyPI was built from an older copy of this code and lacks the fixes listed in the changelog.** If `1.1.2` is not on PyPI yet, install straight from GitHub:

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

Best when you control the call site and want to emit one event per billable action. `AforoClient` enqueues into a ring buffer and a background daemon thread flushes batches; you never block on the network.

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

# Force a synchronous flush when you need delivery confirmed:
result = client.flush()        # FlushResult(sent=..., failed=...)

# Graceful shutdown drains the buffer. Also registered via atexit,
# so a clean interpreter exit flushes for you.
client.shutdown()
```

Events POST to `https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>`. The client appends `/v1/ingest/batch` to `base_url`, so set `base_url` to the host only.

> Tenant scope comes from the API key — there is no `tenant_id` argument on this SDK. `customer_id` is the entity you bill within that tenant. Never feed `customer_id` from a client-settable request header you don't trust.

## Configuration

Pass these as keyword args to `AforoClient(...)`, or build an `AforoOptions` and pass `options=`.

| Option | Type | Default | What it does |
|---|---|---|---|
| `api_key` | `str` | — (required) | Aforo API key, sent as `X-API-Key` on every batch. |
| `base_url` | `str` | `https://api.aforo.ai` | Ingestor host. `/v1/ingest/batch` is appended automatically. |
| `product_type` | `str` | `"API"` | Top-level `productType` on every event (`API`, `AGENTIC_API`, `AI_AGENT`, `MCP_SERVER`, `GRPC_API`, `GRAPHQL_API`, `WEBSOCKET_API`, `MQTT_BROKER`); required by the production ingestor. Trimmed + upper-cased; override per event with `track(product_type=...)`. |
| `flush_count` | `int` | `50` | Buffered events that trigger a flush. Also the max batch size per request (clamped to 1..1000, the ingestor's limit). |
| `flush_interval` | `float` | `5.0` | Seconds between background timer flushes. |
| `max_queue_size` | `int` | `10000` | Ring-buffer capacity. On overflow the **oldest** event is dropped. |
| `max_retries` | `int` | `3` | Retries on 5xx / 408 / 429 with exponential backoff. |
| `retry_base_s` | `float` | `1.0` | Base delay for backoff (`retry_base_s * 2**attempt`). |
| `timeout` | `float` | `10.0` | Per-request HTTP timeout in seconds. |
| `shutdown_timeout` | `float` | `5.0` | Graceful-shutdown drain budget. |
| `heartbeat_interval` | `float` | `30.0` | Seconds between session heartbeats (see `start_session`). |

| `on_drop` | `callable?` | `None` | Opt-in hook `on_drop(events, reason)` for events the SDK loses. See [Dropped events](#dropped-events-dropped_count-on_drop). |

Retry rules, fixed in the transport and not configurable beyond the values above: retry on **5xx, 408, 429**; honor `Retry-After` on 429; **never** retry other 4xx (the batch is dropped with reason `rejected`).

### Reporting the request outcome (`execution_status`)

`track(..., execution_status="TIMEOUT")` (keyword-only; also a `TrackEvent` field) sends the optional `executionStatus` used by OUTCOME_BASED pricing: each event bills at the weight configured for its status, and an event without a status bills at full weight. The value is trimmed and upper-cased. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value (or one over 20 characters) is WARN-logged and left off; the event is still sent. The full rules are in the [repository README](../README.md#reporting-the-request-outcome-executionstatus).

### Dropped events (`dropped_count`, `on_drop`)

`track()` never raises for event content — only `RuntimeError` after `shutdown()`. Every event the SDK cannot deliver is counted in `client.dropped_count`, WARN-logged, and passed to the opt-in `on_drop(events, reason)` hook. Dropped events keep their idempotency keys, so replaying them through `track()` is dedup-safe.

| `reason` | When |
|---|---|
| `overflow` | The ring buffer was full; the oldest event was evicted. |
| `retry_exhausted` | A batch still failed after all retries (5xx, 408, 429, network). |
| `rejected` | The ingestor answered a non-retryable 4xx for the batch, or rejected individual events in a `202` (`failed` / `errors[]`). Only the events the response names by index are passed to the hook; if it names none, they are counted only. |
| `invalid` | `track()` refused the event before buffering it: blank `customer_id` / `metric_name`, `quantity <= 0`, a malformed `occurred_at`, or a field over the ingestor's limit (`customerId` 64, `metricName` 255, `idempotencyKey` 255, `productType` 20, `quantity` 14 integer / 6 decimal digits, and the `extra_fields` limits in `aforo/limits.py`). Never truncated or rounded. The WARN names the field, the limit and the value; it is logged on the first occurrence and then every 1000th. |

A failed session heartbeat is not a usage drop and is not counted.

### Framework middleware

Each adapter constructs its own `AforoClient` and emits one event per request.

- **Metric:** `metric_name` — a fixed name or a callable; default `"api_calls"` (`aforo.DEFAULT_METRIC_NAME`). The metric must exist in your tenant's Aforo catalog: the ingestor rejects an unknown metric, and because it validates a batch as a whole, one rejected event fails every event in that batch.
- **Customer:** `customer_id` — a fixed id or a callable; default is the `X-Customer-Id` header (Django tries `request.user.id` first). The caller's `X-Api-Key` is never used — it is a secret, not a customer id. A request with no resolvable customer ID is **not** metered.
- **Product type:** `product_type` (Flask kwarg / `AFORO_PRODUCT_TYPE` config, Django `AFORO_PRODUCT_TYPE` setting, FastAPI kwarg) — default `"API"`.
- Every event carries top-level `endpointPath` (path without query string), `httpMethod`, `statusCode` and `responseTimeMs`. A `quantity` resolving to `<= 0` is not metered.
- `endpointPath` and `httpMethod` are read from the incoming request. A value over the ingestor's limit (512 / 16 characters, counted in UTF-16 code units) is truncated to the limit and the event is still sent; a WARNING is logged once per field per process. Fields you set yourself (`customer_id`, `metric_name`, `idempotency_key`, anything in `extra_fields`) are never truncated: an over-long one drops the event with reason `invalid`.
- **CORS preflights** (`OPTIONS`) are never metered.

```python
# FastAPI / Starlette -- callables receive the ASGI scope
from aforo.middleware.fastapi import AforoMeteringMiddleware
app.add_middleware(AforoMeteringMiddleware, api_key=os.environ["AFORO_API_KEY"],
                   metric_name="api_calls", product_type="API")

# Flask -- metric_name(request, response), customer_id(request); or AFORO_METRIC_NAME / AFORO_CUSTOMER_ID config
from aforo.middleware.flask import AforoMetering
AforoMetering(app, api_key=os.environ["AFORO_API_KEY"], metric_name="api_calls",
              customer_id=lambda req: req.headers.get("X-Customer-Id"))

# Django settings.py -- AFORO_METRIC_NAME: str or callable(request, response); AFORO_CUSTOMER_ID: str or callable(request)
MIDDLEWARE = [..., "aforo.middleware.django.AforoMeteringMiddleware"]
AFORO_API_KEY = os.environ["AFORO_API_KEY"]
AFORO_METRIC_NAME = "api_calls"
AFORO_PRODUCT_TYPE = "API"
```

`MiddlewareOptions` adds `product_type`, `metric_name`, `quantity`, `customer_id`, `metadata` (callables or constants), plus `exclude_paths` and `exclude_status_codes`. See the [user guide](USER_GUIDE.md#configuration-reference) for the full table.

## Walk me through it

The end-to-end path — install → configure → first metered event → confirm it landed in Aforo — is in **[USER_GUIDE.md](USER_GUIDE.md)**.

## What this doesn't cover

This SDK only **emits** usage events. It does not read entitlements, enforce quotas, or block requests — middleware always returns the original response, and metering failures are swallowed so they can't break your request path. Rate plans, pricing, and which `metric_name` values map to billable lines are configured in the Aforo console, not here. Broker- and gateway-side metering (Kong, EMQ X, etc.) live in their own plugins, not in this client.
