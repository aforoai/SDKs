# @aforo/graphql-metering

Meter every GraphQL operation — query, mutation, subscription — with AST-derived complexity scoring, and ship the usage events to Aforo without touching your resolvers. Drops in as an Apollo Server 4 plugin or an Express/`graphql-http` middleware.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install (once published):

```bash
npm i @aforo/graphql-metering graphql
```

> **Not yet on the public npm registry — install from source for now.** `graphql` is a peer dependency (`^15 || ^16`), so install it in your app.

```bash
# from the SDKs repo root
cd aforo-metering-sdks/node-graphql
npm install
npm run build          # tsc → dist/

# then, from YOUR app, link the built package
npm install /absolute/path/to/aforo-metering-sdks/node-graphql
npm install graphql    # peer dependency, in your app
```

## Quickstart

```ts
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { AforoGraphQlBilling, aforoApolloPlugin } from '@aforo/graphql-metering';

const billing = new AforoGraphQlBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_graphql_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://ingest.aforo.ai', // SDK appends /v1/ingest/events
  schemaVersion: 'v2.1',
});

const server = new ApolloServer({
  typeDefs,
  resolvers,
  plugins: [aforoApolloPlugin(billing)],
});

await startStandaloneServer(server, {
  listen: { port: 4000 },
  // the default customer-id extractor reads x-customer-id off the request headers
  context: async ({ req }) => ({ req, headers: req.headers }),
});
```

Express / `graphql-http` / `express-graphql` — use the middleware instead of the plugin:

```ts
import express from 'express';
import { createHandler } from 'graphql-http/lib/use/express';
import { AforoGraphQlBilling } from '@aforo/graphql-metering';

const billing = new AforoGraphQlBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_graphql_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://ingest.aforo.ai',
});

const app = express();
app.use(express.json()); // billing.middleware() reads req.body.query — body must be parsed first
app.use('/graphql', billing.middleware(), createHandler({ schema }));
```

> The middleware records in `res.end`, after the response is produced. It never blocks or fails the request — any error inside the metering path is swallowed.

Every recorded operation emits one event with `metricName: "graphql_api.operations"`, `quantity: 1`, and the operation's type/name/complexity/field-count attached. Ships to `POST https://ingest.aforo.ai/v1/ingest/events` with `Authorization: Bearer <api_key>` and `X-Tenant-Id: <tenant_id>`.

## Configuration

`new AforoGraphQlBilling(config)` — `tenantId`, `productId`, `apiKey`, and `ingestorUrl` are required.

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as the `X-Tenant-Id` header. Never read from a client header. |
| `productId` | `string` | — (required) | Aforo product id; attached to each event's `metadata.productId`. |
| `apiKey` | `string` | — (required) | Aforo API key. Sent as `Authorization: Bearer <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Ingestion base URL. The SDK appends `/v1/ingest/events` (trailing slash trimmed). Use `https://ingest.aforo.ai`. |
| `schemaVersion` | `string` | `undefined` | Optional schema version string; copied into each event's `metadata.schemaVersion`. |
| `customerIdExtractor` | `(context) => string \| undefined` | reads `x-customer-id` from the request/context headers | Resolve the Aforo customer id per operation. Return `undefined` and the operation is not metered. |
| `complexityScorer` | `(doc, operationName?) => { complexity, fieldCount }` | `fieldCount + 5 × maxDepth` | Override the complexity formula. Receives the parsed `DocumentNode`. |
| `flushCount` | `number` | `50` | Buffered events that trigger an immediate flush. |
| `flushIntervalMs` | `number` | `5000` | Max ms before a partial batch is flushed by the background timer. |
| `onError` | `(error: Error) => void` | logs to `console.error` | Called when a flush fails terminally (after 3 retries). |

Exported symbols: `AforoGraphQlBilling`, `aforoApolloPlugin(billing)`, `defaultComplexityScorer(doc, operationName?)`, and the `AforoGraphQlConfig` type.

## Walk me through it

Step-by-step from install to a verified event in Aforo: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **No per-field cost tables out of the box.** The default scorer is `fieldCount + 5 × maxDepth`. Real per-field pricing means supplying your own `complexityScorer`.
- **No persistent buffer.** Events live in memory until flushed. A hard crash before flush drops the buffered batch; `shutdown()` flushes on graceful exit, but `SIGKILL` / power loss does not.
- **No automatic customer resolution beyond `x-customer-id`.** JWT decoding, session lookups, etc. require a `customerIdExtractor`.
- **The SDK does not enforce or read pricing.** It emits usage; rating/billing happens in Aforo.
