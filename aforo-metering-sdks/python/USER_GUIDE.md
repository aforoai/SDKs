# aforo-metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Python backend engineers wiring usage metering into an existing service.

## What you'll build

A Python service that reports billable usage to Aforo — either by calling `client.track(...)` at the exact point a billable action happens, or by adding one line of middleware that meters every HTTP request. By the end you'll have confirmed a real event reached the Aforo ingestor.

## Prerequisites

- Python **3.9+**.
- An Aforo **API key** (`AFORO_API_KEY`) from the Aforo console. The key carries your tenant scope.
- The `customer_id` you bill against (any stable string you own — a tenant's customer, an account, an API key id).
- If you're using middleware: FastAPI/Starlette, Django 4+, or Flask 2.3+ already in your project.

## Step 1 — Install the package

```bash
pip install -e .                  # from the cloned SDK source (not yet on PyPI)
# or, once published:  pip install aforo-metering
```

For middleware, add the matching extra:

```bash
pip install -e ".[fastapi]"       # or [django] / [flask]
```

## Step 2 — Set your credentials

The API key is the only required value. Keep it out of source:

```bash
export AFORO_API_KEY="sk_live_…"
```

`base_url` defaults to `https://ingest.aforo.ai`. Only override it to point at a non-production ingestor.

## Step 3 — Create a client and emit one event

```python
import os
from aforo import AforoClient

client = AforoClient(api_key=os.environ["AFORO_API_KEY"])

client.track(
    customer_id="cust_1",
    metric_name="api_calls",
    quantity=1,
    metadata={"endpoint": "/v1/translate", "region": "us-east"},
)
```

`track` returns immediately — the event is enqueued, not sent yet. `quantity` defaults to `1`; `occurred_at` defaults to now (ISO 8601, UTC); `idempotency_key` is auto-derived from `(customer_id, metric_name, quantity, occurred_at)` if you don't pass one.

> ⚠ `customer_id` and `metric_name` are both required. Calling `track()` without either raises `ValueError` — there's no silent no-op. Calling `track()` after `shutdown()` raises `RuntimeError`.

## Step 4 — Make delivery happen (and confirm it)

Three things flush the buffer: hitting `flush_count` (50 events), the background timer (`flush_interval`, 5 s), and `shutdown()` / interpreter exit. To force it now and read the result:

```python
result = client.flush()
print(result.sent, result.failed)   # e.g. 1 0
```

`flush()` is synchronous and thread-safe. `FlushResult.failed > 0` means the batch hit a non-retryable 4xx or exhausted retries — the events are gone, not re-queued.

## Step 5 — Verify it landed in Aforo

Two independent checks:

```python
# 1. Local: the SDK reported a successful send.
result = client.flush()
assert result.failed == 0 and result.sent >= 1
```

2. In the Aforo console, open the usage/events view for your tenant and filter by the `metric_name` you sent (`api_calls`). The event appears with the `customer_id`, `quantity`, and any `metadata` you attached. If `result.sent` is 1 but nothing shows in the console, jump to Troubleshooting — it's almost always a wrong `base_url` or a metric name that isn't mapped to a rate plan.

## Step 6 — Shut down cleanly

```python
client.shutdown()   # drains the buffer; safe to call once
```

`shutdown()` is registered via `atexit`, so a clean exit flushes for you. Call it explicitly in long-lived processes (workers, request handlers that build per-request clients) where you can't rely on interpreter exit. A `SIGKILL` or hard crash skips `atexit` — buffered-but-unflushed events are lost.

## Step 7 (alternative) — Meter every request with middleware

Skip per-call `track()` entirely. The middleware builds its own client and emits `"<METHOD> <normalized_path>"` per request.

**FastAPI / Starlette:**

```python
import os
from fastapi import FastAPI
from aforo.middleware.fastapi import AforoMeteringMiddleware

app = FastAPI()
app.add_middleware(AforoMeteringMiddleware, api_key=os.environ["AFORO_API_KEY"])
```

**Flask:**

```python
from aforo.middleware.flask import AforoMetering
AforoMetering(app, api_key=os.environ["AFORO_API_KEY"])
# or app.config["AFORO_API_KEY"] = "…" then AforoMetering(app)
```

**Django** (`settings.py`):

```python
MIDDLEWARE = [..., "aforo.middleware.django.AforoMeteringMiddleware"]
AFORO_API_KEY = os.environ["AFORO_API_KEY"]
```

> ⚠ The middleware only meters requests it can attribute to a customer. It reads `X-Customer-Id`, then falls back to `X-Api-Key` (Django also tries `request.user.id` first). **No customer ID → the request is silently not metered.** Set that header at your gateway/auth layer; do not trust a value the end client can spoof for a customer it doesn't own.

> ⚠ Default `exclude_paths` skip health/metrics/docs routes (`/health`, `/ready`, `/metrics`, `/favicon.ico`, plus `/openapi.json` and `/docs` on FastAPI, `/admin` and `/static` on Django, `/static` on Flask). Override `exclude_paths` to change this.

## Configuration reference

`AforoClient` / `AforoOptions`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `api_key` | `str` | required | Bearer token for the ingestor. |
| `base_url` | `str` | `https://ingest.aforo.ai` | Host only; `/v1/ingest/batch` is appended. |
| `flush_count` | `int` | `50` | Buffer threshold + max batch size. |
| `flush_interval` | `float` | `5.0` | Background flush cadence (seconds). |
| `max_queue_size` | `int` | `10000` | Ring-buffer cap; oldest dropped on overflow. |
| `max_retries` | `int` | `3` | Retries on 5xx/408/429. |
| `retry_base_s` | `float` | `1.0` | Backoff base: `retry_base_s * 2**attempt`. |
| `timeout` | `float` | `10.0` | Per-request timeout (seconds). |
| `shutdown_timeout` | `float` | `5.0` | Drain budget on shutdown. |

`track(...)` arguments:

| Argument | Type | Default | What it does |
|---|---|---|---|
| `customer_id` | `str` | required | Billed entity. |
| `metric_name` | `str` | required | Metric you're metering. |
| `quantity` | `float` | `1` | Amount of usage. |
| `idempotency_key` | `str?` | auto | Dedupe key; auto-derived if omitted. |
| `occurred_at` | `str?` | now | ISO-8601 event time (UTC). |
| `metadata` | `dict?` | `None` | Arbitrary key/values stored with the event. |
| `event` | `TrackEvent?` | `None` | Pass a `TrackEvent` instead of keyword args. |

`MiddlewareOptions` (extra knobs for the framework adapters): `metric_name`, `quantity`, `customer_id`, `metadata` (each a constant or a callable over the request/scope), `exclude_paths` (`list[str]`), `exclude_status_codes` (`list[int]`), plus `flush_count` / `flush_interval` / `max_queue_size` forwarded to the client.

### Session heartbeats (advanced)

`start_session(session_id, product_type="AI_AGENT")` / `end_session()` emit `system.session.heartbeat` events every 30 s for long-running sessions (e.g. agent runs), then a `SESSION_END` event on close. Use these only if your Aforo product is configured for session/heartbeat billing — otherwise stick to `track()`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `flush()` returns `sent=0, failed=0` | Buffer was empty — `track()` was never called, or another flush already drained it. | Confirm `client.buffered_count` before flushing; check you're calling the same client instance. |
| `FlushResult.failed > 0`, logs show "Ingestor returned 401/403 — not retrying" | Bad or unscoped API key. 4xx is non-retryable, so the batch is dropped. | Fix `AFORO_API_KEY`; verify the key belongs to the tenant you're sending for. |
| `sent` is positive but nothing in the console | Right delivery, wrong target or unmapped metric. | Confirm `base_url` host; confirm `metric_name` is attached to a rate plan / metric definition in Aforo. |
| Middleware never emits events | No `X-Customer-Id` / `X-Api-Key` on requests, or the path is excluded. | Set the customer header upstream; check your route isn't in `exclude_paths`. |
| Events lost on process restart | `SIGKILL`/crash skips `atexit`; buffered events never flushed. | Call `client.shutdown()` in your shutdown hook; lower `flush_interval`/`flush_count` for tighter delivery. |
| `RuntimeError: AforoClient is shut down` | `track()` called after `shutdown()`. | Build a fresh client, or don't shut down until you're done emitting. |
| Sudden gaps under burst load | Ring buffer hit `max_queue_size`; oldest events dropped to make room. | Raise `max_queue_size`, or lower `flush_interval` so the buffer drains faster. |

## What this guide does NOT cover

Defining metrics, rate plans, and pricing — that's done in the Aforo console, and the SDK only references metrics by name. It also doesn't cover entitlement checks or quota enforcement: this client emits events and never blocks a request. For broker/gateway-side metering (Kong, EMQ X) or other protocols (gRPC, GraphQL, WebSocket, MQTT, MCP), see the matching package in this SDK repo.
