# @aforoai/metering — User Guide

**Version:** 1.1.2 · **Updated:** 2026-10-01 · **Audience:** Node/TypeScript engineers wiring usage metering into an API or service.

## What you'll build

A running Node service that emits a usage event to Aforo on every billable action — first with an explicit `track()` call, then automatically for every HTTP request via middleware — and you'll confirm the events land in Aforo.

## Prerequisites

- Node >= 18 (the SDK uses the built-in `fetch`).
- An Aforo **API key** (`AFORO_API_KEY`).
- A **customer id** you can attach to events (your end-customer's id in Aforo).
- A **metric** defined in the Aforo console (e.g. `api_calls`) so the events bill. The ingestor rejects events for a metric it does not know.

## Step 1 — Install

Install `1.1.2` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog. If `1.1.2` is not on npm yet, install from source:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/node
npm install && npm run build
npm pack            # -> aforo-metering-1.1.2.tgz
cd /path/to/your-app
npm i /path/to/SDKs/aforo-metering-sdks/node/aforo-metering-1.1.2.tgz
```

## Step 2 — Create the client once

Create one `AforoClient` for the process lifetime — it owns the buffer and the background flush timer. Don't create one per request.

```ts
import { AforoClient } from '@aforoai/metering';

export const aforo = new AforoClient({
  apiKey: process.env.AFORO_API_KEY!,
  productType: 'API',   // default; sent as top-level productType on every event
});
```

## Step 3 — Track your first event

```ts
await aforo.track({ customerId: 'cust_123', metricName: 'api_calls', quantity: 1 });
```

> `track()` returns immediately — it enqueues into a ring buffer and the client flushes in the background (every 5s or every 50 events). It does **not** await the network, so a slow ingestor never slows your handler.
>
> `track()` throws only after `shutdown()`. An event the ingestor would reject (blank `customerId` / `metricName`, `quantity <= 0`, a field over the server's size limit, a malformed `occurredAt`) is not sent: it is counted in `aforo.droppedCount`, WARN-logged, and passed to `onDrop` with reason `'invalid'`.

To bill by outcome, pass `executionStatus` (one of `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`). An unknown value is logged and left off; the event is still sent.

To see or recover lost events, pass `onDrop`:

```ts
new AforoClient({
  apiKey: process.env.AFORO_API_KEY!,
  onDrop: (events, reason) => {
    // reason: 'overflow' | 'retry_exhausted' | 'rejected' | 'invalid'
    deadLetter.write(events, reason);   // events keep their idempotency keys
  },
});
```

## Step 4 — Meter every request with middleware (optional)

Skip per-route `track()` calls entirely:

```ts
import { expressMiddleware } from '@aforoai/metering/middleware/express';

app.use(expressMiddleware({
  apiKey: process.env.AFORO_API_KEY!,
  customerId: (req) => req.user?.id ?? null,   // null => this request is skipped
  metricName: 'api_calls',                      // default; or (req, res) => string. Must exist in your Aforo catalog
  excludePaths: ['/health', '/metrics'],        // these are the defaults
  productType: 'API',                           // default: the client default
}));
```

> The middleware fires on `res.on('finish')` — after the response is flushed to the client — so it adds no latency. If `customerId` resolves to `null`/falsy, the request is silently not metered (no error thrown into your app). The default resolver uses `req.user.id` / `req.user.sub`, then `X-Customer-Id` — never the caller's `X-Api-Key`, which is a secret. `OPTIONS` (CORS preflight) requests are never metered, nor are requests whose quantity is `<= 0`. Each event carries top-level `endpointPath` (no query string, max 512 chars), `httpMethod`, `statusCode`, `responseTimeMs` and `productType`.
>
> ⚠ The ingestor rejects any event whose `metricName` is not in your catalog. Earlier versions defaulted to `"<METHOD> <normalized-path>"` (e.g. `GET /users/:id`), which no catalog contains; the default is now `api_calls`.

Fastify (`fastifyPlugin`) and Koa (`koaMiddleware`) imports follow the same shape under `@aforoai/metering/middleware/fastify` and `/middleware/koa`.

## Step 5 — Flush on shutdown

The client registers `SIGTERM`/`SIGINT` handlers, but call `shutdown()` explicitly from your own shutdown path so the last batch isn't lost:

```ts
process.on('beforeExit', () => aforo.shutdown());
```

## Step 6 — Verify it landed

In the Aforo console, open **Ingestion → Recent Events** and filter by your `customerId`/`metricName`. A successful batch returns `{ accepted, duplicates, failed }` from `POST /v1/ingest/batch`; duplicates (same idempotency key) are counted, not double-billed.

> **Idempotency keys.** If you don't pass `idempotencyKey`, the SDK mints a fresh random UUID v4 for each event, so two genuinely distinct events are never confused — even when they share customer, metric, quantity and timestamp. (It used to derive the key by hashing those four fields, which made same-millisecond events collide and silently dropped the second one.) The key is minted once, when `track()` enqueues the event, and never changes, so a retried batch is still deduplicated. **If you want dedup — e.g. an at-least-once pipeline replaying the same logical event — pass your own `idempotencyKey`;** that value is sent verbatim and is the only thing the ingestor dedupes on.

## Configuration reference

See the full `AforoOptions` and `TrackEvent` tables in the [README](README.md#configuration). The fields that most affect behavior: `productType` ("API"; override per event with `track({ productType })`), `flushCount` (50, capped at 1000), `flushInterval` (5000 ms), `maxQueueSize` (10000, oldest-dropped on overflow), `maxRetries` (3), `timeout` (10000 ms).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Events never appear in Aforo | Process exited before a flush | Call `await aforo.shutdown()` on your shutdown path (Step 5). |
| `401 Unauthorized` in logs | Bad/missing API key | Check `AFORO_API_KEY`; the key is sent as `X-API-Key`. |
| Middleware meters nothing | `customerId` resolver returns `null` for every request | Return a real id; confirm `req.user` is populated before the middleware runs. |
| Events accepted but don't bill | `metricName` isn't mapped to a rate plan | Map the metric (billable unit) to a rate plan in the console. |
| `Buffer overflow` WARN, `droppedCount` rising under load | Ring buffer overflowed (`maxQueueSize`) | Raise `maxQueueSize`, or lower `flushInterval`/`flushCount` to drain faster. |
| `Invalid event dropped` WARN | The event failed a client-side check (the WARN names the field) | Fix the value at the call site; use `onDrop` (reason `'invalid'`) to capture the event. |
| `Dropped N event(s) — rejected` WARN | The ingestor refused the batch or some of its events; the WARN carries the server's message | Fix what the message names (unknown metric, missing `productType`, bad key). |

## What this guide does NOT cover

Defining metrics, rate plans, or pricing (done in the Aforo console), and the protocol-specific SDKs (GraphQL/gRPC/WebSocket/MQTT) — those live in the sibling `node-graphql` / `node-grpc` / `node-ws` / `node-mqtt` packages.
