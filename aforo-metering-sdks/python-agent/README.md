# aforo-agent-metering

Meter AI agent runs from Python: record each capability invocation and reasoning step as an `AI_AGENT` usage event, buffered and batched to Aforo. For agent runtimes such as LangChain, LlamaIndex, CrewAI, AutoGen and FastAPI-hosted agents. Python sibling of `@aforoai/agent-metering` (Node).

**Version:** 1.0.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

```bash
pip install aforo-agent-metering
```

The package depends on `httpx`. 1.0.0 changes who is billed when no customer is given; see the [changelog](CHANGELOG.md) before upgrading from 0.x.

From source:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/python-agent
pip install -e .
```

## Quickstart

```python
import asyncio
import os
from aforo_agent_metering import AforoAgentClient

async def main():
    client = AforoAgentClient(
        tenant_id="tenant_xxx",
        product_id="prod_ai_001",
        api_key=os.environ["AFORO_API_KEY"],
        # ingestor_url defaults to https://api.aforo.ai
    )

    client.record_capability(   # synchronous: buffers the event
        capability_name="summarize_email",
        agent_id="agt_001",
        customer_id="cust_42",
        session_id="sess_1",
        input_tokens=320,
        output_tokens=84,
        execution_duration_ms=510,
    )

    await client.shutdown()     # sends what is left (also runs at exit)

asyncio.run(main())
```

`record_capability` and `record_step` only queue the event; they need no event loop and never block. A background thread sends batches. Nothing has to be started (`start()` still exists and does nothing). Code without an event loop can use `client.flush_sync()` and `client.shutdown_sync()`.

Events POST to `https://api.aforo.ai/v1/ingest/batch` as `{"events": [...]}` with `X-API-Key: <api_key>` and `X-Tenant-Id: <tenant_id>`. No `Authorization` header is sent.

## Decorator

```python
from aforo_agent_metering import AforoAgentClient, wrap_capability_handler

client = AforoAgentClient(...)

@wrap_capability_handler(
    client,
    capability_name="summarize_email",
    customer_resolver=lambda args, kwargs: current_user().customer_id,
)
async def summarize_email(text: str, *, agent_id: str, session_id: str):
    ...
```

The decorator needs to know who to bill. Give it one of:

- `customer_resolver(args, kwargs)` — returns the customer from something your service authenticated.
- `trust_customer_header=True` — bills the call's `customer_id` keyword argument. Only when that value comes from your own trusted code, not from an end user.
- `default_customer_id` on the client — bills every call to that customer (single-customer deployments).

With none of these, decorating raises `ValueError`. `agent_id` is read from the call's keyword arguments; a call without one is not sent (reason `invalid`). Before 1.0.0 a missing customer was billed to the `agent_id`, and a missing agent to `"unknown"`.

The decorator times the handler, records one invocation when it finishes, and re-raises whatever the handler raised. Status: returned → `SUCCESS`; `TimeoutError` → `TIMEOUT`; any other exception → `ERROR`; `asyncio.CancelledError` / `KeyboardInterrupt` / `SystemExit` → `CANCELLED`. The handler must be `async def`.

## Configuration

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | — (required) | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | — (required) | AI_AGENT product the events bill against; stamped in `metadata.productId`. |
| `api_key` | `str` | — (required) | Aforo API key, sent as `X-API-Key`. |
| `ingestor_url` | `str` | `https://api.aforo.ai` | Host; `/v1/ingest/batch` is appended. |
| `default_customer_id` | `str?` | `None` | `customerId` when a call passes none. The only fallback: without it, an event with no customer is dropped as `invalid`. |
| `product_type` | `str` | `"AI_AGENT"` | Top-level `productType` on every event (trimmed + upper-cased). Override per event with `record_capability(..., product_type=...)`. |
| `flush_count` | `int` | `500` | Batch size; a queue this long wakes the sender (clamped to 1000, the ingestor's batch limit). |
| `flush_interval_sec` | `float` | `5.0` | Seconds between background sends. |
| `max_queue_size` | `int` | `10000` | Events held in memory. When full, the oldest are dropped with reason `overflow`. |
| `max_retries` | `int` | `3` | Retries per batch before the circuit breaker pauses sending. The events stay queued. |
| `timeout_sec` | `float` | `10.0` | Per-request timeout. |
| `shutdown_timeout_sec` | `float` | `5.0` | Time limit for `shutdown()` and the exit hook. |
| `allow_insecure_http` | `bool` | `False` | Accept a plain `http://` ingestor that isn't `localhost`. Otherwise `ingestor_url` must be `https://`. |
| `on_error` | `Callable[[Exception], None]?` | logs at debug | Receives a `TransportError`; branch on `.kind`: `outage` / `auth` (events still queued and retried), `rejected` (the ingestor refused them; message carries its `errors[].message`), `shutdown`, `closed`. `.events` and `.status` say which events and which HTTP status. |
| `on_drop` | `Callable[[list[dict], str], None]?` | `None` | Opt-in hook for events the SDK loses for good. |
| `post_fn` | `PostFn?` | `None` (httpx) | Async `(url, headers, body) -> (status, body[, retry_after])` used instead of httpx, for tests. Runs on the sender thread. |

### Execution status

`execution_status` is trimmed and upper-cased. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED` (exported as `EXECUTION_STATUSES`). A blank or unknown value is logged and left off; the event is still sent. OUTCOME_BASED rate plans bill each event at the weight set for its status — see the [repository README](../README.md#reporting-the-request-outcome-executionstatus).

### Retries and dropped events

One background thread sends, one request at a time, over one pooled connection. Network errors, timeouts, 408, 429, 5xx, 401 and 403 are an outage: the batch is retried with jittered backoff (`Retry-After` read as seconds or an HTTP date, capped at 60 s), then a circuit breaker pauses sending and the events stay queued. Nothing is dropped for being unreachable — only when the queue is full. Any other 4xx drops the batch as `rejected`; a 413 splits it first. Every 5xx is retried, not only 500/502/503/504. A redirect (3xx) is never followed, so the API key cannot reach another host; it is treated like 401/403 and logged at ERROR with the target host. The circuit-breaker pause is full jitter: at most 5 s at first and at least 250 ms, growing to 5 min. Each request's `timeout_sec` covers the whole exchange, including reading the response. A flush during an outage makes one attempt; shutdown keeps retrying until its deadline. An event that cannot be turned into JSON is dropped as `invalid` when it is recorded.

`record_capability` and `record_step` never raise for event content. Every event the SDK cannot deliver is counted in `client.dropped_count`, WARN-logged, and passed to `on_drop(events, reason)`. Dropped events keep their idempotency keys.

| `reason` | When |
|---|---|
| `overflow` | The queue was full (`max_queue_size`); the oldest events were dropped to make room. |
| `shutdown` | Still queued when `shutdown()` or the exit hook reached `shutdown_timeout_sec`. |
| `closed` | Recorded after `shutdown()`. |
| `rejected` | A non-retryable 4xx for the batch (`on_error` gets the ingestor's `errors[].message`), a batch that could not be JSON-encoded, or events the ingestor rejected individually in a `202`. For a `202`, only the events the response names by index are passed to the hook; if it names none, they are counted only. |
| `invalid` | The SDK refused the event before queueing it: no customer (none passed and no `default_customer_id`), blank `capability_name` / `agent_id` (or `session_id` / `step_type` for a step), `agent_id` over 36 characters, `session_id`, `customer_id` or `capability_name` over 64 UTF-16 code units. Nothing passed to `record_*` or to the decorator is truncated. The one exception: a capability name that `wrap_capability_handler` reads from the wrapped call's `capability_name` kwarg is truncated to 64 and the event is still sent. The WARN names the field and limit; it is logged on the first occurrence and then every 1000th. |

## Wire format

Each event carries top-level `customerId`, `metricName` (`ai_agent.capability_invocations` or `ai_agent.steps`), `quantity` 1, `occurredAt`, `idempotencyKey` (`agent:<uuid4>`, minted once when the event is created), `productType`, `agentId`, `sessionId`, `executionDurationMs`, optional `executionStatus`, and `metadata` with `capability_name` (snake_case — the key the ingestor maps to the per-capability billing dimension), token counts and `sdkVersion`.

The endpoint path and body shape are checked against `contract/ingest-contract.json` by this package's tests.

## Walk me through it

Install → construct → record → confirm the event in Aforo: **[USER_GUIDE.md](USER_GUIDE.md)**. A runnable example is in [`examples/hello_agent`](examples/hello_agent).

## What this doesn't cover

This SDK emits usage events. It does not send session heartbeats, check entitlements or quotas, or price anything — rate plans and per-capability pricing are configured in the Aforo console. A process killed with `SIGKILL` (or out of memory) loses whatever was still queued.
