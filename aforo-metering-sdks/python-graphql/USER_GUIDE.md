# aforo-graphql-metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Python engineers running a GraphQL server who need per-operation billing.

## What you'll build

A GraphQL server that reports one Aforo event per operation, with AST-derived complexity and field counts attached — wired either through the Strawberry extension or the framework-agnostic ASGI middleware. You'll finish by confirming a real query reached the Aforo ingestor.

## Prerequisites

- Python **3.9+** and `graphql-core>=3.2` (the SDK's only hard dependency).
- An Aforo **API key**, **tenant id**, and **product id** from the Aforo console.
- A GraphQL server: Strawberry (extension path) or anything ASGI (middleware path).
- A way to set `x-customer-id` on incoming requests, or a custom extractor.

## Step 1 — Install

```bash
pip install -e .                    # from python-graphql/ (not yet on PyPI)
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
    ingestor_url="https://ingest.aforo.ai",
    schema_version="v2.1",
)
```

`tenant_id`, `product_id`, `api_key`, and `ingestor_url` are required — the constructor raises `ValueError` if any is missing.

> ⚠ `ingestor_url` is the **host**. This package appends `/v1/ingest/events`. Pass `https://ingest.aforo.ai`, not the full path.

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
app = asgi_middleware(billing, path="/graphql")(app)
```

> ⚠ The middleware only meters POSTs to the `path` you give it (default `/graphql`). If your server mounts GraphQL elsewhere, set `path` accordingly or no events fire.

## Step 4 — Make sure the customer ID resolves

By default the SDK reads `x-customer-id` from request headers (or the Strawberry context). An operation with no resolvable customer ID is dropped — not metered. Set that header at your gateway/auth layer:

```
x-customer-id: cust_acme_001
```

Or override resolution at construction:

```python
billing = AforoGraphQlBilling(
    # ...
    customer_id_extractor=lambda ctx: decode_jwt(ctx).get("sub"),
)
```

> ⚠ Resolve `customer_id` server-side from something you trust (a verified JWT, your gateway). Don't bill against a value the client can set to any customer it wants.

## Step 5 — Run an operation and flush

Execute any query/mutation against your server. Events buffer in memory and flush on `flush_count` (50) or every `flush_interval_sec` (5 s) via a daemon thread that starts at construction. To force delivery now:

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
| `api_key` | `str` | required | Bearer token. |
| `ingestor_url` | `str` | required | Host; `/v1/ingest/events` appended. |
| `schema_version` | `str?` | `None` | Stamped on each event. |
| `flush_interval_sec` | `float` | `5.0` | Background flush cadence. |
| `flush_count` | `int` | `50` | Buffer size that forces a flush. |
| `on_error` | `Callable?` | logs | Called on permanent batch failure. |
| `customer_id_extractor` | `Callable?` | reads `x-customer-id` | Resolve the billed customer. |
| `complexity_scorer` | `Callable?` | `field_count + 5 × max_depth` | Returns `(complexity, field_count)`. |

Methods: `record(customer_id, query, operation_name, duration_ms, has_errors, response_bytes=0)`, `flush()`, `shutdown()`. Helpers: `strawberry_extension(billing)`, `asgi_middleware(billing, path="/graphql")`, `default_complexity_scorer(doc, operation_name=None)`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No events for any operation | `graphql-core` not installed, so `record()` no-ops; or the document failed to parse. | Install `graphql-core>=3.2`; confirm the query is valid GraphQL. |
| Some operations never metered | Customer ID didn't resolve (no `x-customer-id`), or the ASGI `path` doesn't match. | Set the header upstream / fix the extractor; point `asgi_middleware(path=...)` at the real route. |
| `on_error` fires with "Aforo returned 401/403" | Bad/unscoped API key — 4xx is dropped, not retried. | Fix `api_key`; confirm it matches `tenant_id`. |
| Events sent, none in console | Wrong `ingestor_url` host, or `graphql_api.operations` isn't mapped to a rate plan. | Use `https://ingest.aforo.ai`; map the metric in Aforo. |
| Complexity is always the default formula | No `complexity_scorer` supplied. | Pass `complexity_scorer=...` to match your pricing model. |
| Subscriptions aren't billed | This SDK meters query/mutation operations, not long-lived subscription streams. | Use `aforo-ws-metering` for subscription/socket traffic. |

## What this guide does NOT cover

Field-level or resolver-level metering — events are one-per-operation. It doesn't reject or throttle expensive queries (no complexity budget enforcement). It doesn't price anything — rate plans and which attributes you tier on are configured in the Aforo console. For subscriptions over WebSocket, see `aforo-ws-metering`.
