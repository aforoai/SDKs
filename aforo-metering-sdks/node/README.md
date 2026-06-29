# @aforo/metering

Track API usage from your Node service and send it to Aforo for billing. A buffered, batched, retrying client plus drop-in Express / Fastify / Koa middleware — `track()` returns immediately and events flush in the background, so metering never sits in your request path.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

```bash
npm i @aforo/metering
```

> **Not yet on the public npm registry.** Until it's published, install from source:
> ```bash
> git clone https://github.com/aforoai/SDKs.git
> cd SDKs/aforo-metering-sdks/node
> npm install && npm run build
> npm pack        # produces aforo-metering-1.0.0.tgz to install in your app
> # then in your app: npm i /path/to/aforo-metering-1.0.0.tgz
> ```

Requires Node >= 18 (uses the built-in `fetch`).

## Quickstart

Meter a single event:

```ts
import { AforoClient } from '@aforo/metering';

const aforo = new AforoClient({ apiKey: process.env.AFORO_API_KEY! });

await aforo.track({ customerId: 'cust_123', metricName: 'api_calls', quantity: 1 });

// Flush remaining events before the process exits:
await aforo.shutdown();
```

Or meter every HTTP request with middleware — no per-route code:

```ts
import { expressMiddleware } from '@aforo/metering/middleware/express';

app.use(expressMiddleware({
  apiKey: process.env.AFORO_API_KEY!,
  customerId: (req) => req.user?.id ?? null,   // return null to skip metering this request
}));
```

The middleware hooks `res.on('finish')`, so it runs after the response is sent — zero added latency. The default metric name is `"<METHOD> <normalized-path>"` (e.g. `GET /users/:id`).

## Configuration

`new AforoClient(options)` — `options: AforoOptions`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `apiKey` | `string` | — (required) | Aforo API key, sent as `Authorization: Bearer`. |
| `baseUrl` | `string` | `https://ingest.aforo.ai` | Ingestor base URL. Events POST to `<baseUrl>/v1/ingest/batch`. |
| `flushCount` | `number` | `50` | Buffered events that trigger a flush. |
| `flushInterval` | `number` (ms) | `5000` | Background flush cadence. |
| `maxQueueSize` | `number` | `10000` | Ring-buffer cap; oldest events drop on overflow. |
| `maxRetries` | `number` | `3` | Retries on 5xx/timeout (exponential backoff). |
| `retryBaseMs` | `number` (ms) | `1000` | Base backoff delay. |
| `timeout` | `number` (ms) | `10000` | Per-request timeout. |
| `shutdownTimeoutMs` | `number` (ms) | `5000` | Max time `shutdown()` waits for a final flush. |

`track(event)` — `event: TrackEvent`: `customerId` (required), `metricName` (required), `quantity` (default 1), `idempotencyKey` (auto-generated if omitted), `occurredAt` (ISO string or epoch ms; defaults to now), `metadata` (string/number/boolean map).

## Walk me through it

Step-by-step from install to a verified event in Aforo: see the **[User guide](USER_GUIDE.md)**.

## What this doesn't cover

This SDK only *emits* usage. Pricing, rate plans, and which `metricName`s are billable are configured in the Aforo console — this package does not create or validate them. A `metricName` that isn't defined in your tenant is accepted by the ingestor but won't bill until you map it.
