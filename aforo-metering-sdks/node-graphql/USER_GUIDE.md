# @aforo/graphql-metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Node.js engineers running a GraphQL server (Apollo Server 4, `graphql-http`, or `express-graphql`) who need per-operation usage metered into Aforo.

## What you'll build

A GraphQL server that emits one Aforo usage event per operation — tagged with operation type, name, complexity, and field count — without changing a single resolver. By the end you'll have fired a real metered query and confirmed the event reached Aforo.

## Prerequisites

- Node.js ≥ 18 (the SDK uses the global `fetch`).
- An Aforo API key and a tenant id (`tenant_…`) and the product id you're metering against.
- A running GraphQL server, or the appetite to start one. Apollo Server 4 is the smoothest path.
- `graphql` ^15 or ^16 installed in your app (peer dependency).

## Step 1 — Install the SDK

Once published, this is one line:

```bash
npm i @aforo/graphql-metering graphql
```

It isn't on npm yet. Build from source and link it:

```bash
cd aforo-metering-sdks/node-graphql
npm install
npm run build      # produces dist/

cd /path/to/your-app
npm install /absolute/path/to/aforo-metering-sdks/node-graphql
npm install graphql
```

## Step 2 — Create the billing instance

Construct it once, at server startup. The constructor starts a background flush timer immediately.

```ts
import { AforoGraphQlBilling } from '@aforo/graphql-metering';

const billing = new AforoGraphQlBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_graphql_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://ingest.aforo.ai', // SDK appends /v1/ingest/events
  schemaVersion: 'v2.1',
});
```

> ⚠ `ingestorUrl` is the **base** URL. Don't put `/v1/ingest/events` here — the SDK appends it. `https://ingest.aforo.ai/v1/ingest/events` would become `…/v1/ingest/events/v1/ingest/events`.

## Step 3 — Wire it into your server

**Apollo Server 4** — register the plugin:

```ts
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { aforoApolloPlugin } from '@aforo/graphql-metering';

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

**Express / graphql-http** — register the middleware *before* the GraphQL handler, after `express.json()`:

```ts
app.use(express.json());                       // body must be parsed first
app.use('/graphql', billing.middleware(), createHandler({ schema }));
```

> ⚠ The middleware reads `req.body.query`. If your body parser runs *after* `billing.middleware()`, `query` is `undefined` and nothing gets metered.

## Step 4 — Make sure each operation has a customer id

The default extractor reads `x-customer-id` from the request headers. An operation with no resolvable customer id is **silently skipped** (this is the right behavior for health checks and introspection — they shouldn't bill).

If your customer lives in a JWT or session instead, supply an extractor:

```ts
const billing = new AforoGraphQlBilling({
  // …
  customerIdExtractor: (ctx) => {
    const auth = (ctx as any).req?.headers?.authorization;
    return decodeCustomerIdFromJwt(auth); // your logic
  },
});
```

## Step 5 — Fire a metered operation

Send a query with the customer header set:

```bash
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -H 'x-customer-id: cust_demo_001' \
  -d '{"query":"query GetUser { user(id: \"1\") { id name email } }","operationName":"GetUser"}'
```

The SDK records one event:
- `metricName`: `graphql_api.operations`, `quantity`: 1
- `gqlOperationType`: `QUERY`, `gqlOperationName`: `GetUser`
- `gqlComplexity` / `gqlFieldCount` from the scorer (default `fieldCount + 5 × maxDepth`)
- `gqlHasErrors`, `executionDurationMs`, and `dataBytes` when available

## Step 6 — Flush and verify it landed in Aforo

The event sits in the buffer until `flushCount` (50) is reached or `flushIntervalMs` (5000) elapses. To force a flush right now — and on every graceful shutdown — call `shutdown()`:

```ts
process.on('SIGTERM', async () => { await billing.shutdown(); });
process.on('SIGINT',  async () => { await billing.shutdown(); process.exit(0); });
```

> ⚠ Without `shutdown()`, a process that exits inside the 5-second window drops the buffered batch. Wire it up before you trust the counts.

The SDK POSTs the batch to `https://ingest.aforo.ai/v1/ingest/events` with:
- `Authorization: Bearer <your api key>`
- `X-Tenant-Id: tenant_acme`

Confirm it arrived in the Aforo console under the product's usage events (filter to `productType = GRAPHQL_API`). If a flush fails 3× (1s/2s/4s backoff), the `onError` callback fires and the batch is dropped — watch your logs:

```ts
const billing = new AforoGraphQlBilling({
  // …
  onError: (err) => myLogger.error('aforo graphql flush failed', err),
});
```

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as `X-Tenant-Id`. |
| `productId` | `string` | — (required) | Aforo product id; into `metadata.productId`. |
| `apiKey` | `string` | — (required) | Sent as `Authorization: Bearer <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Base URL; SDK appends `/v1/ingest/events`. |
| `schemaVersion` | `string` | `undefined` | Copied into `metadata.schemaVersion`. |
| `customerIdExtractor` | `(context) => string \| undefined` | reads `x-customer-id` | Resolve the customer per operation; `undefined` → skip. |
| `complexityScorer` | `(doc, operationName?) => { complexity, fieldCount }` | `fieldCount + 5 × maxDepth` | Replace the complexity formula. |
| `flushCount` | `number` | `50` | Buffered events that trigger an immediate flush. |
| `flushIntervalMs` | `number` | `5000` | Max ms before a partial batch is flushed. |
| `onError` | `(error: Error) => void` | `console.error` | Terminal flush-failure callback. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No events at all | No customer id resolved | Set the `x-customer-id` header, or supply a `customerIdExtractor`. Operations without a customer are skipped by design. |
| Events stop after a deploy | Process exited before the 5s timer flushed | Call `await billing.shutdown()` on `SIGTERM`/`SIGINT`. |
| `…/v1/ingest/events/v1/ingest/events` in logs | `ingestorUrl` already includes the path | Set `ingestorUrl` to the base host only (`https://ingest.aforo.ai`). |
| Middleware records nothing | `express.json()` runs after `billing.middleware()`, so `req.body.query` is empty | Register `express.json()` first. |
| Complexity is always low/0 | Custom scorer returns wrong shape, or operation has few fields | Confirm your `complexityScorer` returns `{ complexity, fieldCount }`; the default counts AST fields + 5×depth. |
| `onError` firing repeatedly | Wrong `apiKey`/`tenantId`, or ingestor unreachable | Verify the API key and tenant id; confirm the host resolves and accepts `POST /v1/ingest/events`. |

## What this guide does NOT cover

- **Per-field cost pricing.** This guide uses the default scorer. Real per-field cost tables are your `complexityScorer` to write.
- **Subscription long-poll/streaming billing.** Operations are metered when the response is produced; long-lived subscription frames are not individually counted.
- **Rating, invoicing, plan config.** Those live in the Aforo console, not the SDK.
- **Durable delivery.** The buffer is in-memory; see Step 6 for the crash-window caveat.
