# @aforoai/graphql-metering — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** Node.js engineers running a GraphQL server (Apollo Server 4, `graphql-http`, or `express-graphql`) who need per-operation usage metered into Aforo.

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
npm i @aforoai/graphql-metering graphql
```

Install `2.0.0` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog. If `2.0.0` is not on npm yet, install from source:

```bash
cd SDKs/aforo-metering-sdks/node-graphql
npm install
npm run build      # produces dist/

cd /path/to/your-app
npm install /absolute/path/to/aforo-metering-sdks/node-graphql
npm install graphql
```

## Step 2 — Create the billing instance

Construct it once, at server startup. The constructor starts a background flush timer immediately.

```ts
import { AforoGraphQlBilling } from '@aforoai/graphql-metering';

const billing = new AforoGraphQlBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_graphql_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://api.aforo.ai', // SDK appends /v1/ingest/batch
  schemaVersion: 'v2.1',
  customerResolver: (ctx) => ctx.user?.aforoCustomerId, // Step 4
});
```

> ⚠ `ingestorUrl` is the **base** URL. Don't put `/v1/ingest/batch` here — the SDK appends it. `https://api.aforo.ai/v1/ingest/batch` would become `…/v1/ingest/batch/v1/ingest/batch`.

## Step 3 — Wire it into your server

**Apollo Server 4** — register the plugin:

```ts
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { aforoApolloPlugin } from '@aforoai/graphql-metering';

const server = new ApolloServer({
  typeDefs,
  resolvers,
  plugins: [aforoApolloPlugin(billing)],
});

await startStandaloneServer(server, {
  listen: { port: 4000 },
  context: async ({ req }) => ({ user: await verifySession(req) }),
});
```

**Express / graphql-http** — register the middleware *before* the GraphQL handler, after `express.json()`:

```ts
app.use(express.json());                       // body must be parsed first
app.use('/graphql', billing.middleware(), createHandler({ schema }));
```

> ⚠ The middleware reads `req.body.query`. If your body parser runs *after* `billing.middleware()`, `query` is `undefined` and nothing gets metered.

## Step 4 — Make sure each operation has a customer id

`customerResolver` is required: return the Aforo customer id from identity your server verified — a session, a JWT you checked. It receives Apollo's `contextValue` for the plugin and the Express request for `middleware()`. Creating `AforoGraphQlBilling` without it throws.

```ts
const billing = new AforoGraphQlBilling({
  // …
  customerResolver: (ctx: any) => ctx.user?.aforoCustomerId ?? ctx.req?.user?.aforoCustomerId,
});
```

An operation your resolver returns nothing for (health checks, introspection) is not metered: it counts as one `invalid` drop in `billing.droppedCount`, and the response is unaffected.

> ⚠ Behind a proxy that sets `x-customer-id` and strips any client copy, `trustCustomerHeader: true` bills that header instead. Without such a proxy any caller could bill another customer.

## Step 5 — Fire a metered operation

Send a query as an authenticated client:

```bash
curl -s http://localhost:4000/graphql \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $DEMO_TOKEN" \
  -d '{"query":"query GetUser { user(id: \"1\") { id name email } }","operationName":"GetUser"}'
```

The SDK records one event:
- `metricName`: `graphql_api.operations`, `quantity`: 1
- `gqlOperationType`: `QUERY`, `gqlOperationName`: `GetUser`
- `gqlComplexity` / `gqlFieldCount` from the scorer (default `fieldCount + 5 × maxDepth`)
- `gqlHasErrors`, `executionDurationMs`, and `dataBytes` when available

## Step 6 — Flush and verify it landed in Aforo

The event waits in the queue until `flushCount` (500) events are waiting or `flushIntervalMs` (5000) passes; one background sender ships them. `await billing.flush()` sends now. The SDK installs no signal handlers — call `shutdown()` from yours; it sends what is queued for at most `shutdownTimeoutMs` (5 s) and reports anything left with reason `shutdown`:

```ts
process.once('SIGTERM', async () => {
  await billing.shutdown();
  process.exit(0);
});
```

> ⚠ Without `shutdown()`, a process killed by a signal loses what is queued. A process that ends on its own sends it on `beforeExit`.

The SDK POSTs the batch to `https://api.aforo.ai/v1/ingest/batch` with:
- `X-API-Key: <your api key>`
- `X-Tenant-Id: tenant_acme`

Confirm it arrived in the Aforo console under the product's usage events (filter to `productType = GRAPHQL_API`). Network errors, 408, 429 (honouring `Retry-After`) and 5xx are retried 3× (1s/2s/4s backoff); any other 4xx is not retried. When a batch is dropped, or a 202 reports per-event failures (`errors[].message`), the `onError` callback fires — watch your logs:

```ts
const billing = new AforoGraphQlBilling({
  // …
  onError: (err) => myLogger.error('aforo graphql flush failed', err),
});
```

## Outcomes and dropped events

- **`executionStatus`** — the outcome used by outcome-based pricing. How this SDK sets it, the accepted values and how to override it: [README → Execution status](README.md#execution-status).
- **Dropped events** — the SDK does not throw into your resolvers or the response path for event content. Events it cannot deliver are counted in `billing.droppedCount`, logged with `console.warn`, and passed to `onDrop(events, reason)`. The reasons (`invalid`, `rejected`, `overflow`, `shutdown`, `closed`) and what triggers each: [README → Dropped events](README.md#dropped-events).

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as `X-Tenant-Id`. |
| `productId` | `string` | — (required) | Aforo product id; into `metadata.productId`. |
| `apiKey` | `string` | — (required) | Sent only as `X-API-Key: <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Base URL, `https://`; SDK appends `/v1/ingest/batch`. |
| `productType` | `string` | `'GRAPHQL_API'` | Top-level `productType` on every event (trimmed + uppercased; unknown values pass through). Override via `record({ productType })`, `billing.middleware({ productType })` or `aforoApolloPlugin(billing, { productType })`. |
| `schemaVersion` | `string` | `undefined` | Copied into `metadata.schemaVersion`. |
| `customerResolver` | `(context) => string \| undefined` | — (required unless `trustCustomerHeader`) | The customer per operation from verified identity; nothing → `invalid` drop. `customerIdExtractor` is a deprecated alias. |
| `trustCustomerHeader` | `boolean` | `false` | Bill the `x-customer-id` header. Only behind a proxy you control. |
| `complexityScorer` | `(doc, operationName?) => { complexity, fieldCount }` | `fieldCount + 5 × maxDepth` | Replace the complexity formula. |
| `allowInsecureHttp` | `boolean` | `false` | Accept a plain `http://` `ingestorUrl` on a non-local host. `https://` is required otherwise (plain http is fine for `localhost`, `127.0.0.1`, `::1`). |
| `flushCount` | `number` | `500` | Events per request (max 1000). Reaching it wakes the background sender; recording an event never sends by itself. |
| `flushIntervalMs` | `number` | `5000` | The background sender also runs this often. |
| `maxQueueSize` | `number` | `10000` | Queue capacity. When it is full — usually during a long outage — the oldest event is dropped with reason `overflow`. |
| `maxRetries` | `number` | `3` | Retries per batch on network errors, timeouts, 408, 429 and 5xx, with full-jitter backoff (`Retry-After` in seconds or as a date is honoured, capped at 60 s). |
| `timeoutMs` | `number` | `10000` | Total deadline per request. |
| `shutdownTimeoutMs` | `number` | `5000` | How long `shutdown()` keeps sending. Events still queued then are dropped with reason `shutdown`. |
| `flushOnExit` | `boolean` | `true` | Send queued events on the process `beforeExit` event, within `shutdownTimeoutMs`. The SDK installs no signal handlers. |
| `onError` | `(error: Error) => void` | logs to `console.error` | Called for delivery problems: a batch the ingestor refused (the message includes its `errors[].message`), an ingestor outage (once per outage), events lost at the shutdown deadline, and an unusable `executionStatus`. Exceptions it throws are caught. Delivery reports are a `CoreTransportError`: branch on `err.kind` (`outage`, `auth`, `rejected`, `shutdown`, `closed`) and read `err.events`, not the message. |
| `onDrop` | `(events, reason) => void` | none | Receives events lost for good. See [Dropped events](#dropped-events). |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No events, `droppedCount` rises (`invalid`) | `customerResolver` returned nothing | Make it return the customer for authenticated requests. |
| `AforoGraphQlBilling needs a customerResolver` at startup | 2.0 removed the default `x-customer-id` lookup | Pass `customerResolver`, or `trustCustomerHeader: true` behind a proxy you control. |
| `must use https://` at startup | `ingestorUrl` is plain http to a remote host | Use https, or `allowInsecureHttp: true` on a private network. |
| Events stop after a deploy | Process was killed before the queue was sent | Call `await billing.shutdown()` from your `SIGTERM`/`SIGINT` handler. |
| `…/v1/ingest/batch/v1/ingest/batch` in logs | `ingestorUrl` already includes the path | Set `ingestorUrl` to the base host only (`https://api.aforo.ai`). |
| Middleware records nothing | `express.json()` runs after `billing.middleware()`, so `req.body.query` is empty | Register `express.json()` first. |
| Complexity is always low/0 | Custom scorer returns wrong shape, or operation has few fields | Confirm your `complexityScorer` returns `{ complexity, fieldCount }`; the default counts AST fields + 5×depth. |
| `Aforo ingestor unavailable` in `onError` | Ingestor unreachable, or 401/403 (wrong key) | Events stay queued and are sent on recovery; fix the key for 401/403. Raise `maxQueueSize` for long outages. |
| `droppedCount` rises and the warning says `invalid` | An event failed a client-side check (`customerId` longer than 64 characters or `productType` longer than 20) | Fix the value named in the warning; values you set are not truncated. (An operation name over 255 characters is cut to 255 and the event is still sent.) `onDrop` receives the event. |
| `droppedCount` rises and the warning says `rejected` | The ingestor refused the batch (4xx) or specific events | Read the `onError` message — it carries the ingestor's `errors[].message`. |

## What this guide does NOT cover

- **Per-field cost pricing.** This guide uses the default scorer. Real per-field cost tables are your `complexityScorer` to write.
- **Subscription long-poll/streaming billing.** Operations are metered when the response is produced; long-lived subscription frames are not individually counted.
- **Rating, invoicing, plan config.** Those live in the Aforo console, not the SDK.
- **Durable delivery.** The queue is in memory: an ingestor outage is ridden out up to `maxQueueSize`, but a crash loses what is queued; see Step 6.
