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

const aforo = new AforoClient({ apiKey: process.env.AFORO_API_KEY!, productType: 'API' });

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
  metricName: 'api_calls',                      // or (req, res) => string; must exist in your Aforo catalog
  productType: 'API',                           // default: the client default ("API")
}));
```

The middleware hooks `res.on('finish')`, so it runs after the response is sent — zero added latency.

- **Metric:** `metricName` is a fixed name or a `(req, res) => string` resolver; the default is `"api_calls"` (exported as `DEFAULT_METRIC_NAME`). The metric must exist in your tenant's Aforo catalog: the ingestor rejects an unknown `metricName`, and because it validates a batch as a whole, one rejected event fails every event in that batch.
- **Customer:** `customerId` is a fixed id or a `(req) => string | null` resolver; the default is `req.user.id` / `req.user.sub`, then the `X-Customer-Id` header. The caller's `X-Api-Key` header is never used — it is the end user's secret, not a customer id. Requests with no customer are not metered.
- **CORS preflights** (`OPTIONS`) are never metered, nor are requests whose quantity is `<= 0`.
- **HTTP context:** each event carries top-level `endpointPath` (path without query string, max 512 chars), `httpMethod`, `statusCode` and `responseTimeMs`, plus `productType`.

## Configuration

`new AforoClient(options)` — `options: AforoOptions`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `apiKey` | `string` | — (required) | Aforo API key, sent as `X-API-Key`. |
| `baseUrl` | `string` | `https://api.aforo.ai` | Ingestor base URL. Events POST to `<baseUrl>/v1/ingest/batch`. |
| `productType` | `string` | `"API"` | Top-level `productType` stamped on every event (required by the ingestor). One of `API`, `AGENTIC_API`, `AI_AGENT`, `MCP_SERVER`, `GRPC_API`, `GRAPHQL_API`, `WEBSOCKET_API`, `MQTT_BROKER`; trimmed and uppercased. |
| `flushCount` | `number` | `50` | Buffered events that trigger a flush (and events per request; capped at 1000). |
| `flushInterval` | `number` (ms) | `5000` | Background flush cadence. |
| `maxQueueSize` | `number` | `10000` | Ring-buffer cap; oldest events drop on overflow. |
| `maxRetries` | `number` | `3` | Retries on 5xx/timeout (exponential backoff). |
| `retryBaseMs` | `number` (ms) | `1000` | Base backoff delay. |
| `timeout` | `number` (ms) | `10000` | Per-request timeout. |
| `shutdownTimeoutMs` | `number` (ms) | `5000` | Max time `shutdown()` waits for a final flush. |

`track(event)` — `event: TrackEvent`: `customerId` (required, non-blank), `metricName` (required, non-blank), `quantity` (default 1, must be > 0 — otherwise `track()` throws), `productType` (overrides the client default for this event), `idempotencyKey` (auto-generated if omitted), `occurredAt` (ISO string or epoch ms; defaults to now), `metadata` (string/number/boolean map).

### Sessions

`startSession(sessionId, productType = 'AI_AGENT')` sends a `system.session.heartbeat` event immediately and every 30s; `endSession()` sends a final `SESSION_END` heartbeat and flushes buffered usage. Heartbeats carry quantity 1, top-level `sessionId`/`productType`/`sessionBoundary`, and customer `system`; the ingestor intercepts them before billing. Each one goes in its own request, never inside a usage batch, and is best-effort (no retries; failures never affect usage delivery). The timer does not keep the process alive and stops on `endSession()`/`shutdown()`.

## Walk me through it

Step-by-step from install to a verified event in Aforo: see the **[User guide](USER_GUIDE.md)**.

## What this doesn't cover

This SDK only *emits* usage. Pricing, rate plans, and which `metricName`s are billable are configured in the Aforo console — this package does not create or validate them. A `metricName` that isn't defined in your tenant is **rejected** by the ingestor — and fails the whole batch it travels in — so define the metric before sending it.
