# SDK transport core — specification (wave 5, contract v2)

Every metering SDK in this repo sends usage the same way. This file says how.
The numbers live in `ingest-contract.json` → `transportPolicy`; each SDK's
contract test reads them from there, so a change starts in the JSON, then this
file, then the code.

## One core per language, copied into each variant

Each language has **one** transport core. It lives in the core module and is
copied, unchanged, into every variant of that language:

| Language | Source of truth | Copy in each variant | Check |
|---|---|---|---|
| Go | `go/internal/ingest/*.go` (package `ingest`) | `go-*/internal/ingest/*.go` | byte-identical |
| Node | `node/src/transport-core/*.ts` | `node-*/src/transport-core/*.ts`, `mcp-proxy/src/transport-core/*.ts` | byte-identical |
| Python | `python/aforo/_transport/*.py` | `python-*/<package>/_transport/*.py` | byte-identical |
| Java | `java/src/main/java/com/aforo/metering/internal/transport/*.java` | `java-*/src/main/java/<variant package>/internal/transport/*.java` | identical after the `package` line |

`scripts/sync-transport.sh` copies the core into every variant;
`scripts/sync-transport.sh --check` fails when a copy differs (CI runs it).
Never edit a copy — edit the core and run the sync.

A copy, not a dependency, because every module is released on its own
(`go-ws v2.0.0` must not wait for a `go v2.0.0` tag to exist, and an npm
variant must not pin a core version that is not published yet). The check
makes the copies one implementation.

## Behaviour

### Queue and flusher (G266, G274, G276, G281, G285, G296, G308)

- One bounded FIFO queue per client, capacity `maxQueueSize` (default 10 000).
- Overflow evicts the **oldest** event and reports it through `onDrop(events, "overflow")`.
- **One** long-lived flusher per client (goroutine / daemon thread / async loop /
  single scheduled executor task). `track()` never starts a thread, goroutine,
  task or request: it enqueues and, when the queue reaches `flushCount`, wakes
  the flusher (channel / `threading.Event` / promise resolver / `AtomicBoolean`
  CAS). Waking an already-awake flusher is a no-op.
- The flusher also runs every `flushInterval` (default 5 s).
- An explicit `flush()` hands the work to the flusher and waits for it; it never
  runs a second, concurrent send.

### Batches (G269)

- Default `flushCount` = 500 events per request, clamped to `batch.maxEvents` (1000).
- A batch whose JSON body would exceed `batch.targetRequestBodyBytes` (4 MiB) is
  split before sending. The ingestor's hard cap is 16 MiB (`maxRequestBodyBytes`).
- Compression (wave 8, G269; `transportPolicy.compression`): a batch body of
  1 KiB (`minBytes`) or more is sent gzip-encoded with `Content-Encoding: gzip`;
  smaller bodies go plain. The body is compressed once and every retry sends the
  same bytes. The size split above is decided on the uncompressed JSON. A
  compression failure sends the JSON plain, never drops the batch. Callers can
  turn it off (`compression: 'none'` / `Compression: "none"` /
  `compression="none"` / `.compression("none")`) and cannot set
  `Content-Encoding` through extra headers. usage-ingestor decodes gzip (decoded
  body capped at 16 MiB, 413 past it) and answers any other coding with 415.

### HTTP (G268, G269, G270, G284)

- One pooled HTTP client per SDK client, reused for every request, closed on close.
- Every request has a total deadline (`timeout`, default 10 s). Node uses
  `AbortSignal.timeout`, Go `http.Client.Timeout` plus a request context,
  Python `httpx.Client(timeout=…)` (or `urllib` with a timeout), Java
  `HttpClient` + `HttpRequest.timeout`.
- `baseUrl` must be `https://`. Plain `http://` is allowed for `localhost`,
  `127.0.0.1` and `::1`, or anywhere with `allowInsecureHttp = true`. Anything
  else fails at construction.
- The API key is sent only as `X-API-Key`. It never appears in a log line,
  exception message, `repr`/`toString`/`String()` or `onDrop` payload.

### Retries (G267, G268, G283)

- Retry on network errors, timeouts and HTTP 408, 429, 500, 502, 503, 504.
- Backoff is **full jitter**: `delay = random(0, min(maxDelay, base · 2^attempt))`,
  base 500 ms, maxDelay 30 s.
- `Retry-After` is read in both forms (delta-seconds and HTTP-date). The delay is
  `max(retryAfter, jittered delay)`, capped at 60 s. An unreadable value is ignored.
- Never sleep while holding a lock that `track()` needs.
- Clock, sleep and random source are injectable so tests never wait on the wall
  clock.

### Status handling

| Response | Action |
|---|---|
| 2xx, `failed = 0` | done |
| 2xx with `errors[]` | `retryable: true` events go back to the queue (keys kept); the rest → `onDrop("rejected")` |
| 413 | split the batch in half and send each half; a single event that still gets 413 → `onDrop("rejected")` |
| 401, 403 | treated as an outage (below) and logged at ERROR once per breaker opening: the key is wrong or revoked, and a fixed key must not lose the queued usage |
| other 4xx | `onDrop("rejected")`, no retry |
| 408, 429, 5xx, network error, timeout | retry as above; after `maxRetries` → outage |

### Outage: requeue and breaker (G267)

After the last retry the batch goes back to the **front** of the queue with the
same idempotency keys, and the flusher pauses for the breaker cooldown (5 s,
doubling with full jitter up to 5 min). Tracking continues into the bounded
queue; overflow is reported as `overflow`. The first successful send closes the
breaker. Re-sending is safe because the ingestor deduplicates on
`idempotencyKey`.

### Shutdown (G267, G273, G283, G291, G293, G294, G307)

- `close` / `shutdown` stops accepting events, then flushes until
  `shutdownTimeout` (default 5 s). Each request in that window uses
  `min(timeout, time left)`; retries and breaker waits never run past the deadline.
- Events still queued at the deadline → `onDrop(events, "shutdown")` and counted.
- `track()` after close does not throw: the event is counted and reported as
  `onDrop([event], "closed")` (Go also returns `ErrClientClosed`).
- Libraries do not install signal handlers. Where a language offers a process
  exit hook (Python `atexit`, Node `beforeExit`), the SDK uses it to flush within
  the shutdown deadline; Java integrates with Spring's lifecycle
  (`SmartLifecycle`) when it runs inside Spring.

### Callbacks

- `onError` receives a typed error carrying `kind` (`outage` | `auth` |
  `rejected` | `shutdown` | `closed`) and the events concerned. Callers branch
  on `kind`, never on the message text.
- After each accepted (2xx) batch the core passes the envelope-unwrapped body
  to `onAccepted(body, events)`, so a client can read fields such as
  `killedSessionIds`.

### Drop reasons

`overflow`, `rejected`, `invalid`, `shutdown`, `closed`, and `retry_exhausted`
(kept for API compatibility; only reported when requeue is impossible because
the client is closed). Every dropped event keeps its idempotency key, so
re-tracking it after recovery is dedup-safe. A panic/exception in `onDrop` is
caught and logged.

### Customer identity (G265, G290, G300, G303, G310 — Jay's decision 2026-10-26)

Every integration that meters an incoming request takes a **customer resolver**
the caller writes from authenticated identity (session, JWT subject, API-key
lookup, mTLS identity). Reading a value the caller of *your* API controls —
`X-Customer-Id`, gRPC metadata, MCP `_meta.customer_id`, the MQTT username —
needs the explicit opt-in `trustCustomerHeader` (Python `trust_customer_header`,
Go `TrustCustomerHeader`). With neither, construction fails. There is no
fallback to `"unknown"`, `"anonymous"` or the agent id. When the resolver
returns nothing for a request, that event is dropped as `invalid` and counted;
the request itself is never blocked.

This is a breaking change: every module that had a default identity source gets
a major version and a CHANGELOG entry.

## Edge cases every core handles the same way (review, 2026-10-26)

An independent review compared the four cores and found them disagreeing on
the cases below. These rules settle each one; every core has a test per rule.

| Case | Rule |
|---|---|
| Request deadline | `timeout` covers the WHOLE exchange: connect, headers **and reading the response body**. A server that stalls mid-body or drips one byte at a time is cut off at the deadline (Python: a total deadline, not httpx's per-read timeout). |
| Redirects (3xx) | Never followed — the API key must not reach another host. A 3xx is handled like 401/403: logged at ERROR with the target host (not the key), the batch requeued, the breaker opened. Fixing the base URL recovers without loss. Reported through `onError` as kind `outage` with the 3xx `status`. |
| 5xx | Every 5xx is retried, not only 500/502/503/504. |
| Per-event `retryable` in a 2xx | Re-sent with the same keys after the normal jittered backoff, at most `maxRetries` times; after that treated as an outage (requeue + breaker). Never a tight loop. |
| Breaker cooldown | `max(250 ms, random(0, ceiling))`, ceiling `5 s · 2^n` capped at 5 min. One successful send resets `n`; a per-event retry cap reached right after a 2xx does not reset it. |
| Explicit `flush()` while the breaker is open | One attempt now (the caller asked); an outage reopens the breaker. |
| Shutdown after an outage | Keep retrying with jittered backoff until the shutdown deadline, then report what is left as `shutdown`. |
| Batch split in flight at shutdown | Every event of a batch that was taken off the queue is accounted for exactly once: sent, requeued, or reported (`shutdown` / `rejected`). This includes the unsent half of a 413 / body-size split and a request cut off by `close()`. Pending `flush()` callers are always completed. |
| Exit flush (`beforeExit` / `atexit`) | Keeps the process alive until the queue AND the batch in flight are done or the shutdown deadline passes; never treats "queue empty" as "done" while a request is in flight. Go and Java have no such hook: the caller's `Close`, a JVM shutdown hook or Spring's lifecycle calls `close()`, which is bounded the same way. |
| Unserializable event (e.g. BigInt, cycle, NaN in metadata) | Detected at `track()`: dropped as `invalid`, counted, never reaches a batch. |
| Callbacks | `onDrop`, `onError`, `onAccepted` may call `flush()` or `close()` without deadlocking; exceptions they throw are caught and logged. `onError` gets a typed error with `kind` (`outage` \| `auth` \| `rejected` \| `shutdown` \| `closed`) in every language. |
| 2xx with `errors[]` but `failed` missing or 0 | `errors[]` is authoritative: named events are rejected or requeued per their `retryable` flag. |
| `Retry-After` | Delta-seconds may be fractional (`1.5`); an HTTP-date in the past means 0. |
| Second `close()` | Returns the first close's result; never runs a second drain. |

## Testing against the mock ingestor (G312)

`mock-ingestor/` is a zero-dependency Node server every language's tests start
as a subprocess:

```bash
node mock-ingestor/bin/mock-ingestor.mjs --port 0
# stdout: {"event":"listening","port":53120}
```

Faults are scripted over HTTP (`POST /__control/faults`), received batches are
read back from `GET /__control/state`. See `mock-ingestor/README.md`.

Each language's suite exercises against it: an outage that recovers (no event
lost, keys unchanged), 429 with `Retry-After` in both forms, a slow response
past the request timeout, `close` while a request is in flight (shutdown
deadline honoured, leftovers reported), overflow while the breaker is open, and
a per-event `retryable` partial failure.
