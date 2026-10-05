# aforo-graphql-metering

Meter every GraphQL operation with AST-accurate complexity scoring — one Aforo event per query/mutation, via a Strawberry extension or an ASGI middleware that works with any GraphQL server.

**Version:** 1.2.2 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install:

```bash
pip install aforo-graphql-metering
# integrations (pick what you use):
pip install "aforo-graphql-metering[strawberry]"
pip install "aforo-graphql-metering[graphene]"
pip install "aforo-graphql-metering[ariadne]"
pip install "aforo-graphql-metering[httpx]"     # faster HTTP flush than stdlib urllib
```

**Install `1.2.2` or later. `1.0.0` on PyPI was built from an older copy of this code and lacks the fixes listed in the changelog.** If `1.2.2` is not on PyPI yet, install from source:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/python-graphql     # folder holding setup.py
pip install -e .
pip install -e ".[strawberry]"            # or [graphene] / [ariadne] / [httpx]
```

The one required dependency is `graphql-core>=3.2` — the SDK parses the operation document itself to score complexity. Without it, `record()` is a no-op.

## Quickstart — Strawberry

Best when you run a Strawberry schema and want per-operation billing without touching resolvers.

```python
import os, strawberry
from aforo_graphql_metering import AforoGraphQlBilling, strawberry_extension

billing = AforoGraphQlBilling(
    tenant_id="tenant_acme",
    product_id="prod_graphql_gateway",
    api_key=os.environ["AFORO_API_KEY"],
    ingestor_url="https://api.aforo.ai",
    schema_version="v2.1",
)

schema = strawberry.Schema(query=Query, extensions=[strawberry_extension(billing)])
```

## Quickstart — ASGI middleware (any GraphQL server)

```python
from starlette.applications import Starlette
from aforo_graphql_metering import AforoGraphQlBilling, asgi_middleware

billing = AforoGraphQlBilling(
    tenant_id="tenant_acme",
    product_id="prod_graphql_gateway",
    api_key=os.environ["AFORO_API_KEY"],
    ingestor_url="https://api.aforo.ai",
)
app = Starlette(routes=[...])
app = asgi_middleware(billing, path="/graphql")(app)   # only intercepts /graphql
```

Works with Ariadne, graphql-core HTTP, Graphene-ASGI, and custom ASGI GraphQL servers. Each metered operation produces one `graphql_api.operations` event POSTed to `https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>` and `X-Tenant-Id: <tenant_id>`.

> ⚠ Events are sent to the ingestor's **`/v1/ingest/batch`** path as `{"events": [...]}`, at most 1000 events per request (larger buffers are split). Set `ingestor_url` to the host only — the SDK appends the path. Use `https://api.aforo.ai`.

> `tenant_id` is fixed from your config and sent as a header — never read from a caller-controlled value. The default customer-ID extractor reads `x-customer-id` from request headers (or the Strawberry context); operations with no resolvable customer ID are **not** metered.

## Configuration

Constructor arguments for `AforoGraphQlBilling(...)`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | — (required) | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | — (required) | Product the operations bill against. |
| `api_key` | `str` | — (required) | Aforo API key, sent to the ingestor as `X-API-Key`. |
| `ingestor_url` | `str` | — (required) | Host; `/v1/ingest/batch` is appended. |
| `schema_version` | `str?` | `None` | Stamped on each event for versioned-schema reporting. |
| `flush_interval_sec` | `float` | `5.0` | Background flush cadence (a daemon thread runs from construction). |
| `flush_count` | `int` | `50` | Buffer size that triggers an immediate flush. |
| `on_error` | `Callable[[Exception], None]?` | logs | Called on permanent batch failure, and with the ingestor's `errors[].message` when it rejects events. |
| `on_drop` | `Callable[[list[dict], str], None]?` | `None` | Called with events that will not be delivered and the reason (`invalid`, `rejected`, `retry_exhausted`). See [Dropped events](#dropped-events). Pass by keyword. |
| `product_type` | `str` | `"GRAPHQL_API"` | Top-level `productType` sent on every event (trimmed and upper-cased; values the SDK does not know are passed through). Override per event with `record(..., product_type=...)`. |
| `customer_id_extractor` | `Callable[[Any], str?]?` | reads `x-customer-id` | Resolve the billed customer from the request/context. |
| `complexity_scorer` | `Callable[[doc, op_name], (int, int)]?` | `field_count + 5 × max_depth` | Returns `(complexity, field_count)`. |

Retry is fixed at **3 attempts** (`1s / 2s` backoff between them); 408 and 5xx are retried, 429 waits for `Retry-After` (capped at 60 s), and any other 4xx is not retried and the batch is dropped with reason `rejected`.

## Execution status (`executionStatus`)

Each event can carry an execution status. OUTCOME_BASED rate plans bill each event at the weight set for its status; events without one bill at full price.

The Strawberry extension and the ASGI middleware derive it from the GraphQL result:

| Result | `executionStatus` |
|---|---|
| no `errors` | `SUCCESS` |
| `errors` and non-null `data` | `PARTIAL` |
| `errors` and `data: null` (failed during execution) | `ERROR` |
| `errors` and no `data` key (parse / validation failure) | `VALIDATION_FAILED` |

`errors` counts as present unless it's `null` or an empty list. An `ExecutionResult` (Strawberry, graphql-core) always has `data`, so there a null `data` whose errors all lack a `path` (parse / validation errors) is `VALIDATION_FAILED`.

The middleware reads the response body when it's an uncompressed JSON object of at most 1 MiB. Otherwise it uses the HTTP status: 2xx/3xx `SUCCESS`, 408/504 `TIMEOUT`, 499 `CANCELLED`, 400/422 `VALIDATION_FAILED`, 401/403/429 `BLOCKED`, other 4xx/5xx `ERROR`. Both rules are exported: `outcome_from_graphql_result(...)`, `outcome_from_http_status(...)`.

A value you pass yourself always wins:

```python
billing.record(customer_id, query, "GetUser", duration_ms, has_errors,
               execution_status="PARTIAL")        # or result=..., http_status=...

asgi_middleware(billing, path="/graphql",
                execution_status_resolver=lambda scope: None)  # None keeps the derived value
strawberry_extension(billing, execution_status_resolver=lambda execution_context: None)
```

These arguments are keyword-only. The SDK trims and upper-cases the value and leaves it off the event when it's blank. Calling `record()` without `execution_status`, `result` or `http_status` sends no status. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED` — any other value is logged as a warning and left off the event, since the ingestor would reject the event.

## Dropped events

An event that will never reach Aforo is counted in `billing.dropped_count`, logged at WARNING, and passed to the opt-in `on_drop(events, reason)` hook. The events keep their idempotency keys, so sending them again later cannot double-bill.

| Reason | When |
|---|---|
| `invalid` | The event failed a client-side check (a blank `customer_id` or one longer than 64 characters). It is not buffered or sent. `record()` does not raise for event content. An over-long operation name does not drop the event: it is read from the client's query, so it is truncated to 255 characters and the event is sent (one WARNING per client). |
| `rejected` | The ingestor answered 4xx (other than 408 / 429) for the batch, or refused individual events inside a 202 response. |
| `retry_exhausted` | Network errors, 5xx, 408 or 429 on all 3 attempts. |

```python
def on_drop(events, reason):
    dead_letter.write(reason, events)

billing = AforoGraphQlBilling(..., on_drop=on_drop)
```

When a 202 response reports refused events without a usable `index`, they are counted in `dropped_count` but not passed to the hook, since the SDK cannot tell which events they were. Exceptions raised by the hook are swallowed. An unknown `executionStatus` is not a drop: the field is left off and the event is still sent.

## Walk me through it

Install → wire the extension → run a query → confirm the event in Aforo, step by step, is in **[USER_GUIDE.md](USER_GUIDE.md)**.

## What this doesn't cover

It meters **operations**, not individual resolver fields or DataLoader batches — one event per top-level operation, with complexity/field counts as attributes. It doesn't enforce a complexity budget or reject expensive queries; that's a gateway/server concern. GraphQL subscriptions over WebSocket aren't covered here — use `aforo-ws-metering`. Pricing and metric mapping are in the Aforo console.
