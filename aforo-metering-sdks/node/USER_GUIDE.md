# @aforoai/metering — User Guide

**Version:** 2.0.0 · **Updated:** 2026-10-26 · **Audience:** Node/TypeScript engineers wiring usage metering into an API or service.

## What you'll build

A running Node service that emits a usage event to Aforo on every billable action — first with an explicit `track()` call, then automatically for every HTTP request via middleware — and you'll confirm the events land in Aforo.

## Prerequisites

- Node >= 18 (the SDK uses the built-in `fetch`).
- An Aforo **API key** (`AFORO_API_KEY`).
- A **customer id** you can attach to events (your end-customer's id in Aforo).
- A **metric** defined in the Aforo console (e.g. `api_calls`) so the events bill. The ingestor rejects events for a metric it does not know.

## Step 1 — Install

Install `2.0.0` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog. If `2.0.0` is not on npm yet, install from source:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/node
npm install && npm run build
npm pack            # -> aforo-metering-2.0.0.tgz
cd /path/to/your-app
npm i /path/to/SDKs/aforo-metering-sdks/node/aforo-metering-2.0.0.tgz
```

## Step 2 — Create the client once

Create one `AforoClient` for the process lifetime — it owns the queue and the background sender. Don't create one per request.

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

> `track()` returns immediately — it puts the event on a bounded queue and one background sender ships batches (every 5 s, or as soon as 500 events are waiting). It never starts a request itself, so a slow or down ingestor never slows your handler. During an outage events stay queued (up to `maxQueueSize`) and are sent when the ingestor is back.
>
> `track()` never throws. After `shutdown()` the event is counted and reported with reason `'closed'`. An event the ingestor would reject (blank `customerId` / `metricName`, `quantity <= 0`, a field over the server's size limit, a malformed `occurredAt`) is not sent: it is counted in `aforo.droppedCount`, WARN-logged, and passed to `onDrop` with reason `'invalid'`.

To bill by outcome, pass `executionStatus` (one of `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`). An unknown value is logged and left off; the event is still sent.

To see or recover lost events, pass `onDrop`:

```ts
new AforoClient({
  apiKey: process.env.AFORO_API_KEY!,
  onDrop: (events, reason) => {
    // reason: 'overflow' | 'rejected' | 'invalid' | 'shutdown' | 'closed'
    deadLetter.write(events, reason);   // events keep their idempotency keys
  },
});
```

## Step 4 — Meter every request with middleware (optional)

Skip per-route `track()` calls entirely:

```ts
import { AforoClient } from '@aforoai/metering';
import { expressMiddleware } from '@aforoai/metering/middleware/express';

const aforo = new AforoClient({ apiKey: process.env.AFORO_API_KEY!, productType: 'API' });

app.use(expressMiddleware({
  client: aforo,
  customerResolver: (req) => req.user?.aforoCustomerId,  // required: identity your app verified
  metricName: 'api_calls',                                // default; or (req, res) => string. Must exist in your Aforo catalog
  excludePaths: ['/health', '/metrics'],                  // these are the defaults
}));
```

> The middleware fires on `res.on('finish')` — after the response is flushed to the client — so it adds no latency.
>
> **Who is billed.** `customerResolver` is required: return the Aforo customer id from identity your app authenticated (session, verified JWT subject, API-key lookup). Creating the middleware without it throws. When it returns nothing for a request, the event is dropped with reason `'invalid'` and counted; the request is never blocked. To bill the `X-Customer-Id` header instead, pass `trustCustomerHeader: true` — only safe when a proxy you control sets that header, because any caller can send it. The caller's `X-Api-Key` header is never used.
>
> `OPTIONS` (CORS preflight) requests are never metered, nor are requests whose quantity is `<= 0`. Each event carries top-level `endpointPath`, `httpMethod`, `statusCode`, `responseTimeMs` and `productType`. `endpointPath` is the route template when the framework has one, otherwise the path with ids collapsed (`/users/123` → `/users/:id`); pass `normalizePath: false` to send the raw path.
>
> ⚠ The ingestor rejects any event whose `metricName` is not in your catalog. Earlier versions defaulted to `"<METHOD> <normalized-path>"` (e.g. `GET /users/:id`), which no catalog contains; the default is now `api_calls`.

Fastify (`fastifyPlugin`) and Koa (`koaMiddleware`) take the same options under `@aforoai/metering/middleware/fastify` and `/middleware/koa`. The Koa resolver receives `ctx`; the Fastify resolver receives the Fastify request.

## Step 5 — Flush on shutdown

The SDK installs no signal handlers — a library that grabs `SIGTERM` stops your process from exiting. Call `shutdown()` from your own handler; it sends what is queued for at most `shutdownTimeoutMs` (5 s) and reports anything left with reason `'shutdown'`:

```ts
process.once('SIGTERM', async () => {
  await server.close();
  await aforo.shutdown();
  process.exit(0);
});
```

When the process ends on its own (the event loop empties), the client sends what is queued on `beforeExit`, within the same deadline.

## Step 6 — Verify it landed

In the Aforo console, open **Ingestion → Recent Events** and filter by your `customerId`/`metricName`. A successful batch returns `{ accepted, duplicates, failed }` from `POST /v1/ingest/batch`; duplicates (same idempotency key) are counted, not double-billed.

> **Idempotency keys.** If you don't pass `idempotencyKey`, the SDK mints a fresh random UUID v4 for each event, so two genuinely distinct events are never confused — even when they share customer, metric, quantity and timestamp. (It used to derive the key by hashing those four fields, which made same-millisecond events collide and silently dropped the second one.) The key is minted once, when `track()` enqueues the event, and never changes, so a retried batch is still deduplicated. **If you want dedup — e.g. an at-least-once pipeline replaying the same logical event — pass your own `idempotencyKey`;** that value is sent verbatim and is the only thing the ingestor dedupes on.

## Configuration reference

See the full `AforoOptions` and `TrackEvent` tables in the [README](README.md#configuration). The fields that most affect behavior: `productType` ("API"; override per event with `track({ productType })`), `flushCount` (500, capped at 1000), `flushInterval` (5000 ms), `maxQueueSize` (10000, oldest-dropped on overflow), `maxRetries` (3), `timeout` (10000 ms).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Events never appear in Aforo | Process exited before a flush | Call `await aforo.shutdown()` on your shutdown path (Step 5). |
| `401 Unauthorized` in logs | Bad/missing API key | Check `AFORO_API_KEY`; the key is sent as `X-API-Key`. |
| Middleware meters nothing, `droppedCount` rises | `customerResolver` returns nothing for every request (reason `'invalid'`) | Return a real id; confirm `req.user` is populated before the middleware runs. |
| `Aforo middleware needs a customerResolver` at startup | 2.0 removed the default `X-Customer-Id` lookup | Pass `customerResolver`, or `trustCustomerHeader: true` behind a proxy you control. |
| `must use https://` at startup | `baseUrl` is plain http to a remote host | Use https, or `allowInsecureHttp: true` on a private network. |
| `Aforo ingestor unavailable` WARN | Outage, repeated 5xx/429, or 401/403 | Events stay queued and are sent on recovery; for 401/403 fix the key. Raise `maxQueueSize` for long outages. |
| Events accepted but don't bill | `metricName` isn't mapped to a rate plan | Map the metric (billable unit) to a rate plan in the console. |
| `overflow` WARN, `droppedCount` rising | The queue filled (`maxQueueSize`), usually during an outage | Raise `maxQueueSize`, or lower `flushInterval`/`flushCount` to drain faster. |
| `Dropped … — invalid` WARN | The event failed a client-side check (the WARN names the field) | Fix the value at the call site; use `onDrop` (reason `'invalid'`) to capture the event. |
| `Dropped N event(s) — rejected` WARN | The ingestor refused the batch or some of its events; the WARN carries the server's message | Fix what the message names (unknown metric, missing `productType`, bad key). |

## What this guide does NOT cover

Defining metrics, rate plans, or pricing (done in the Aforo console), and the protocol-specific SDKs (GraphQL/gRPC/WebSocket/MQTT) — those live in the sibling `node-graphql` / `node-grpc` / `node-ws` / `node-mqtt` packages.
