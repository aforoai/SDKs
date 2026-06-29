# aforo-graphql-metering

Meter every GraphQL operation with AST-accurate complexity scoring — one Aforo event per query/mutation, via a Strawberry extension or an ASGI middleware that works with any GraphQL server.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

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

**Not yet on PyPI — install from source for now:**

```bash
git clone https://github.com/aforoai/aforo-metering-sdks.git
cd aforo-metering-sdks/python-graphql     # folder holding setup.py
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
    ingestor_url="https://ingest.aforo.ai",
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
    ingestor_url="https://ingest.aforo.ai",
)
app = Starlette(routes=[...])
app = asgi_middleware(billing, path="/graphql")(app)   # only intercepts /graphql
```

Works with Ariadne, graphql-core HTTP, Graphene-ASGI, and custom ASGI GraphQL servers. Each metered operation produces one `graphql_api.operations` event POSTed to `https://ingest.aforo.ai/v1/ingest/events` with `Authorization: Bearer <api_key>` and `X-Tenant-Id: <tenant_id>`.

> ⚠ This package targets the ingestor's **`/v1/ingest/events`** path (the base and MCP Aforo SDKs use `/v1/ingest/batch`). Set `ingestor_url` to the host only — the SDK appends the path. Use `https://ingest.aforo.ai`.

> `tenant_id` is fixed from your config and sent as a header — never read from a caller-controlled value. The default customer-ID extractor reads `x-customer-id` from request headers (or the Strawberry context); operations with no resolvable customer ID are **not** metered.

## Configuration

Constructor arguments for `AforoGraphQlBilling(...)`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenant_id` | `str` | — (required) | Aforo tenant; sent as `X-Tenant-Id`. |
| `product_id` | `str` | — (required) | Product the operations bill against. |
| `api_key` | `str` | — (required) | Bearer token for the ingestor. |
| `ingestor_url` | `str` | — (required) | Host; `/v1/ingest/events` is appended. |
| `schema_version` | `str?` | `None` | Stamped on each event for versioned-schema reporting. |
| `flush_interval_sec` | `float` | `5.0` | Background flush cadence (a daemon thread runs from construction). |
| `flush_count` | `int` | `50` | Buffer size that triggers an immediate flush. |
| `on_error` | `Callable[[Exception], None]?` | logs | Called on permanent batch failure. |
| `customer_id_extractor` | `Callable[[Any], str?]?` | reads `x-customer-id` | Resolve the billed customer from the request/context. |
| `complexity_scorer` | `Callable[[doc, op_name], (int, int)]?` | `field_count + 5 × max_depth` | Returns `(complexity, field_count)`. |

Retry is fixed at **3 attempts** with `1s / 2s / 4s` backoff; 4xx is non-retryable.

## Walk me through it

Install → wire the extension → run a query → confirm the event in Aforo, step by step, is in **[USER_GUIDE.md](USER_GUIDE.md)**.

## What this doesn't cover

It meters **operations**, not individual resolver fields or DataLoader batches — one event per top-level operation, with complexity/field counts as attributes. It doesn't enforce a complexity budget or reject expensive queries; that's a gateway/server concern. GraphQL subscriptions over WebSocket aren't covered here — use `aforo-ws-metering`. Pricing and metric mapping are in the Aforo console.
