# aforo-graphql-metering — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** Python engineers running a GraphQL server who need per-operation billing.

## What you'll build

A GraphQL server that reports one Aforo event per operation, with AST-derived complexity and field counts attached — wired either through the Strawberry extension or the framework-agnostic ASGI middleware. You'll finish by confirming a real query reached the Aforo ingestor.

## Prerequisites

- Python **3.9+** and `graphql-core>=3.2` (the SDK's only hard dependency).
- An Aforo **API key**, **tenant id**, and **product id** from the Aforo console.
- A GraphQL server: Strawberry (extension path) or anything ASGI (middleware path).
- A function that returns the customer for a request from identity your service verified.

## Step 1 — Install

```bash
pip install -e .                    # from python-graphql/ (or: pip install "aforo-graphql-metering>=2.0.0")
pip install -e ".[strawberry]"      # or [graphene] / [ariadne] / [httpx]
```

## Step 2 — Construct the billing client

```python
import os
from aforo_graphql_metering import AforoGraphQlBilling

billing = AforoGraphQlBilling(
    tenant_id="tenant_acme",
    product_id="prod_graphql_gateway",
    api_key=os.environ["AFORO_API_KEY"],
    ingestor_url="https://api.aforo.ai",
    schema_version="v2.1",
)
```

`tenant_id`, `product_id`, `api_key`, and `ingestor_url` are required — the constructor raises `ValueError` if any is missing.

> ⚠ `ingestor_url` is the **host**. This package appends `/v1/ingest/batch`. Pass `https://api.aforo.ai`, not the full path.

## Step 3 — Wire it into your server

**Strawberry** — add the extension to the schema:

```python
import strawberry
from aforo_graphql_metering import strawberry_extension

schema = strawberry.Schema(query=Query, extensions=[strawberry_extension(billing)])
```

**Any ASGI server** — wrap the app and scope it to your GraphQL path:

```python
from aforo_graphql_metering import asgi_middleware
app = asgi_middleware(billing, path="/graphql",
                      customer_resolver=lambda scope: scope["user"].customer_id)(app)
```

> ⚠ The middleware only meters POSTs to the `path` you give it (default `/graphql`). If your server mounts GraphQL elsewhere, set `path` accordingly or no events fire.

## Step 4 — Make sure the customer ID resolves

Every integration needs a customer resolver: `customer_resolver=` on `strawberry_extension` / `asgi_middleware`, or `customer_id_extractor=` on the client. Without one, building the integration raises `ValueError`. An operation whose resolver returns nothing still runs; it is not metered and is counted as an `invalid` drop.

```python
billing = AforoGraphQlBilling(
    # ...
    customer_id_extractor=lambda ctx: verify_jwt(ctx["request"].headers["authorization"])["sub"],
)
```

> ⚠ Resolve `customer_id` server-side from something you trust (a verified JWT, your auth middleware). `trust_customer_header=True` bills the `x-customer-id` header as sent; any client can set it to any customer, so use it only behind a gateway that overwrites it.

## Step 5 — Run an operation and flush

Execute any query/mutation against your server. `record()` only queues; one background thread sends batches of up to `flush_count` (500) events every `flush_interval_sec` (5 s), sooner when 500 are queued. If the ingestor is down, batches stay queued and are retried after a pause. To send now and wait (`flush()` returns how many events are still queued):

```python
billing.flush()
```

Each metered operation emits `graphql_api.operations` with `gqlOperationType`, complexity, field count, duration, and (if set) `schema_version`.

## Step 6 — Verify it landed in Aforo

In the Aforo console, open the usage/events view for your tenant and filter by `metric_name = graphql_api.operations`. You should see one event per operation, carrying the operation type, complexity score, and field count. If nothing appears, check the `ingestor_url` host and the customer-ID header — see Troubleshooting.

## Step 7 — Tune complexity scoring (optional)

The default score is `field_count + 5 × max_depth`. Override it to match how you price:

```python
billing = AforoGraphQlBilling(
    # ...
    complexity_scorer=lambda doc, op_name: (my_cost(doc, op_name), my_field_count(doc)),
)
```

The scorer returns `(complexity, field_count)`; both land on the event as attributes you can tier on in a rate plan.

## Step 8 — Shut down cleanly

```python
billing.shutdown()   # stops the flush thread and drains remaining events
```

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | required | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | required | Product the operations bill against. |
| `api_key` | `str` | required | Aforo API key, sent as `X-API-Key`. |
| `ingestor_url` | `str` | required | Host; `/v1/ingest/batch` appended. |
| `schema_version` | `str?` | `None` | Stamped on each event. |
| `flush_interval_sec` | `float` | `5.0` | Background flush cadence. |
| `flush_count` | `int` | `500` | Events per request, and the queue size that wakes the sender early (at most 1000). |
| `on_error` | `Callable?` | logs | Receives a `TransportError`; branch on `.kind`: `outage` / `auth` (events still queued and retried), `rejected` (the ingestor refused them; message carries its `errors[].message`), `shutdown`, `closed`. `.events` and `.status` say which events and which HTTP status. |
| `on_drop` | `Callable[[list[dict], str], None]?` | `None` | Called with events that will not be delivered and the reason (`overflow`, `rejected`, `invalid`, `shutdown`, `closed`). Pass by keyword. |
| `product_type` | `str` | `"GRAPHQL_API"` | Top-level `productType` sent on every event (trimmed and upper-cased; values the SDK does not know are passed through). Override per event with `record(..., product_type=...)`. |
| `max_queue_size` | `int` | `10000` | Queue capacity; the oldest event is dropped as `overflow` when full. Keyword-only. |
| `timeout_sec` | `float` | `10.0` | Total deadline per HTTP request. Keyword-only. |
| `shutdown_timeout_sec` | `float` | `5.0` | `shutdown()` flushes for at most this long; leftovers are dropped as `shutdown`. Keyword-only. |
| `allow_insecure_http` | `bool` | `False` | Allow plain `http://` to a host other than localhost. Keyword-only. |
| `http_transport`, `transport_options` | | `None` | An `httpx` transport / extra transport-core settings, for tests and unusual networks. Keyword-only. |
| `customer_id_extractor` | `Callable?` | `None` | Customer resolver for the integrations; or pass `customer_resolver=` to them. |
| `trust_customer_header` | `bool` | `False` | Bill the `x-customer-id` header as sent. |
| `complexity_scorer` | `Callable?` | `field_count + 5 × max_depth` | Returns `(complexity, field_count)`. |

Methods: `record(customer_id, query, operation_name, duration_ms, has_errors, response_bytes=0)`, `flush()`, `shutdown()`. Helpers: `strawberry_extension(billing)`, `asgi_middleware(billing, path="/graphql")`, `default_complexity_scorer(doc, operation_name=None)`.

Execution status (`executionStatus`, used by OUTCOME_BASED pricing) is described in the [README](README.md#execution-status-executionstatus).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No events for any operation | `graphql-core` not installed, so `record()` no-ops; or the document failed to parse. | Install `graphql-core>=3.2`; confirm the query is valid GraphQL. |
| Some operations never metered; `dropped_count` rises with `invalid` | The customer resolver returned nothing, the request body was over `max_request_body_bytes`, or the ASGI `path` doesn't match. | Fix the resolver; raise `max_request_body_bytes`; point `asgi_middleware(path=...)` at the real route. |
| ERROR log "Ingestor answered HTTP 401" (or 403) | Bad or revoked API key. The events stay queued (up to `max_queue_size`) and are retried after a pause. | Fix `api_key` and restart; confirm it matches `tenant_id`. |
| `billing.dropped_count` is above 0 | Events were dropped: `invalid` (failed a client-side check, or no customer), `rejected` (ingestor refused them), `overflow` (queue full during an outage), `shutdown` (still queued at the shutdown deadline) or `closed` (sent after shutdown). An ingest outage alone does not drop events. | Read the WARNING log line for the reason; see [Dropped events](README.md#dropped-events). |
| Events sent, none in console | Wrong `ingestor_url` host, or `graphql_api.operations` isn't mapped to a rate plan. | Use `https://api.aforo.ai`; map the metric in Aforo. |
| Complexity is always the default formula | No `complexity_scorer` supplied. | Pass `complexity_scorer=...` to match your pricing model. |
| Subscriptions aren't billed | This SDK meters query/mutation operations, not long-lived subscription streams. | Use `aforo-ws-metering` for subscription/socket traffic. |

## What this guide does NOT cover

Field-level or resolver-level metering — events are one-per-operation. It doesn't reject or throttle expensive queries (no complexity budget enforcement). It doesn't price anything — rate plans and which attributes you tier on are configured in the Aforo console. For subscriptions over WebSocket, see `aforo-ws-metering`.
