# aforo-agent-metering

Meter AI agent runs from Python: record each capability invocation and reasoning step as an `AI_AGENT` usage event, buffered and batched to Aforo. For agent runtimes such as LangChain, LlamaIndex, CrewAI, AutoGen and FastAPI-hosted agents. Python sibling of `@aforoai/agent-metering` (Node).

**Version:** 0.3.2 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

```bash
pip install aforo-agent-metering
# pick an async HTTP client (optional — stdlib urllib is the fallback):
pip install "aforo-agent-metering[aiohttp]"
pip install "aforo-agent-metering[httpx]"
```

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
    await client.start()  # begin the periodic flush task

    client.record_capability(   # synchronous: buffers the event
        capability_name="summarize_email",
        agent_id="agt_001",
        customer_id="cust_42",
        session_id="sess_1",
        input_tokens=320,
        output_tokens=84,
        execution_duration_ms=510,
    )

    await client.shutdown()     # final flush

asyncio.run(main())
```

Events POST to `https://api.aforo.ai/v1/ingest/batch` as `{"events": [...]}` with `X-API-Key: <api_key>` and `X-Tenant-Id: <tenant_id>`. No `Authorization` header is sent.

## Decorator

```python
from aforo_agent_metering import AforoAgentClient, wrap_capability_handler

client = AforoAgentClient(...)

@wrap_capability_handler(client, capability_name="summarize_email")
async def summarize_email(text: str, *, agent_id: str, session_id: str, customer_id: str):
    ...
```

The decorator times the handler, records one invocation when it finishes, and re-raises whatever the handler raised. Status: returned → `SUCCESS`; `TimeoutError` → `TIMEOUT`; any other exception → `ERROR`; `asyncio.CancelledError` / `KeyboardInterrupt` / `SystemExit` → `CANCELLED`. The handler must be `async def`.

## Configuration

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | — (required) | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | — (required) | AI_AGENT product the events bill against; stamped in `metadata.productId`. |
| `api_key` | `str` | — (required) | Aforo API key, sent as `X-API-Key`. |
| `ingestor_url` | `str` | `https://api.aforo.ai` | Host; `/v1/ingest/batch` is appended. |
| `default_customer_id` | `str?` | `None` | `customerId` when a call passes none. Falls back to `agent_id`. |
| `product_type` | `str` | `"AI_AGENT"` | Top-level `productType` on every event (trimmed + upper-cased). Override per event with `record_capability(..., product_type=...)`. |
| `flush_count` | `int` | `50` | Buffered events that trigger a flush (clamped to 1000, the ingestor's batch limit). |
| `flush_interval_sec` | `float` | `5.0` | Periodic flush cadence. Requires `await start()`. |
| `max_retries` | `int` | `3` | Attempts per batch. |
| `on_error` | `Callable[[Exception], None]?` | logs a WARN | Called on a permanent batch failure. |
| `on_drop` | `Callable[[list[dict], str], None]?` | `None` | Opt-in hook for events the SDK loses. |
| `post_fn` | `PostFn?` | aiohttp → httpx → urllib | HTTP transport override, for tests. |

### Execution status

`execution_status` is trimmed and upper-cased. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED` (exported as `EXECUTION_STATUSES`). A blank or unknown value is logged and left off; the event is still sent. OUTCOME_BASED rate plans bill each event at the weight set for its status — see the [repository README](../README.md#reporting-the-request-outcome-executionstatus).

### Retries and dropped events

Retry: 5xx, 408, 429 and network errors, with `1s / 2s` backoff; a 429 waits for its `Retry-After`. Any other 4xx is not retried.

`record_capability` and `record_step` never raise for event content. Every event the SDK cannot deliver is counted in `client.dropped_count`, WARN-logged, and passed to `on_drop(events, reason)`. Dropped events keep their idempotency keys.

| `reason` | When |
|---|---|
| `retry_exhausted` | The batch still failed after `max_retries` attempts. |
| `rejected` | A non-retryable 4xx for the batch (`on_error` gets the ingestor's `errors[].message`), a batch that could not be JSON-encoded, or events the ingestor rejected individually in a `202`. For a `202`, only the events the response names by index are passed to the hook; if it names none, they are counted only. |
| `invalid` | The SDK refused the event before buffering it: blank `capability_name` / `agent_id` (or `session_id` / `step_type` for a step), `agent_id` over 36 characters, `session_id`, `customer_id` or `capability_name` over 64. Nothing passed to `record_*` or to the decorator is truncated. The one exception: a capability name that `wrap_capability_handler` reads from the wrapped call's `capability_name` kwarg is truncated to 64 and the event is still sent. The WARN names the field and limit; it is logged on the first occurrence and then every 1000th. |

## Wire format

Each event carries top-level `customerId`, `metricName` (`ai_agent.capability_invocations` or `ai_agent.steps`), `quantity` 1, `occurredAt`, `idempotencyKey` (`agent:<uuid4>`, minted once when the event is created), `productType`, `agentId`, `sessionId`, `executionDurationMs`, optional `executionStatus`, and `metadata` with `capability_name` (snake_case — the key the ingestor maps to the per-capability billing dimension), token counts and `sdkVersion`.

The endpoint path and body shape are checked against `contract/ingest-contract.json` by this package's tests.

## Walk me through it

Install → construct → record → confirm the event in Aforo: **[USER_GUIDE.md](USER_GUIDE.md)**. A runnable example is in [`examples/hello_agent`](examples/hello_agent).

## What this doesn't cover

This SDK emits usage events. It does not send session heartbeats, check entitlements or quotas, or price anything — rate plans and per-capability pricing are configured in the Aforo console. `record_capability` / `record_step` only buffer; without `await start()` or an explicit `await flush()` nothing is sent until the buffer reaches `flush_count` inside a running event loop.
