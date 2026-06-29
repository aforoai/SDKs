# @aforo/graphql-metering

Aforo GraphQL Metering SDK for Node.js. Meters every GraphQL operation (query, mutation, subscription) with AST-accurate complexity scoring, then ships usage events to Aforo's usage ingestor in batches.

## Install

```bash
npm install @aforo/graphql-metering graphql
```

## Usage

### Apollo Server 4

```ts
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { AforoGraphQlBilling, aforoApolloPlugin } from '@aforo/graphql-metering';

const billing = new AforoGraphQlBilling({
  tenantId: process.env.AFORO_TENANT_ID!,
  productId: 'prod_graphql_unified_gateway',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://ingestor.aforo.ai',
  schemaVersion: 'v2.1',
});

const server = new ApolloServer({
  typeDefs,
  resolvers,
  plugins: [aforoApolloPlugin(billing)],
});

await startStandaloneServer(server, {
  listen: { port: 4000 },
  context: async ({ req }) => ({ req, headers: req.headers }),
});
```

### Express / graphql-http / express-graphql

```ts
import express from 'express';
import { createHandler } from 'graphql-http/lib/use/express';
import { AforoGraphQlBilling } from '@aforo/graphql-metering';

const billing = new AforoGraphQlBilling({ /* ... */ });

const app = express();
app.use(express.json());
app.use('/graphql', billing.middleware(), createHandler({ schema }));
```

## Complexity scoring

Default formula: `fieldCount + 5 × maxDepth`. A simple query with 3 fields at depth 2 → complexity 13. Override with your own scorer:

```ts
const billing = new AforoGraphQlBilling({
  // ...
  complexityScorer: (doc, operationName) => {
    // Your own rules, per-field cost tables, introspection, directive-based scoring, etc.
    return { complexity: /* ... */, fieldCount: /* ... */ };
  },
});
```

## Customer-ID resolution

By default the SDK reads `x-customer-id` from the Apollo context's request headers or the Express request headers. Override with a custom extractor:

```ts
const billing = new AforoGraphQlBilling({
  // ...
  customerIdExtractor: (ctx) => {
    const auth = (ctx as any).req.headers.authorization;
    // decode JWT, return customer id
    return /* ... */;
  },
});
```

Operations with no resolvable customer ID are **not** metered (safe for health/introspection endpoints).

## Event shape

Each recorded operation becomes a single event:

```json
{
  "productType": "GRAPHQL_API",
  "gqlOperationType": "QUERY",
  "gqlOperationName": "GetUserProfile",
  "gqlComplexity": 47,
  "gqlFieldCount": 18,
  "gqlHasErrors": false,
  "executionDurationMs": 12
}
```

## Batching & retry

Buffers up to 50 events / 5 seconds (both configurable). 3× exponential retry on ingestor failure (1s/2s/4s), then `onError` callback. Call `shutdown()` on graceful process exit to flush the final batch.

## License

MIT
