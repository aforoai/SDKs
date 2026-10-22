# MuleSoft policy 3.0.0 — live contract checklist

`dataweave.test.cjs` runs the policy's DataWeave under the DataWeave CLI and `policy.test.cjs` checks the template's structure. Neither runs a Mule runtime: custom policies need the Enterprise runtime with API Gateway. Run this checklist on a **test API instance** before rolling 3.0.0 out, and after any runtime upgrade.

## Setup

- A test API instance (a basic-endpoint proxy is enough) whose upstream echoes the request headers and can be told which response headers and status to return, e.g. a small mock that answers `X-Aforo-*` headers from query parameters.
- `aforo-metering` 3.0.0 applied with `aforo-endpoint`, `aforo-api-key` (scope `usage:ingest`), `aforo-tenant-id` and `aforo-product-id` for a test product; `quota-enabled: true`.
- Keys from Aforo: `KEY` (subscribed to the product), `KEY_OTHER` (active, another product), `KEY_NONE` (active, `productIds: []`), `KEY_REVOKED`, and for an AI_AGENT / MCP product an agent client secret (48 lowercase hex).
- Access to the tenant's ingested events in Aforo and to the runtime's log.

## Identity (MC1 / MC2)

| # | Request | Expect |
|---|---|---|
| 1 | no `x-api-key` | 401 `{"message":"No API key found in request"}`, upstream not called, no event |
| 2 | `x-api-key: nope` | 401 `{"message":"Invalid authentication credentials"}`; repeat within 10 s: no second introspection call |
| 3 | `KEY_OTHER` | 403; `KEY_NONE`: 403 |
| 4 | `KEY` | the upstream's answer; **the upstream did not receive `x-api-key`**; one event with `customerId` = the key's customer |
| 5 | `KEY` with `X-Customer-Id`, `X-Client-Id`, `X-Agent-Id` request headers | same customer as 4; none of those values on the event |
| 6 | revoke `KEY` in Aforo, call every 10 s | refused (401) within about 60 s |
| 7 | block the runtime's route to Aforo, call with `KEY` (seen in the last 15 min) | allowed (stale answer), one `introspection failed … using the cached answer` warning per minute |
| 8 | as 7 with a key never seen | 503 `{"message":"Access check unavailable"}`, `Retry-After: 5` |
| 9 | `identity-fail-open: true`, as 8 | allowed, no event |
| 10 | encrypted gateway (gateway encryption key set), repeat 4 | same as 4 (the encrypted `aforo-api-key` is resolved) |

## Quota (pre-flight)

| # | Setup | Expect |
|---|---|---|
| 11 | customer within quota | allowed; a second call within 1 s makes no quota call |
| 12 | customer at a hard limit (DENY) | 429, `Retry-After` = ceil(retryAfterMs/1000), body `{"message","retryAfter"}` with the same number; upstream not called; no event |
| 13 | top up, call again at once | allowed (DENY is never cached) |
| 14 | quota endpoint unreachable | allowed, `quota check unavailable … failing OPEN` warning; with `quota-fail-open: false`: 503 `{"message":"Quota check unavailable"}` |
| 15 | excluded path (`/health`) | no quota call, no event, key still required |

## Product types and events

| # | Product / upstream answer | Expect on the event |
|---|---|---|
| 16 | API, upstream sends `X-Aforo-Quantity: 3` | `quantity` 3, `executionStatus` SUCCESS |
| 17 | API, upstream 404 / 500 | one event, `statusCode` 404 / 500, `executionStatus` ERROR |
| 18 | API backed by an APIkit app, unknown resource | the app's 404 reaches the client unchanged; one event with 404 |
| 19 | AGENTIC_API, client sends `traceparent` | `traceId` = the event's `idempotencyKey` (not the traceparent); with upstream `X-Aforo-Trace-Id: g1`: `traceId` g1 |
| 20 | AI_AGENT, upstream `X-Aforo-Agent-Id: a1`, `X-Aforo-Session-Id: s1` | `agentId` a1, `sessionId` s1, `traceId` s1; without them: `agent-id` (else the product id) and the request id |
| 21 | MCP_SERVER, batch with 2 `tools/call` + `tools/list` | 2 events, `toolName` each, `agentId` = the customer, `sessionId` = the upstream's `Mcp-Session-Id` |
| 22 | MCP_SERVER, `initialize` / `tools/list` / `ping` alone | allowed even when the customer is at a hard limit; no event |
| 23 | MCP_SERVER, body with `params._meta.agent_id: spoof` | `agentId` is not `spoof` |
| 24 | `metric-mappings` `[{"pathPattern":"^/v1/search","metricName":"searches"}]`, call `/v1/search?q=x` | `metricName` searches; quota checked for searches |

## Delivery

| # | Setup | Expect |
|---|---|---|
| 25 | normal | events visible in Aforo within seconds; response latency unchanged by delivery |
| 26 | an event the ingestor refuses (unknown metric) | `USAGE EVENT REFUSED (permanent, not retried): <metric> <key>: <reason>` once, not retried |
| 27 | ingestor down for 5 s, then up | events arrive (retried), no duplicates (same idempotency keys) |
| 28 | ingestor down for minutes under load | `USAGE NOT DELIVERED after 3 attempts`, then `USAGE DROPPED: 1000 calls' usage is already waiting` at most once a minute; API latency unaffected |
