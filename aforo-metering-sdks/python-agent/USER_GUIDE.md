# aforo-agent-metering — User Guide

**Version:** 0.3.2 · **Updated:** 2026-10-01 · **Audience:** Python engineers running an AI agent who need per-capability billing.

## What you'll build

An agent whose capability calls are metered: each call records one `ai_agent.capability_invocations` event with duration, token counts and status, batched to Aforo. You'll finish by confirming a real event in Aforo.

## Prerequisites

- Python **3.9+** and an asyncio runtime.
- An Aforo **API key** (`AFORO_API_KEY`), a **tenant id**, and the **product id** of an AI_AGENT product, from the Aforo console.
- Optional: `aiohttp` or `httpx` for the HTTP flush. Without either the SDK uses stdlib `urllib` in a thread.

## Step 1 — Install

```bash
pip install aforo-agent-metering            # or: pip install -e . from python-agent/
pip install "aforo-agent-metering[httpx]"   # or [aiohttp]
```

## Step 2 — Construct the client

Once, at startup, from trusted config:

```python
import os
from aforo_agent_metering import AforoAgentClient

client = AforoAgentClient(
    tenant_id="tenant_xxx",
    product_id="prod_ai_001",
    api_key=os.environ["AFORO_API_KEY"],
    on_drop=lambda events, reason: print("dropped", len(events), reason),
)
```

`tenant_id`, `product_id` and `api_key` are required; the constructor raises `ValueError` if one is empty or `flush_count <= 0`. `ingestor_url` defaults to `https://api.aforo.ai`.

> `tenant_id` comes from your config, never from a request an end user controls.

## Step 3 — Record a capability call

```python
client.record_capability(
    capability_name="summarize_url",
    agent_id="agt_001",          # ≤ 36 characters
    customer_id="cust_42",       # ≤ 64; defaults to default_customer_id, then agent_id
    session_id="sess_1",         # ≤ 64
    input_tokens=320,
    output_tokens=84,
    execution_status="SUCCESS",
    execution_duration_ms=510,
)
```

`record_capability` is synchronous and only buffers. It does not raise for event content: an event with a blank or over-limit field is not sent, is counted in `client.dropped_count`, and reaches `on_drop` with reason `"invalid"`.

Or wrap the handler and let the SDK time it and derive the status:

```python
from aforo_agent_metering import wrap_capability_handler

@wrap_capability_handler(client, capability_name="summarize_url")
async def summarize_url(url: str, *, agent_id: str, session_id: str, customer_id: str):
    ...
```

> ⚠ The decorator reads `agent_id`, `session_id` and `customer_id` from keyword arguments. Passed positionally they are not seen, and `agent_id` falls back to `"unknown"`.

## Step 4 — Start the flush loop

```python
await client.start()   # periodic flush every flush_interval_sec
```

## Step 5 — Flush and check delivery

```python
await client.flush()
print(client.dropped_count)   # 0 when everything was accepted
```

## Step 6 — Verify it landed in Aforo

In the Aforo console, open the usage view for your tenant and filter by metric `ai_agent.capability_invocations`. Each event shows `agentId`, the capability name, `executionStatus` and `executionDurationMs`.

## Step 7 — Shut down cleanly

```python
await client.shutdown()   # stops the flush loop, sends what is buffered
```

A hard crash skips this; events still in the buffer are lost.

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | required | Sent as `X-Tenant-Id`. |
| `product_id` | `str` | required | Stamped in `metadata.productId`. |
| `api_key` | `str` | required | Sent as `X-API-Key`. |
| `ingestor_url` | `str` | `https://api.aforo.ai` | Host; `/v1/ingest/batch` appended. |
| `default_customer_id` | `str?` | `None` | `customerId` fallback before `agent_id`. |
| `product_type` | `str` | `"AI_AGENT"` | Top-level `productType`; per-event override via `product_type=`. |
| `flush_count` | `int` | `50` | Flush threshold, clamped to 1000. |
| `flush_interval_sec` | `float` | `5.0` | Periodic flush cadence (needs `start()`). |
| `max_retries` | `int` | `3` | Attempts per batch. |
| `on_error` | `Callable?` | logs | Called on permanent batch failure. |
| `on_drop` | `Callable[[list[dict], str], None]?` | `None` | Called with lost events; `reason` is `retry_exhausted`, `rejected` or `invalid`. |

Methods: `record_capability(capability_name, agent_id, *, customer_id=None, session_id=None, input_tokens=0, output_tokens=0, execution_status="SUCCESS", execution_duration_ms=0, metadata=None, product_type=None)`, `record_step(agent_id, session_id, step_type, *, customer_id=None, capability_name=None, input_tokens=0, output_tokens=0, duration_ms=0, execution_status="SUCCESS", metadata=None, product_type=None)`, `start()`, `flush()`, `shutdown()`, `dropped_count`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No events at all | `await start()` never called and the buffer has not reached `flush_count`. | Call `await client.start()` once, or `await client.flush()`. |
| `dropped_count` rises, WARN "invalid event not sent" | Blank `capability_name` / `agent_id`, `agent_id` over 36 chars, or `session_id` / `customer_id` / `capability_name` over 64. | Fix the value at the source. The SDK does not truncate these. The one exception: a capability name over 64 that `wrap_capability_handler` reads from the wrapped call's `capability_name` kwarg is truncated to 64 and the event is still sent. |
| `on_error`: "Aforo returned 401/403 — not retrying" | Wrong API key, or a key from another tenant. | Fix `api_key`; confirm it belongs to `tenant_id`. |
| `on_drop` with `rejected` after a `202` | The ingestor rejected individual events (unknown metric, …); the WARN log carries each `errors[].message`. | Create the metric in the Aforo console or fix the event. |
| `on_drop` with `retry_exhausted` | 5xx, 408, 429 or network failure on every attempt. | Check `ingestor_url` and connectivity; persist the events in the hook and record them again later — their idempotency keys are unchanged. |
| A failed capability bills as `SUCCESS` | The handler returned an error value instead of raising. | Raise, or call `record_capability` yourself with the right `execution_status`. |
| Events lost on restart | Buffer not flushed before exit. | `await client.shutdown()` in your shutdown path. |

## What this guide does NOT cover

Pricing and per-capability rate plans are configured in the Aforo console. The SDK does not send session heartbeats and does not check quotas before a capability runs. For MCP tool calls use `aforo-mcp-metering`; for plain HTTP APIs use `aforo-metering`.
