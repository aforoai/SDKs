# aforo-graphql-metering

Meter every GraphQL operation with AST-accurate complexity scoring — one Aforo event per query/mutation, via a Strawberry extension or an ASGI middleware that works with any GraphQL server.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

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

**Install `2.0.0` or later. `1.0.0` on PyPI was built from an older copy of this code and lacks the fixes listed in the changelog.** If `2.0.0` is not on PyPI yet, install from source:

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

schema = strawberry.Schema(query=Query, extensions=[
    # The customer your auth put on the context -- required.
    strawberry_extension(billing, customer_resolver=lambda context: context["user"].customer_id),
])
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
app = asgi_middleware(billing, path="/graphql",        # only intercepts /graphql
                      customer_resolver=lambda scope: scope["user"].customer_id)(app)
```

Works with Ariadne, graphql-core HTTP, Graphene-ASGI, and custom ASGI GraphQL servers. Each metered operation produces one `graphql_api.operations` event POSTed to `https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>` and `X-Tenant-Id: <tenant_id>`.

> ⚠ Events are sent to the ingestor's **`/v1/ingest/batch`** path as `{"events": [...]}`, at most 1000 events per request (larger buffers are split). Set `ingestor_url` to the host only — the SDK appends the path. Use `https://api.aforo.ai`.

> `tenant_id` is fixed from your config and sent as a header — never read from a caller-controlled value. **The customer must come from identity you verified:** pass `customer_resolver=` to `strawberry_extension` (called with Strawberry's context) or `asgi_middleware` (called with the ASGI scope), or `customer_id_extractor=` to `AforoGraphQlBilling`. Reading the `x-customer-id` header needs `trust_customer_header=True`, because the client sets it. With neither, the integration raises `ValueError` when you build it. An operation whose resolver returns nothing runs normally, is not metered, and is counted in `dropped_count` as `invalid`.
>
> The ASGI middleware keeps at most `max_request_body_bytes` (default 1 MiB) of the request body to read the query, and parses and scores it on its own pool of `meter_workers` threads (default 2), never on the event loop and never on your application's default executor; `billing.shutdown()` stops the pool. A bigger request is served normally and counted as `invalid` (not metered). The Strawberry extension reuses the document Strawberry already parsed.

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
| `flush_count` | `int` | `500` | Events per request, and the queue size that wakes the sender early (at most 1000). |
| `on_error` | `Callable[[Exception], None]?` | logs | Receives a `TransportError`; branch on `.kind`: `outage` / `auth` (events still queued and retried), `rejected` (the ingestor refused them; message carries its `errors[].message`), `shutdown`, `closed`. `.events` and `.status` say which events and which HTTP status. |
| `on_drop` | `Callable[[list[dict], str], None]?` | `None` | Called with events that will not be delivered and the reason (`overflow`, `rejected`, `invalid`, `shutdown`, `closed`). See [Dropped events](#dropped-events). Pass by keyword. |
| `product_type` | `str` | `"GRAPHQL_API"` | Top-level `productType` sent on every event (trimmed and upper-cased; values the SDK does not know are passed through). Override per event with `record(..., product_type=...)`. |
| `max_queue_size` | `int` | `10000` | Queue capacity; the oldest event is dropped as `overflow` when full. Keyword-only. |
| `timeout_sec` | `float` | `10.0` | Total deadline per HTTP request. Keyword-only. |
| `shutdown_timeout_sec` | `float` | `5.0` | `shutdown()` flushes for at most this long; leftovers are dropped as `shutdown`. Keyword-only. |
| `allow_insecure_http` | `bool` | `False` | Allow plain `http://` to a host other than localhost. Keyword-only. |
| `http_transport`, `transport_options` | | `None` | An `httpx` transport / extra transport-core settings, for tests and unusual networks. Keyword-only. |
| `customer_id_extractor` | `Callable[[Any], str?]?` | `None` | Customer resolver the integrations use (Strawberry context; ASGI: `{"request": headers, "scope": scope}`). Required unless the integration gets `customer_resolver=` or `trust_customer_header=True`. |
| `trust_customer_header` | `bool` | `False` | Bill the `x-customer-id` header as sent. Keyword-only. |
| `complexity_scorer` | `Callable[[doc, op_name], (int, int)]?` | `field_count + 5 × max_depth` | Returns `(complexity, field_count)`. |

Delivery uses the shared transport core: `push()`/`record()` only queue (bounded by `max_queue_size`, default 10 000; the oldest event is dropped as `overflow` when full) and one background thread sends batches of up to `flush_count` events (default 500, at most 1000; a body over 4 MiB is split). Network errors, timeouts, 408, 429 and 5xx are retried 3 times with full-jitter backoff; `Retry-After` is honoured as seconds or an HTTP date, capped at 60 s. After that, or on 401/403 (logged at ERROR: the API key is wrong or revoked), the batch goes back to the front of the queue with the same idempotency keys and the sender pauses (full jitter, at most 5 s at first and at least 250 ms, growing to 5 min) — an outage loses nothing unless the queue fills. A redirect (3xx) is never followed, so the API key cannot reach another host; it is treated like 401/403 and logged at ERROR with the target host. Events the ingestor marks `retryable` in a 2xx are re-sent with the same keys after the same backoff, at most 3 times. Each request's `timeout_sec` covers the whole exchange, including reading the response. `flush()` during an outage makes one attempt. `shutdown()` keeps retrying until its deadline. An event that cannot be turned into JSON is dropped as `invalid` when you push it. A 413 splits the batch; any other 4xx drops it with reason `rejected`. `shutdown()` (also run at interpreter exit) flushes for at most `shutdown_timeout_sec` (default 5 s). `ingestor_url` must be `https://`; plain `http://` only for localhost / 127.0.0.1 / ::1 or with `allow_insecure_http=True`. The API key is sent only as `X-API-Key` and never appears in `repr()` or logs.

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
| `overflow` | The queue was full (usually a long ingest outage); the oldest event was evicted. |
| `shutdown` | Still queued when `shutdown()` reached `shutdown_timeout_sec`. |
| `closed` | Sent after `shutdown()`. |

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
