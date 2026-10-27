# aforo-agent-metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-10-26 · **Audience:** Python engineers running an AI agent who need per-capability billing.

## What you'll build

An agent whose capability calls are metered: each call records one `ai_agent.capability_invocations` event with duration, token counts and status, batched to Aforo. You'll finish by confirming a real event in Aforo.

## Prerequisites

- Python **3.9+**. An asyncio runtime is needed only for the decorator and the `async` methods.
- An Aforo **API key** (`AFORO_API_KEY`), a **tenant id**, and the **product id** of an AI_AGENT product, from the Aforo console.
- `httpx` (installed with the package).

## Step 1 — Install

```bash
pip install aforo-agent-metering            # or: pip install -e . from python-agent/
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

`tenant_id`, `product_id` and `api_key` are required; the constructor raises `ValueError` if one is empty or `flush_count <= 0`. `ingestor_url` defaults to `https://api.aforo.ai` and must be `https://` (plain `http://` only for `localhost`, or with `allow_insecure_http=True`). If every event belongs to one customer, pass `default_customer_id="cust_42"`; it is the only fallback when a call passes no `customer_id`.

> `tenant_id` comes from your config, never from a request an end user controls.

## Step 3 — Record a capability call

```python
client.record_capability(
    capability_name="summarize_url",
    agent_id="agt_001",          # ≤ 36 characters
    customer_id="cust_42",       # ≤ 64; defaults to default_customer_id
    session_id="sess_1",         # ≤ 64
    input_tokens=320,
    output_tokens=84,
    execution_status="SUCCESS",
    execution_duration_ms=510,
)
```

`record_capability` is synchronous and only queues the event; it works with or without a running event loop. It does not raise for event content: an event with no customer, or a blank or over-limit field, is not sent, is counted in `client.dropped_count`, and reaches `on_drop` with reason `"invalid"`.

Or wrap the handler and let the SDK time it and derive the status:

```python
from aforo_agent_metering import wrap_capability_handler

@wrap_capability_handler(
    client,
    capability_name="summarize_url",
    customer_resolver=lambda args, kwargs: current_user().customer_id,
)
async def summarize_url(url: str, *, agent_id: str, session_id: str):
    ...
```

The decorator needs a customer source: `customer_resolver(args, kwargs)`, or `trust_customer_header=True` (bills the call's `customer_id` keyword argument — only when your own code sets it), or a `default_customer_id` on the client. With none, decorating raises `ValueError`.

> ⚠ The decorator reads `agent_id` and `session_id` from keyword arguments. Passed positionally they are not seen. A call with no `agent_id` still runs, but its event is dropped with reason `invalid` — nothing is billed to `"unknown"`.

## Step 4 — How events are sent

A background thread sends queued events in batches of up to `flush_count` (500) every `flush_interval_sec` (5 s), or sooner when `flush_count` are queued. It runs from construction; there is nothing to start (`start()` is kept and does nothing). The queue holds at most `max_queue_size` (10 000) events.

## Step 5 — Flush and check delivery

```python
left = await client.flush()   # or client.flush_sync() without an event loop
print(left, client.dropped_count)   # 0 0 when everything was accepted
```

## Step 6 — Verify it landed in Aforo

In the Aforo console, open the usage view for your tenant and filter by metric `ai_agent.capability_invocations`. Each event shows `agentId`, the capability name, `executionStatus` and `executionDurationMs`.

## Step 7 — Shut down cleanly

```python
await client.shutdown()   # sends what is queued, for at most shutdown_timeout_sec
# client.shutdown_sync() without an event loop
```

Events still queued at the deadline reach `on_drop` with reason `shutdown`. If you never call `shutdown()`, the same runs at interpreter exit. A hard crash (`SIGKILL`, out of memory) skips both.

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | required | Sent as `X-Tenant-Id`. |
| `product_id` | `str` | required | Stamped in `metadata.productId`. |
| `api_key` | `str` | required | Sent as `X-API-Key`. |
| `ingestor_url` | `str` | `https://api.aforo.ai` | Host; `/v1/ingest/batch` appended. `https://` only. |
| `default_customer_id` | `str?` | `None` | `customerId` when a call passes none. No other fallback. |
| `product_type` | `str` | `"AI_AGENT"` | Top-level `productType`; per-event override via `product_type=`. |
| `flush_count` | `int` | `500` | Batch size, clamped to 1000. |
| `flush_interval_sec` | `float` | `5.0` | Seconds between background sends. |
| `max_queue_size` | `int` | `10000` | Queue bound; the oldest events are dropped as `overflow` when full. |
| `max_retries` | `int` | `3` | Retries before the circuit breaker pauses sending (events stay queued). |
| `timeout_sec` | `float` | `10.0` | Per-request timeout. |
| `shutdown_timeout_sec` | `float` | `5.0` | Time limit for `shutdown()` and the exit hook. |
| `allow_insecure_http` | `bool` | `False` | Accept a non-localhost `http://` ingestor. |
| `on_error` | `Callable?` | logs at debug | Receives a `TransportError`; branch on `.kind`: `outage` / `auth` (events still queued and retried), `rejected` (the ingestor refused them; message carries its `errors[].message`), `shutdown`, `closed`. `.events` and `.status` say which events and which HTTP status. |
| `on_drop` | `Callable[[list[dict], str], None]?` | `None` | Called with lost events; `reason` is `overflow`, `rejected`, `invalid`, `shutdown` or `closed`. |

Methods: `record_capability(capability_name, agent_id, *, customer_id=None, session_id=None, input_tokens=0, output_tokens=0, execution_status="SUCCESS", execution_duration_ms=0, metadata=None, product_type=None)`, `record_step(agent_id, session_id, step_type, *, customer_id=None, capability_name=None, input_tokens=0, output_tokens=0, duration_ms=0, execution_status="SUCCESS", metadata=None, product_type=None)`, `flush()`, `flush_sync()`, `shutdown()`, `shutdown_sync()`, `dropped_count`. `start()` is kept and does nothing. `wrap_capability_handler(client, capability_name=None, *, customer_resolver=None, trust_customer_header=False)`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ValueError` when decorating | No customer source. | Pass `customer_resolver`, `trust_customer_header=True`, or set `default_customer_id`. |
| `dropped_count` rises with reason `invalid`, no events | No customer (none passed, no `default_customer_id`) or no `agent_id`. | Pass both, or set `default_customer_id`. |
| `dropped_count` rises, WARN "invalid event not sent" | Blank `capability_name` / `agent_id`, `agent_id` over 36 chars, or `session_id` / `customer_id` / `capability_name` over 64. | Fix the value at the source. The SDK does not truncate these. The one exception: a capability name over 64 that `wrap_capability_handler` reads from the wrapped call's `capability_name` kwarg is truncated to 64 and the event is still sent. |
| Events stay queued, one ERROR "rejected the API key" | 401/403 — treated as an outage, so events are kept and retried. | Fix `api_key`; confirm it belongs to `tenant_id`. |
| `on_drop` with `rejected` after a `202` | The ingestor rejected individual events (unknown metric, …); the WARN log carries each `errors[].message`. | Create the metric in the Aforo console or fix the event. |
| `on_drop` with `overflow` | The ingestor was unreachable long enough to fill `max_queue_size`. | Check `ingestor_url` and connectivity; raise `max_queue_size`, or persist the events in the hook and record them again later — their idempotency keys are unchanged. |
| A failed capability bills as `SUCCESS` | The handler returned an error value instead of raising. | Raise, or call `record_capability` yourself with the right `execution_status`. |
| Events lost on restart | The process was killed before the exit hook ran, or `shutdown_timeout_sec` was too short. | `await client.shutdown()` in your shutdown path; watch `on_drop` for `shutdown`. |

## What this guide does NOT cover

Pricing and per-capability rate plans are configured in the Aforo console. The SDK does not send session heartbeats and does not check quotas before a capability runs. For MCP tool calls use `aforo-mcp-metering`; for plain HTTP APIs use `aforo-metering`.
