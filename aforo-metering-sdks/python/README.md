# aforo-metering

Track API usage events from any Python service and let Aforo handle buffering, batching, and retry — plus drop-in middleware for FastAPI, Django, and Flask that meters every request without touching your handlers.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install:

```bash
pip install aforo-metering
# framework extras (pick what you use):
pip install "aforo-metering[fastapi]"
pip install "aforo-metering[django]"
pip install "aforo-metering[flask]"
```

**Not yet on PyPI — install from source for now.** Clone the SDK repo and install this package in editable mode:

```bash
git clone https://github.com/aforoai/aforo-metering-python.git
cd aforo-metering-python          # the folder holding pyproject.toml
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

client = AforoClient(api_key=os.environ["AFORO_API_KEY"])

client.track(
    customer_id="cust_1",      # who is billed
    metric_name="api_calls",   # what you're metering
    quantity=1,
)

# Force a synchronous flush when you need delivery confirmed:
result = client.flush()        # FlushResult(sent=..., failed=...)

# Graceful shutdown drains the buffer. Also registered via atexit,
# so a clean interpreter exit flushes for you.
client.shutdown()
```

Events POST to `https://ingest.aforo.ai/v1/ingest/batch` with `Authorization: Bearer <api_key>`. The client appends `/v1/ingest/batch` to `base_url`, so set `base_url` to the host only.

> Tenant scope comes from the API key — there is no `tenant_id` argument on this SDK. `customer_id` is the entity you bill within that tenant. Never feed `customer_id` from a client-settable request header you don't trust.

## Configuration

Pass these as keyword args to `AforoClient(...)`, or build an `AforoOptions` and pass `options=`.

| Option | Type | Default | What it does |
|---|---|---|---|
| `api_key` | `str` | — (required) | Bearer token sent on every batch. |
| `base_url` | `str` | `https://ingest.aforo.ai` | Ingestor host. `/v1/ingest/batch` is appended automatically. |
| `flush_count` | `int` | `50` | Buffered events that trigger a flush. Also the max batch size per request. |
| `flush_interval` | `float` | `5.0` | Seconds between background timer flushes. |
| `max_queue_size` | `int` | `10000` | Ring-buffer capacity. On overflow the **oldest** event is dropped. |
| `max_retries` | `int` | `3` | Retries on 5xx / 408 / 429 with exponential backoff. |
| `retry_base_s` | `float` | `1.0` | Base delay for backoff (`retry_base_s * 2**attempt`). |
| `timeout` | `float` | `10.0` | Per-request HTTP timeout in seconds. |
| `shutdown_timeout` | `float` | `5.0` | Graceful-shutdown drain budget. |

Retry rules, fixed in the transport and not configurable beyond the values above: retry on **5xx, 408, 429**; honor `Retry-After` on 429; **never** retry other 4xx (the batch is dropped and counted as `failed`).

### Framework middleware

Each adapter constructs its own `AforoClient` and emits one event per request. Customer ID is read from `X-Customer-Id` (falling back to `X-Api-Key`); a request with no resolvable customer ID is **not** metered.

```python
# FastAPI / Starlette
from aforo.middleware.fastapi import AforoMeteringMiddleware
app.add_middleware(AforoMeteringMiddleware, api_key=os.environ["AFORO_API_KEY"])

# Flask
from aforo.middleware.flask import AforoMetering
AforoMetering(app, api_key=os.environ["AFORO_API_KEY"])

# Django settings.py
MIDDLEWARE = [..., "aforo.middleware.django.AforoMeteringMiddleware"]
AFORO_API_KEY = os.environ["AFORO_API_KEY"]
```

`MiddlewareOptions` adds `metric_name`, `quantity`, `customer_id`, `metadata` (callables or constants), plus `exclude_paths` and `exclude_status_codes`. See the [user guide](USER_GUIDE.md#configuration-reference) for the full table.

## Walk me through it

The end-to-end path — install → configure → first metered event → confirm it landed in Aforo — is in **[USER_GUIDE.md](USER_GUIDE.md)**.

## What this doesn't cover

This SDK only **emits** usage events. It does not read entitlements, enforce quotas, or block requests — middleware always returns the original response, and metering failures are swallowed so they can't break your request path. Rate plans, pricing, and which `metric_name` values map to billable lines are configured in the Aforo console, not here. Broker- and gateway-side metering (Kong, EMQ X, etc.) live in their own plugins, not in this client.
