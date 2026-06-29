# @aforo/metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Node/TypeScript engineers wiring usage metering into an API or service.

## What you'll build

A running Node service that emits a usage event to Aforo on every billable action — first with an explicit `track()` call, then automatically for every HTTP request via middleware — and you'll confirm the events land in Aforo.

## Prerequisites

- Node >= 18 (the SDK uses the built-in `fetch`).
- An Aforo **API key** (`AFORO_API_KEY`).
- A **customer id** you can attach to events (your end-customer's id in Aforo).
- A **metric** defined in the Aforo console (e.g. `api_calls`) so the events bill. Undefined metrics are accepted but won't bill.

## Step 1 — Install from source

Until the package is on npm:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/node
npm install && npm run build
npm pack            # -> aforo-metering-1.0.0.tgz
cd /path/to/your-app
npm i /path/to/SDKs/aforo-metering-sdks/node/aforo-metering-1.0.0.tgz
```

## Step 2 — Create the client once

Create one `AforoClient` for the process lifetime — it owns the buffer and the background flush timer. Don't create one per request.

```ts
import { AforoClient } from '@aforo/metering';

export const aforo = new AforoClient({ apiKey: process.env.AFORO_API_KEY! });
```

## Step 3 — Track your first event

```ts
await aforo.track({ customerId: 'cust_123', metricName: 'api_calls', quantity: 1 });
```

> `track()` returns immediately — it enqueues into a ring buffer and the client flushes in the background (every 5s or every 50 events). It does **not** await the network, so a slow ingestor never slows your handler.

## Step 4 — Meter every request with middleware (optional)

Skip per-route `track()` calls entirely:

```ts
import { expressMiddleware } from '@aforo/metering/middleware/express';

app.use(expressMiddleware({
  apiKey: process.env.AFORO_API_KEY!,
  customerId: (req) => req.user?.id ?? null,   // null => this request is skipped
  // metricName defaults to "<METHOD> <normalized-path>", e.g. "GET /users/:id"
  excludePaths: ['/health', '/metrics'],        // these are the defaults
}));
```

> The middleware fires on `res.on('finish')` — after the response is flushed to the client — so it adds no latency. If `customerId` resolves to `null`/falsy, the request is silently not metered (no error thrown into your app).

Fastify (`fastifyPlugin`) and Koa (`koaMiddleware`) imports follow the same shape under `@aforo/metering/middleware/fastify` and `/middleware/koa`.

## Step 5 — Flush on shutdown

The client registers `SIGTERM`/`SIGINT` handlers, but call `shutdown()` explicitly from your own shutdown path so the last batch isn't lost:

```ts
process.on('beforeExit', () => aforo.shutdown());
```

## Step 6 — Verify it landed

In the Aforo console, open **Ingestion → Recent Events** and filter by your `customerId`/`metricName`. A successful batch returns `{ accepted, duplicates, failed }` from `POST /v1/ingest/batch`; duplicates (same idempotency key) are counted, not double-billed.

## Configuration reference

See the full `AforoOptions` and `TrackEvent` tables in the [README](README.md#configuration). The fields that most affect behavior: `flushCount` (50), `flushInterval` (5000 ms), `maxQueueSize` (10000, oldest-dropped on overflow), `maxRetries` (3), `timeout` (10000 ms).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Events never appear in Aforo | Process exited before a flush | Call `await aforo.shutdown()` on your shutdown path (Step 5). |
| `401 Unauthorized` in logs | Bad/missing API key | Check `AFORO_API_KEY`; the key is sent as `Authorization: Bearer`. |
| Middleware meters nothing | `customerId` resolver returns `null` for every request | Return a real id; confirm `req.user` is populated before the middleware runs. |
| Events accepted but don't bill | `metricName` isn't defined/mapped in Aforo | Define the metric (billable unit) in the console and map it to a rate plan. |
| Some events silently dropped under load | Ring buffer overflowed (`maxQueueSize`) | Raise `maxQueueSize`, or lower `flushInterval`/`flushCount` to drain faster. |

## What this guide does NOT cover

Defining metrics, rate plans, or pricing (done in the Aforo console), and the protocol-specific SDKs (GraphQL/gRPC/WebSocket/MQTT) — those live in the sibling `node-graphql` / `node-grpc` / `node-ws` / `node-mqtt` packages.
