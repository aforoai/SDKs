# 2026-04-15 — Bug Fixes: AWS Lambda Authorizer

## Files Changed

- `aws-lambda/authorizer.js`

## Fixes

### Reliability: Accumulate TCP chunks before parsing RESP response
The `redisGet()` function was calling `done()` on the first `socket.on('data')` event without
waiting for a complete RESP response. TCP `data` events can fire for partial chunks — e.g., if
the first chunk is just `"$"` (one byte), the check `response.startsWith('$') && !response.startsWith('$-1')`
would incorrectly return `true` (key found) for any partial response starting with `$`.

**Fix**: Added `let accumulated = ''` and append each chunk before checking. The check is only
performed once `accumulated.includes('\r\n')` — a complete RESP response always ends with `\r\n`.

In practice, Redis GET responses for JTI keys (6–8 bytes) arrive in a single packet on any
reasonable network. This fix ensures correctness under all network conditions.

### Performance/Reliability: Negative caching for JWKS fetch failures
If the JWKS endpoint (`/.well-known/jwks.json`) is temporarily unavailable, every Lambda
invocation was independently attempting a new JWKS fetch (with 5s timeout), causing:
- 5-second latency on every request during an outage
- Thundering-herd retries once traffic picks up

**Fix**: Added `jwksFetchErrorTime` tracking. After any JWKS fetch failure, subsequent fetches
within the next 30 seconds throw immediately with a cached error message. Once the backoff window
expires, the next request triggers a fresh fetch attempt. On success, `jwksFetchErrorTime` is
reset to 0.

This is consistent with the existing fail-open design: a JWKS outage causes auth failures, but
the failure is fast (no 5s timeout per request) and self-healing (auto-retries every 30s).
