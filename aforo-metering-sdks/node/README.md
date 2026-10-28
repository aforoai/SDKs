# @aforoai/metering

Track API usage from your Node service and send it to Aforo for billing. A queued, batched, retrying client plus Express / Fastify / Koa middleware — `track()` returns immediately and one background sender ships events, so metering never sits in your request path and an ingestor outage does not lose usage.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

```bash
npm i @aforoai/metering
```

> **Install `2.0.0` or later. `1.0.0` on npm was built from an older copy of this code and lacks the fixes listed in the changelog.** If `2.0.0` is not on npm yet, install from source:
> ```bash
> git clone https://github.com/aforoai/SDKs.git
> cd SDKs/aforo-metering-sdks/node
> npm install && npm run build
> npm pack        # produces aforo-metering-2.0.0.tgz to install in your app
> # then in your app: npm i /path/to/aforo-metering-2.0.0.tgz
> ```

Requires Node >= 18 (uses the built-in `fetch`).

## Quickstart

Meter a single event:

```ts
import { AforoClient } from '@aforoai/metering';

const aforo = new AforoClient({ apiKey: process.env.AFORO_API_KEY!, productType: 'API' });

await aforo.track({ customerId: 'cust_123', metricName: 'api_calls', quantity: 1 });

// The SDK installs no signal handlers. Flush from your own shutdown path:
process.once('SIGTERM', async () => {
  await aforo.shutdown(); // sends what is queued, for at most shutdownTimeoutMs
  process.exit(0);
});
```

Or meter every HTTP request with middleware — no per-route code:

```ts
import { AforoClient } from '@aforoai/metering';
import { expressMiddleware } from '@aforoai/metering/middleware/express';

const aforo = new AforoClient({ apiKey: process.env.AFORO_API_KEY!, productType: 'API' });

app.use(expressMiddleware({
  client: aforo,                                          // your client: you flush and shut it down
  customerResolver: (req) => req.user?.aforoCustomerId,   // from identity your app authenticated
  metricName: 'api_calls',                                // or (req, res) => string; must exist in your Aforo catalog
}));
```

The middleware hooks `res.on('finish')`, so it runs after the response is sent — zero added latency.

- **Customer (required):** `customerResolver: (req) => string | null | undefined` returns the Aforo customer id from identity your app verified — a session, a JWT subject, an API-key lookup. Without it, or the explicit opt-in below, the middleware throws when you create it. When the resolver returns nothing for a request, that event is dropped with reason `invalid` and counted in `droppedCount`; the request itself is never blocked.
- **`trustCustomerHeader: true`** reads the `X-Customer-Id` request header instead (or when the resolver returns nothing). That header is set by whoever calls your API, so turn this on only when a proxy you control sets it and strips any client copy. The caller's `X-Api-Key` header is never used — it is the end user's secret, not a customer id.
- **Client:** pass `client` (an `AforoClient` you own) so your code can `flush()`, read `droppedCount` and `shutdown()` it. With `apiKey` instead, the middleware creates a client and exposes it as `middleware.client` (Fastify shuts its own client down in `onClose`).
- **Metric:** `metricName` is a fixed name or a `(req, res) => string` resolver; the default is `"api_calls"` (exported as `DEFAULT_METRIC_NAME`). The metric must exist in your tenant's Aforo catalog: the ingestor rejects an event with an unknown `metricName` (the other events in the batch are still ingested), and the SDK reports it as a drop with reason `rejected`.
- **Path:** `endpointPath` is normalized by default — the framework's route template when there is one (`req.route.path`, Koa's matched route, Fastify's route URL), otherwise dynamic segments collapse (`/users/123` → `/users/:id`, UUIDs and Mongo ids too). That keeps one label per route instead of one per id. `normalizePath: false` sends the raw path; a function `(path, req) => string` normalizes it your way.
- **CORS preflights** (`OPTIONS`) are never metered, nor are requests whose quantity is `<= 0`.
- **HTTP context:** each event carries top-level `endpointPath` (no query string, max 512 chars), `httpMethod`, `statusCode` and `responseTimeMs`, plus `productType`.

Koa: `koaMiddleware({ client, customerResolver: (ctx) => ctx.state.user?.aforoCustomerId })`. Fastify: `fastify.register(fastifyPlugin, { client, customerResolver: (request) => request.user?.aforoCustomerId })`.

## Configuration

`new AforoClient(options)` — `options: AforoOptions`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `apiKey` | `string` | — (required) | Aforo API key, sent only as `X-API-Key`. Never logged and never shown by `inspect()` / `JSON.stringify`. |
| `baseUrl` | `string` | `https://api.aforo.ai` | Ingestor base URL. Events POST to `<baseUrl>/v1/ingest/batch`. Must be `https://`; plain `http://` is accepted only for `localhost`, `127.0.0.1` and `::1`. |
| `allowInsecureHttp` | `boolean` | `false` | Accept a plain `http://` `baseUrl` on another host (a private network you trust). |
| `productType` | `string` | `"API"` | Top-level `productType` stamped on every event (required by the ingestor). One of `API`, `AGENTIC_API`, `AI_AGENT`, `MCP_SERVER`, `GRPC_API`, `GRAPHQL_API`, `WEBSOCKET_API`, `MQTT_BROKER`; trimmed and uppercased. |
| `flushCount` | `number` | `500` | Events per request (capped at 1000). Reaching it wakes the background sender. |
| `flushInterval` | `number` (ms) | `5000` | The background sender also runs this often. |
| `maxQueueSize` | `number` | `10000` | Queue capacity; the oldest event is dropped on overflow. |
| `onDrop` | `(events, reason) => void` | none | Called with events the SDK loses for good. See [Dropped events](#dropped-events). |
| `maxRetries` | `number` | `3` | Retries on network errors, timeouts, 408, 429 and 5xx, with full-jitter backoff. `Retry-After` (seconds or an HTTP date) is honoured, capped at 60 s. |
| `retryBaseMs` | `number` (ms) | `500` | Backoff base: attempt *n* waits a random time up to `min(30 s, retryBaseMs · 2ⁿ)`. |
| `timeout` | `number` (ms) | `10000` | Total deadline per request. |
| `shutdownTimeoutMs` | `number` (ms) | `5000` | How long `shutdown()` keeps sending. Events still queued then are dropped with reason `shutdown`. |
| `flushOnExit` | `boolean` | `true` | Send queued events when the process is about to exit on its own (`beforeExit`), within `shutdownTimeoutMs`. |

### Delivery

One background sender per client sends one request at a time; `track()` only queues. If the ingestor is unreachable, keeps answering 408/429/5xx after the retries, or answers 401/403 (wrong or revoked key — logged as an error), the batch goes back to the front of the queue with its idempotency keys and sending pauses (5 s, doubling to 5 min, randomized). New events keep queueing up to `maxQueueSize`. The first successful request resumes normal sending; the ingestor deduplicates the re-sent keys. A 413 splits the batch in half. Other 4xx drop the batch with reason `rejected`. Request bodies are plain JSON (no gzip: the ingestor does not decode compressed bodies).

`track(event)` — `event: TrackEvent`: `customerId` (required, non-blank), `metricName` (required, non-blank), `quantity` (default 1, must be > 0), `productType` (overrides the client default for this event), `idempotencyKey` (a fresh random UUID v4 per event if omitted — pass your own key if you want the ingestor to deduplicate retries), `occurredAt` (ISO string or epoch ms; defaults to now), `executionStatus` (optional, see below), `endpointPath` / `httpMethod` / `statusCode` / `responseTimeMs` (optional HTTP context), `metadata` (string/number/boolean map).

`track()` never throws. After `shutdown()` an event is counted and reported with reason `closed`; an event the ingestor would reject is reported with reason `invalid` — see [Dropped events](#dropped-events).

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
| `overflow` | The queue was full; the oldest event was evicted. |
| `rejected` | The ingestor refused the batch with a non-retryable 4xx, refused these events individually inside a batch it otherwise accepted, or answered 413 to a single event. |
| `invalid` | The event failed a client-side check at `track()`, or a middleware `customerResolver` returned no customer. It was never queued or sent. |
| `shutdown` | Still queued when `shutdownTimeoutMs` ran out. |
| `closed` | `track()` was called after `shutdown()`. |
| `retry_exhausted` | Not produced by 2.x (kept in the type for compatibility): an outage requeues the batch instead of dropping it. |

`invalid` covers what the ingestor would reject for any deployment: blank `customerId` / `metricName`, `quantity <= 0`, a `quantity` with more than 14 integer digits or 6 decimal places, a malformed `occurredAt`, and fields over the server's size limit (`customerId` 64, `metricName` 255, `idempotencyKey` 255, `productType` 20, `endpointPath` 512, `httpMethod` 16). Nothing you pass to `track()` or set in the middleware options is truncated or rounded. The one exception is what the middlewares read off the request: a path over 512 characters or a method over 16 is cut to the limit and the event is still sent (one WARN per label). The WARN names the field, the limit and the value; it is logged for the first invalid event and then every 1000th. Limits the server makes configurable (event age, clock skew, metadata size) are not checked client-side.

When a 2xx response reports failures without saying which events, the count is added to `droppedCount` and logged, and `onDrop` is not called. A failed session heartbeat is not a drop.

### Sessions

`startSession(sessionId, productType = 'AI_AGENT')` sends a `system.session.heartbeat` event immediately and every 30s; `endSession()` sends a final `SESSION_END` heartbeat and flushes buffered usage. Heartbeats carry quantity 1, top-level `sessionId`/`productType`/`sessionBoundary`, and customer `system`; the ingestor intercepts them before billing. Each one goes in its own request, never inside a usage batch, and is best-effort (no retries; failures never affect usage delivery). The timer does not keep the process alive and stops on `endSession()`/`shutdown()`.

## Walk me through it

Step-by-step from install to a verified event in Aforo: see the **[User guide](USER_GUIDE.md)**.

## What this doesn't cover

This SDK only *emits* usage. Pricing, rate plans, and which `metricName`s are billable are configured in the Aforo console — this package does not create or validate them. An event whose `metricName` isn't defined in your tenant is **rejected** by the ingestor, so define the metric before sending it.
