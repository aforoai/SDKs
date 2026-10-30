# Mock ingestor (test-only)

A fault-injecting stand-in for the Aforo usage-ingestor that every SDK test
suite in this repo starts as a subprocess. It enforces the same contract the
real ingestor does (`../contract/ingest-contract.json`, schema + batch limits)
and lets a test script outages, rate limits, slow and hung responses, connection
resets and per-event `retryable` failures. Zero dependencies; needs Node 18+.
Not published.

```bash
node mock-ingestor/bin/mock-ingestor.mjs --port 0
# {"event":"listening","port":53120,"url":"http://127.0.0.1:53120"}
```

Options: `--port` (0 = free port), `--host` (default `127.0.0.1`),
`--api-key` (require this exact `X-API-Key`; default: any non-blank key),
`--contract <path>`, `--no-stdin-watch`. The process exits on SIGTERM/SIGINT
and when its stdin closes, so a crashed test runner does not leave it running.

## Endpoints it serves

| Method + path | Behaviour |
|---|---|
| `POST /v1/ingest/batch`, `POST /api/v1/ingest/batch` | 401 without `X-API-Key`, 413 over `transportPolicy.batch.maxRequestBodyBytes`, `Content-Encoding: gzip` decoded with the same cap on the decoded body (413 past it, 400 when not gzip), 415 with `Accept-Encoding: gzip` for any other coding (as usage-ingestor's `GzipRequestFilter`, wave 8), 415 without `application/json`, 400 on malformed JSON / empty / over 1000 events. Otherwise 202 `{success, data: {accepted, duplicates, failed, errors[{index, message, retryable}], killedSessionIds}, meta}` with per-event schema validation (lengths in UTF-16 code units) and dedup on `idempotencyKey` per API key. |
| `POST /api/v1/quota/check` | 200 `{success, data: {decision, reason, ...}}`; decision set with `/__control/quota`. |

## Control API

| Method + path | Body | Effect |
|---|---|---|
| `POST /__control/faults` | `{"faults": [fault, ...]}` | Appends faults. Each request takes the first matching fault. |
| `DELETE /__control/faults` | — | Clears queued faults (ends an endless outage). |
| `POST /__control/quota` | `{"decision": "DENY", "reason": "...", "delayMs": 0, "retryAfterMs": 60000}` | Sets the quota answer. |
| `GET /__control/state` | — | `{requests[], events[], acceptedCount, uniqueKeys, duplicates, maxInFlight, inFlight, faultsRemaining, quotaChecks[]}` |
| `POST /__control/reset` | — | Clears everything. |
| `GET /__control/health` | — | `{"ok": true}` |

A fault:

| Field | Meaning |
|---|---|
| `match` | `"ingest"` (default) or `"quota"` |
| `times` | how many requests it applies to (default 1; `-1` = until cleared) |
| `status` | answer with this status and a problem body |
| `retryAfter` | `Retry-After` header value, sent verbatim (`"2"` or an HTTP-date) |
| `delayMs` | wait before answering (combine with a status, or alone for a slow 202) |
| `hang` | never answer — the client's timeout must fire |
| `reset` | destroy the connection without an answer |
| `location` | `Location` header (with a 3xx `status`, to test that clients never follow redirects) |
| `stallBody` | send 202 headers and the first bytes of the body, then nothing (the client's total deadline must fire) |
| `dripMs` | send the 202 body one byte every `dripMs` ms (a per-read timeout never fires; a total deadline does) |
| `perEvent` | `[{index, message, retryable}]` — a 202 that fails these events |
| `killedSessionIds` | `[string]` — a 202 whose `data.killedSessionIds` lists these sessions |

`requests[]` records, per ingest request: path, `contentType`, `contentEncoding`,
`userAgent`, `apiKeyPresent`, `bytes`, `eventCount`, `status` (−1 = reset,
−2 = hung, −3 = stalled or dripped body) and the `idempotencyKeys` sent — enough to assert that retries kept
their keys. `maxInFlight` is the highest number of concurrent ingest requests
seen, which is how the suites prove a client runs a single flusher.

## Tests

```bash
cd mock-ingestor && npm test
```
