# aforo-graphql-metering

Aforo GraphQL Metering SDK for Python. AST-accurate complexity scoring + ships one Aforo event per GraphQL operation.

## Install

```bash
pip install aforo-graphql-metering graphql-core
# Optional integrations:
pip install aforo-graphql-metering[strawberry]   # Strawberry extension
pip install aforo-graphql-metering[httpx]        # faster HTTP client
```

## Usage — Strawberry

```python
import strawberry
from aforo_graphql_metering import AforoGraphQlBilling, strawberry_extension

billing = AforoGraphQlBilling(
    tenant_id="tenant_acme",
    product_id="prod_graphql_unified_gateway",
    api_key=os.environ["AFORO_API_KEY"],
    ingestor_url="https://ingestor.aforo.ai",
    schema_version="v2.1",
)

schema = strawberry.Schema(
    query=Query,
    extensions=[strawberry_extension(billing)],
)
```

## Usage — ASGI middleware (works with any GraphQL server)

```python
from starlette.applications import Starlette
from graphql import build_schema
from aforo_graphql_metering import AforoGraphQlBilling, asgi_middleware

billing = AforoGraphQlBilling(...)
app = Starlette(routes=[...])
app = asgi_middleware(billing, path="/graphql")(app)
```

Works with Ariadne, graphql-core HTTP, Graphene-ASGI, and any custom ASGI GraphQL server.

## Complexity scoring

Default: `field_count + 5 × max_depth`. Override per-product:

```python
billing = AforoGraphQlBilling(
    # ...
    complexity_scorer=lambda doc, op_name: (my_score(doc, op_name), my_count(doc)),
)
```

## Customer-ID resolution

Default extractor reads `x-customer-id` from the request headers. For Strawberry the context is whatever `context_getter` returns (the request, typically). Override via `customer_id_extractor=...`.

## License

MIT
