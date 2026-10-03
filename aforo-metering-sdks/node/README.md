# @aforoai/metering

Track API usage from your Node service and send it to Aforo for billing. A buffered, batched, retrying client plus Express / Fastify / Koa middleware — `track()` returns immediately and events flush in the background, so metering never sits in your request path.

**Version:** 1.1.2 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

```bash
npm i @aforoai/metering
```

> **Install `1.1.2` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog.** If `1.1.2` is not on npm yet, install from source:
> ```bash
> git clone https://github.com/aforoai/SDKs.git
> cd SDKs/aforo-metering-sdks/node
> npm install && npm run build
> npm pack        # produces aforo-metering-1.1.2.tgz to install in your app
> # then in your app: npm i /path/to/aforo-metering-1.1.2.tgz
> ```

Requires Node >= 18 (uses the built-in `fetch`).

## Quickstart

Meter a single event:

```ts
import { AforoClient } from '@aforoai/metering';

const aforo = new AforoClient({ apiKey: process.env.AFORO_API_KEY!, productType: 'API' });

await aforo.track({ customerId: 'cust_123', metricName: 'api_calls', quantity: 1 });

// Flush remaining events before the process exits:
await aforo.shutdown();
```

Or meter every HTTP request with middleware — no per-route code:

```ts
import { expressMiddleware } from '@aforoai/metering/middleware/express';

app.use(expressMiddleware({
  apiKey: process.env.AFORO_API_KEY!,
  customerId: (req) => req.user?.id ?? null,   // return null to skip metering this request
  metricName: 'api_calls',                      // or (req, res) => string; must exist in your Aforo catalog
  productType: 'API',                           // default: the client default ("API")
}));
```

The middleware hooks `res.on('finish')`, so it runs after the response is sent — zero added latency.

- **Metric:** `metricName` is a fixed name or a `(req, res) => string` resolver; the default is `"api_calls"` (exported as `DEFAULT_METRIC_NAME`). The metric must exist in your tenant's Aforo catalog: the ingestor rejects an event with an unknown `metricName` (the other events in the batch are still ingested), and the SDK reports it as a drop with reason `rejected`.
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
| `onDrop` | `(events, reason) => void` | none | Called with events the SDK is about to lose. See [Dropped events](#dropped-events). |
| `maxRetries` | `number` | `3` | Retries on 5xx, 408, 429 and network errors (exponential backoff; `Retry-After` honoured on 429). Other 4xx are not retried. |
| `retryBaseMs` | `number` (ms) | `1000` | Base backoff delay. |
| `timeout` | `number` (ms) | `10000` | Per-request timeout. |
| `shutdownTimeoutMs` | `number` (ms) | `5000` | Max time `shutdown()` waits for a final flush. |

`track(event)` — `event: TrackEvent`: `customerId` (required, non-blank), `metricName` (required, non-blank), `quantity` (default 1, must be > 0), `productType` (overrides the client default for this event), `idempotencyKey` (a fresh random UUID v4 per event if omitted — pass your own key if you want the ingestor to deduplicate retries), `occurredAt` (ISO string or epoch ms; defaults to now), `executionStatus` (optional, see below), `endpointPath` / `httpMethod` / `statusCode` / `responseTimeMs` (optional HTTP context), `metadata` (string/number/boolean map).

`track()` throws only when the client is shut down. It never throws for the content of an event — see [Dropped events](#dropped-events).

### Execution status

`executionStatus` feeds outcome-based pricing: an OUTCOME_BASED rate plan bills each event at the weight set for its status. Events without a status bill at full price.

```ts
await aforo.track({ customerId: 'cust_123', metricName: 'api_calls', executionStatus: 'TIMEOUT' });
```

The value is trimmed and upper-cased; blank is treated as absent. Accepted: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value (or one longer than 20 characters) is WARN-logged and left off the event; the event is still sent.

### Dropped events

Every event the SDK loses is counted in `client.droppedCount`, WARN-logged, and passed to the opt-in `onDrop(events, reason)` hook. Events keep their idempotency keys, so re-submitting them with `track()` is dedup-safe.

| `reason` | When |
|---|---|
| `overflow` | The ring buffer was full; the oldest event was evicted. |
| `retry_exhausted` | A batch failed after all retries. |
| `rejected` | The ingestor refused the batch with a non-retryable 4xx, or refused these events individually inside a batch it otherwise accepted. |
| `invalid` | The event failed a client-side check at `track()` and was never buffered or sent. |

`invalid` covers what the ingestor would reject for any deployment: blank `customerId` / `metricName`, `quantity <= 0`, a `quantity` with more than 14 integer digits or 6 decimal places, a malformed `occurredAt`, and fields over the server's size limit (`customerId` 64, `metricName` 255, `idempotencyKey` 255, `productType` 20, `endpointPath` 512, `httpMethod` 16). Nothing you pass to `track()` or set in the middleware options is truncated or rounded. The one exception is what the middlewares read off the request: a path over 512 characters or a method over 16 is cut to the limit and the event is still sent (one WARN per label). The WARN names the field, the limit and the value; it is logged for the first invalid event and then every 1000th. Limits the server makes configurable (event age, clock skew, metadata size) are not checked client-side.

When a 2xx response reports failures without saying which events, the count is added to `droppedCount` and logged, and `onDrop` is not called. A failed session heartbeat is not a drop.

### Sessions

`startSession(sessionId, productType = 'AI_AGENT')` sends a `system.session.heartbeat` event immediately and every 30s; `endSession()` sends a final `SESSION_END` heartbeat and flushes buffered usage. Heartbeats carry quantity 1, top-level `sessionId`/`productType`/`sessionBoundary`, and customer `system`; the ingestor intercepts them before billing. Each one goes in its own request, never inside a usage batch, and is best-effort (no retries; failures never affect usage delivery). The timer does not keep the process alive and stops on `endSession()`/`shutdown()`.

## Walk me through it

Step-by-step from install to a verified event in Aforo: see the **[User guide](USER_GUIDE.md)**.

## What this doesn't cover

This SDK only *emits* usage. Pricing, rate plans, and which `metricName`s are billable are configured in the Aforo console — this package does not create or validate them. An event whose `metricName` isn't defined in your tenant is **rejected** by the ingestor, so define the metric before sending it.
