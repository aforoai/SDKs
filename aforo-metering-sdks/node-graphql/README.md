# @aforoai/graphql-metering

Meter every GraphQL operation — query, mutation, subscription — with AST-derived complexity scoring, and ship the usage events to Aforo without touching your resolvers. Drops in as an Apollo Server 4 plugin or an Express/`graphql-http` middleware.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended public install (once published):

```bash
npm i @aforoai/graphql-metering graphql
```

> **Install `2.0.0` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog.** If `2.0.0` is not on npm yet, install from source with the steps below. `graphql` is a peer dependency (`^15 || ^16`), so install it in your app.

```bash
# from the SDKs repo root
cd SDKs/aforo-metering-sdks/node-graphql
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
import { AforoGraphQlBilling, aforoApolloPlugin } from '@aforoai/graphql-metering';

const billing = new AforoGraphQlBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_graphql_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://api.aforo.ai', // SDK appends /v1/ingest/batch
  schemaVersion: 'v2.1',
  // Who is billed: from identity your server verified. Receives Apollo's contextValue.
  customerResolver: (ctx) => ctx.user?.aforoCustomerId,
});

const server = new ApolloServer({
  typeDefs,
  resolvers,
  plugins: [aforoApolloPlugin(billing)],
});

await startStandaloneServer(server, {
  listen: { port: 4000 },
  context: async ({ req }) => ({ user: await verifySession(req) }),
});

// The SDK installs no signal handlers. Flush from your own:
process.once('SIGTERM', async () => {
  await billing.shutdown();
  process.exit(0);
});
```

Express / `graphql-http` / `express-graphql` — use the middleware instead of the plugin:

```ts
import express from 'express';
import { createHandler } from 'graphql-http/lib/use/express';
import { AforoGraphQlBilling } from '@aforoai/graphql-metering';

const billing = new AforoGraphQlBilling({
  tenantId: 'tenant_acme',
  productId: 'prod_graphql_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://api.aforo.ai',
  customerResolver: (req) => req.user?.aforoCustomerId, // receives the Express request
});

const app = express();
app.use(express.json()); // billing.middleware() reads req.body.query — body must be parsed first
app.use('/graphql', billing.middleware(), createHandler({ schema }));
```

> The middleware lets the response go out first: `res.end` sends it, and the body is parsed and the operation recorded on the next turn of the event loop (`setImmediate`). The Apollo plugin does the same after `willSendResponse`. Metering never blocks or fails the request; an error in the metering path is reported through `onError`.

Every recorded operation emits one event with `metricName: "graphql_api.operations"`, `quantity: 1`, and the operation's type/name/complexity/field-count attached. Ships to `POST https://api.aforo.ai/v1/ingest/batch` with `X-API-Key: <api_key>` and `X-Tenant-Id: <tenant_id>`.

## Configuration

`new AforoGraphQlBilling(config)` — `tenantId`, `productId`, `apiKey`, and `ingestorUrl` are required.

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant. Sent as the `X-Tenant-Id` header. Never read from a client header. |
| `productId` | `string` | — (required) | Aforo product id; attached to each event's `metadata.productId`. |
| `apiKey` | `string` | — (required) | Aforo API key. Sent only as `X-API-Key: <apiKey>`; never logged or shown by `inspect()` / `JSON.stringify`. |
| `ingestorUrl` | `string` | — (required) | Ingestion base URL, `https://` (see `allowInsecureHttp`). The SDK appends `/v1/ingest/batch` (trailing slash trimmed). Use `https://api.aforo.ai`. |
| `productType` | `string` | `'GRAPHQL_API'` | Aforo product type sent as top-level `productType` on every event (trimmed + uppercased; unknown values pass through). Override via `record({ productType })`, `billing.middleware({ productType })` or `aforoApolloPlugin(billing, { productType })`. |
| `schemaVersion` | `string` | `undefined` | Optional schema version string; copied into each event's `metadata.schemaVersion`. |
| `customerResolver` | `(context) => string \| undefined` | — (required unless `trustCustomerHeader`) | The Aforo customer per operation, from identity your server verified. Receives the Express request (`middleware()`) or Apollo's `contextValue` (plugin). Returning nothing, or throwing, drops that operation's event as `invalid` (counted); the response is never affected. The constructor throws when neither this nor `trustCustomerHeader` is given. `customerIdExtractor` still works as a deprecated alias. |
| `trustCustomerHeader` | `boolean` | `false` | Bill the `x-customer-id` request header (from `req.headers`, `ctx.req.headers` or `request.http.headers`). Any client can send it, so only turn this on behind a proxy you control that sets it. |
| `complexityScorer` | `(doc, operationName?) => { complexity, fieldCount }` | `fieldCount + 5 × maxDepth` | Override the complexity formula. Receives the parsed `DocumentNode`. |
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

Exported symbols: `AforoGraphQlBilling` (with `record` / `middleware` / `shutdown` / `droppedCount`), `aforoApolloPlugin(billing, options?)`, `defaultComplexityScorer(doc, operationName?)`, `outcomeFromGraphQlResponse`, `outcomeFromHttpStatus`, `DEFAULT_PRODUCT_TYPE`, and the `AforoGraphQlConfig` / `RecordArgs` / `GraphQlMiddlewareOptions` / `AforoApolloPluginOptions` / `AforoGraphQlIntegrationOptions` / `GraphQlUsageEvent` / `DropReason` types.

## Event fields

Each recorded operation becomes a single event:

```json
{
  "productType": "GRAPHQL_API",
  "gqlOperationType": "QUERY",
  "gqlOperationName": "GetUserProfile",
  "gqlComplexity": 47,
  "gqlFieldCount": 18,
  "gqlHasErrors": false,
  "executionStatus": "SUCCESS",
  "executionDurationMs": 12
}
```

## Delivery

One background sender per client sends one request at a time; recording an event only queues it. If the ingestor is unreachable, keeps answering 408/429/5xx after the retries, or answers 401/403 (a wrong or revoked key — logged as an error), the batch goes back to the front of the queue with its idempotency keys and sending pauses (5 s, doubling to 5 min, randomized). New events keep queueing up to `maxQueueSize`; the first successful request resumes sending, and the ingestor deduplicates the re-sent keys. A 413 splits the batch. Request bodies are plain JSON (the ingestor does not decode gzip). `flush()` sends what is queued now; `shutdown()` sends for at most `shutdownTimeoutMs` — call it from your own SIGTERM handler.

## Execution status

Outcome-based pricing bills each event at the weight set for its `executionStatus`; events without one bill at full price. The SDK trims and upper-cases the value and leaves the key out of the event when it is unset or blank. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value (or a Promise returned by an async resolver) is reported through `onError` and ignored, because the server would reject the event: the event gets the status derived from the response (or HTTP status) instead, or no status when nothing can be derived. The event itself is always sent. Resolvers must be synchronous.

Derived from the GraphQL response (exported as `outcomeFromGraphQlResponse`):

| Response | executionStatus |
|---|---|
| no `errors` (absent, `null` or `[]`) | `SUCCESS` |
| `errors` and non-null `data` | `PARTIAL` |
| `errors` and `data: null` (failed during execution) | `ERROR` |
| `errors` and no `data` key (parse or validation failure) | `VALIDATION_FAILED` |

Any `errors` value other than absent, `null` or `[]` counts as errors — including a non-array object or string from a server that doesn't follow the spec, so `{"data": null, "errors": {"message": "x"}}` is `ERROR`, not `SUCCESS`. The same rule sets `gqlHasErrors` whenever the response is known, so the flag and the status always agree.

The Apollo plugin reads the response Apollo sends. The Express middleware reads the response body when it is a JSON GraphQL result of up to 1 MiB; otherwise (streamed, larger, not JSON, or a JSON object with neither `data` nor `errors`) it maps the HTTP status (`outcomeFromHttpStatus`): 2xx/3xx `SUCCESS`, 408/504 `TIMEOUT`, 499 `CANCELLED`, 400/422 `VALIDATION_FAILED`, 401/403/429 `BLOCKED`, other 4xx/5xx `ERROR`, anything else no status.

To set the value yourself:

```typescript
// Apollo: receives the request context
aforoApolloPlugin(billing, { executionStatus: (rc) => rc.contextValue.outcome });

// Express: receives req and res
app.use('/graphql', billing.middleware({ executionStatus: (req) => req.aforoOutcome }));

// Custom servers: record() takes executionStatus, response, or httpStatus
billing.record({ customerId, query, durationMs, hasErrors, response: result });
```

Your value wins; return `undefined` to keep the derived one.

## Dropped events

The SDK does not throw into your resolvers or the response path for event content. An event that cannot be delivered is counted in `billing.droppedCount`, logged with `console.warn`, and passed to the optional `onDrop(events, reason)` hook. Events handed to the hook keep their `idempotencyKey`, so storing them and re-submitting later is dedup-safe. Exceptions thrown by the hook are swallowed.

| Reason | When |
|---|---|
| `invalid` | The customer resolver returned nothing (or threw), or the event failed a client-side check and was never queued or sent: `customerId` longer than 64 characters or `productType` longer than 20. Values you set are never truncated. An operation name longer than 255 characters is not a drop: it is read from the query, so it is cut to 255 and the event is sent (one warning per label). The warning names the field, the limit and the value (first 80 characters); it is logged for the first invalid event and for every 1000th after that. |
| `rejected` | The ingestor refused the batch with a 4xx other than 408 / 429 (not retried), or named individual events in the `errors[]` of a 2xx response — then only those events are dropped. When a 2xx reports `failed > 0` without a usable `index`, the count is added to `droppedCount` and `onDrop` is not called. |
| `overflow` | The queue (`maxQueueSize`) was full and the oldest event was evicted. |
| `shutdown` | Still queued when `shutdownTimeoutMs` ran out (also reported through `onError`). |
| `closed` | Recorded after `shutdown()`. |
| `retry_exhausted` | Not produced by 2.x (kept in the type): an outage keeps events queued instead of dropping them. |

An operation with no resolvable customer is not metered and is counted as an `invalid` drop. Calling `record()` yourself with a blank `customerId` does the same.

```ts
const billing = new AforoGraphQlBilling({
  // …
  onDrop: (events, reason) => deadLetterQueue.push({ reason, events }),
});
```

## Walk me through it

Step-by-step from install to a verified event in Aforo: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **No per-field cost tables out of the box.** The default scorer is `fieldCount + 5 × maxDepth`. Real per-field pricing means supplying your own `complexityScorer`.
- **No persistent buffer.** Events live in memory until sent. A hard crash loses what is queued; `shutdown()` sends it on graceful exit, but `SIGKILL` / power loss does not.
- **No automatic customer resolution.** You supply `customerResolver` (session lookup, JWT decoding), or opt in to the `x-customer-id` header with `trustCustomerHeader`.
- **The SDK does not enforce or read pricing.** It emits usage; rating/billing happens in Aforo.
