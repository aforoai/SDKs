# Changelog — kong-plugin-aforo-metering

Format: [Keep a Changelog](https://keepachangelog.com). Versioning: [SemVer](https://semver.org).

The Kong plugin has one version: the rockspec's. `handler.lua`'s `VERSION` constant carries the same number. Releases are tagged `kong-vX.Y.Z`.

## [Unreleased]

## [2.6.0] — 2026-10-25

One line again. Merges the internal 2.2.0–2.5.0 releases with the public work after 2.1.0 (Gowtham: "Fix/kong ai agent metering" #57 and "Fix/kong latest konnect" #61, listed below under "Public changes after 2.1.0"). Every config key of either line is accepted. Where the two lines decided differently:

### Decided
- **Revocation when Redis cannot answer: refused with 503 by default** (internal 2.4.0). The public line made every Redis problem fail open. Kept from the public line: one Redis connection per request, AUTH with `jwt_redis_password` (else `rate_limit_redis_password` on the same Redis), the `jti:client:{client_id}` lookup, and an error reply (`NOAUTH`, `LOADING`, `MOVED`) is never read as revoked. Such a reply now means "Redis could not answer": 503 `REVOCATION_CHECK_UNAVAILABLE` with `Retry-After: 1`, or, with `jti_redis_fail_mode = open`, let through, logged and counted. Each check that could not run (`jti`, `client`) is counted once.
- **JWKS: the internal 2.5.0 implementation.** Per-worker cache for `jwt_jwks_cache_ttl` (default 600 s), https only with TLS verified, a 256 KiB body cap read in chunks, an 8 s budget for the whole fetch, at most one refresh per 30 s (5 s before the first success), the last good set used for up to 24 h. The JWKS key is used first and `jwt_public_key` verifies tokens the JWKS has no key for; on the public line `jwt_public_key` took precedence and the JWKS was never fetched when both were set. Added from the public line: a token whose cached key does not verify triggers one refresh, so a key replaced under the same `kid` (organization-service makes a new key pair on every start) is picked up. Not taken: the public line's background refresh. After the TTL one request per worker refreshes while the others keep verifying with the cached keys.
- **AGENTIC_API: the trace is never the client's** (public line). A request carrying a `traceparent` is no longer turned into `AGENTIC_API` on its own (internal 2.2.0 did that). Set `product_type = AGENTIC_API`; the trace comes from the upstream's `trace_id_header`, else Kong's request id.
- **Compound `correlationId` stays derived from `ngx.var.request_id`** (internal; Rule #21). The public line set it to a fresh UUID on every evaluation, so a resent compound event decomposed to new per-metric keys and was billed twice.

### Kept from the internal line
- `customer_id_jwt_claim` + `customer_id_jwt_exclude_claims` (customer from the claim of the JWT Kong's `jwt` plugin verified).
- A token let through by `jwt_allow_unverified_signature` gives access only: its claims are used for neither `customerId` nor `keyId`.
- `alg` must be `RS256`, `nbf` checked, 8 KB token cap, a private key in `jwt_public_key` refused.
- `grpc_enabled`, `graphql_enabled`, `websocket_enabled` detection (off by default), on top of the public line's event checks. Client-chosen names (gRPC service and method, GraphQL operation) are escaped and cut to the ingestor's limits rather than skipped; idempotency keys are `grpc:` / `gql:` / `ws:` + tenant + Kong's request id.
- Drop counters: `aforo_dropped:<reason>` in `aforo_buffer` and `aforo_metering_dropped_events_total{reason}` when Kong's prometheus plugin is loaded, now also for the drops in `event-buffer.lua`. Reasons: `buffer_overflow`, `rejected`, `ingestor_rejected`, `expired`, `too_large`, `missing_fields`, `invalid_field`.

### Changed
- A customer id's length is checked in characters when the event is built (as the ingestor counts it); it used to be capped at 64 bytes when resolved, which refused valid non-ASCII ids. A verified token naming an unusable customer id is not billed to the route's consumer instead.

### Tests
- busted 315/315 on `kong:3.4`, `kong/kong-gateway:3.14.0.15` and `kong/kong-gateway:3.16.0.1`: the public line's specs (JWKS cases rewritten for this implementation, Redis cases for the 503 default) plus `spec/jwt_identity_protocol_spec.lua` (the internal line's JWT, JWKS, revocation, identity, drop-counter and protocol tests) and new log-phase tests for gRPC / GraphQL / WebSocket, verified-only identity and Rule #21. Not yet run end to end against a live Kong and ingestor.

### Upgrade notes
- Internal 2.5.0 users: events buffered under `aforo:events` at upgrade time are not sent (2.6.0 keeps one buffer per destination). A traced request on an `API` route is now billed as `API`; set `product_type = AGENTIC_API` where that is the product.
- Public-line users: with `jwt_validation_enabled` and no reachable Redis, tokens carrying `jti`, `client_id` or `key_id` now get 503; point `jwt_redis_host` at Redis or set `jti_redis_fail_mode = open`. With both `jwt_public_key` and `jwt_jwks_uri` set, the JWKS is fetched and used first.

## Public changes after 2.1.0 (merged in 2.6.0)

Unreleased on the public line; shipped as part of 2.6.0. Where they differ from the 2.6.0 decisions above, the decisions win (JWKS precedence and background refresh, Redis fail mode).

### Compatibility
- **Tested on Kong Gateway 3.14 LTS and 3.16, and as a Kong Konnect data plane.** The busted suite (181 tests) passes on `kong:3.4`, `kong/kong-gateway:3.14.0.15` and `kong/kong-gateway:3.16.0.1`, and end-to-end tests against a stand-in Aforo pass on each (3.16 in DB-less mode, see below): all four product types meter the same events, the pre-flight quota check answers 429 with `Retry-After`, and RS256 verification through `resty.openssl` works. No plugin code changed for it.
- The `Dockerfile` takes the base image as a build argument, `KONG_IMAGE_BASE` (default `kong:3.4`, unchanged), e.g. `--build-arg KONG_IMAGE_BASE=kong/kong-gateway:3.16.0.1`. Kong ships no open-source image after 3.9.
- Documented two Kong Gateway behaviours that look like plugin problems and are not: unlicensed Kong Gateway 3.16 is read-only (Admin API writes get 403 "Enterprise license missing or expired"; DB-less configuration and Konnect data planes are unaffected), and Kong Gateway defaults a route's `protocols` to `https` only, so plain-http calls get 426.

#### Security
- **A client can no longer choose the identity its usage is billed under.** On an `AGENTIC_API` product the event's `traceId` — the goal Aforo bills per trace — was the client's `traceparent` or `x-trace-id`, so a client repeating one `traceparent` folded all its goals into one, and one sending another customer's trace id joined that customer's goal. It is now the upstream's `X-Aforo-Trace-Id` response header (new setting `trace_id_header`), else Kong's ID for the request (one call, one goal). `AI_AGENT` events now carry their session as `traceId`, so Aforo no longer groups an agent's sessions by the client's `traceparent`. The MCP agent is no longer the request body's `params._meta.agent_id` (see Fixed), and the MCP session is no longer the client's `Mcp-Session-Id` request header but the upstream's response. The client's trace headers are still sent in `trace`, for correlation.
- **JWT tokens are now bound to the plugin's tenant.** Aforo signs every tenant's tokens with the same key, so a valid token issued for one tenant used to be accepted by another tenant's gateway, metered under the gateway's tenant, and forwarded upstream with the token's tenant in `X-Tenant-Id`. A token whose `tenant_id` is not this plugin's `tenant_id` is now rejected with 401 `TENANT_MISMATCH`, and `X-Tenant-Id` sent upstream is always this plugin's `tenant_id`.
- **Revoking an OAuth client now blocks its tokens.** Aforo records client revocation under the token's `client_id`, but the plugin looked it up under `key_id` only, so tokens of a revoked client kept working at the gateway. Both are checked now.
- **A Redis error no longer rejects every token.** If the revocation Redis answered with an error (for example `NOAUTH` from a password-protected Redis), every token was rejected as 401 `TOKEN_REVOKED`, with nothing in the log. Revocation lookups now fail open on any Redis problem, as documented, and log a warning. New setting `jwt_redis_password`; it defaults to `rate_limit_redis_password` when the blocklist is on the same Redis.
- A token with a non-numeric or null `exp`, or with null claims, now gets 401 instead of a 500 error.
- **A lower-case `bearer` scheme no longer bypasses a HARD rate limit.** The rate limiter only recognised `Bearer`, so `Authorization: bearer <key>` was never rate limited.

#### Added
- `executionStatus` on every event, from the status the client received, by the table all Aforo gateway plugins share (2xx/3xx `SUCCESS`, 408/504 `TIMEOUT`, 499 `CANCELLED`, 400/422 `VALIDATION_FAILED`, 401/403/429 `BLOCKED`, other 4xx/5xx `ERROR`). Only MCP tool calls carried one, so under an `OUTCOME_BASED` plan an API's 500 billed like a 200, and a metric filtered on Execution Status counted no gateway traffic. New setting `status_outcomes` overrides it per status code; org-service already writes it, and Kong used to refuse the whole plugin configuration when it did.
- `trace_id_header` (default `X-Aforo-Trace-Id`): the upstream response header that names an `AGENTIC_API` request's trace.
- `mcp_meter_non_tool_calls` (default `false`). On an `mcp_enabled` route, MCP protocol messages that are not tool calls (`initialize`, `tools/list`, `ping`, notifications) are no longer billed as API calls; set it to `true` to meter them anyway.
- `jwt_jwks_uri` now works. The plugin fetches the issuer's JWKS, picks the key by the token's `kid`, caches the keys for an hour and refreshes them in the background. A token with an unknown `kid`, or one that does not verify against the cached key (the issuer replaced its key but kept the `kid`), triggers a refetch, at most once every 30 seconds. A token whose `kid` the JWKS does not have is always rejected, even with `jwt_allow_unverified_signature`. If the JWKS cannot be fetched, requests are refused at once instead of each waiting for the fetch timeout. Before, the setting was accepted but ignored, and a configuration that set only `jwt_jwks_uri` rejected every token. `jwt_public_key` still works and takes precedence.
- `AI_AGENT` metering. Three new settings: `agent_id` (the agent ID for the service or route), `agent_id_header` (default `X-Aforo-Agent-Id`) and `session_id_header` (default `X-Aforo-Session-Id`). The two headers are upstream response headers. With `product_type=AI_AGENT`, each event carries `agentId` (the response header, else `agent_id`) and `sessionId` (the response header, else Kong's ID for the request, so each request is its own session). Request headers are never read for either. Tokens are still reported with `X-Aforo-Quantity`. Events of other product types are unchanged.

#### Fixed
- Usage could go unbilled when a client repeated an `X-Request-Id`. The plugin used the client's `X-Request-Id` (or `X-Kong-Request-Id`) request header as each event's idempotency key, and Aforo keeps only the first event for a given key. A client that sent the same value on every call was billed once, and events from different customers that happened to send the same value were dropped as duplicates. The key is now Kong's own ID for the request, which a client cannot set. Retries of an event still carry its original key, so a retried flush is not double-counted. The client's `X-Request-Id` is still recorded in the event's trace context (`trace.xRequestId`) for correlating with your logs.
- Kong 3.4 would not start with version 2.1.0 of this plugin installed. Kong limits each setting's description to 500 characters, and the `product_type` description was 635, so Kong stopped at startup with `schema violation ... length must be at most 500`. The description is shorter now.
- When an `AI_AGENT` event is skipped for a missing agent ID, the warning says how to supply it.
- The `Authorization` scheme is matched case-insensitively, so `bearer <token>` is validated like `Bearer <token>`.
- **Rate limiting no longer turns into a 500 for every request.** Aforo writes rate-limit policies with null fields (rate-plan overrides have no tiers; burst capacity is often null), and the plugin crashed on them. Nulls are handled now, and any failure inside the rate-limit check lets the request through and is logged, instead of failing the request.
- Rate limiting now applies to key-auth traffic: the policy is looked up by the authenticated key-auth credential's key. Before, only an API key sent as `Authorization: Bearer` was looked up. A `PER_CUSTOMER` policy counts per customer (the JWT `customer_id`, else the Kong consumer), so a customer with several keys shares one limit instead of getting the limit once per key. Requests authenticated with a JWT are still not rate limited (a known limitation, logged once).
- A rate-limit tier without a numeric `maxRequests` is ignored. It used to count as a limit of 0, refusing every request under a HARD policy.
- **The margin guard now enforces.** It read fields pricing-service does not send, so a BLOCK or THROTTLE from pricing was never applied. It now answers 429 with `Retry-After` on BLOCK or THROTTLE, checks the tenant-wide (GLOBAL) scope as well as the customer's, and caches BLOCK, and ALLOW while no throttle is active, for `margin_guard_cache_ttl`. THROTTLE and the ALLOW for a request a throttle let through are never cached, because pricing throttles a share of requests and a cached pass would let every request through. Exact throttling needs a pricing-service version that marks such a pass with `currentLevel: L2_THROTTLE`; with older versions the pass is indistinguishable from a plain ALLOW and is cached. The cache now works: it used to need a shared dict that no install declared.
- **Usage from one plugin instance could be billed to another tenant.** All instances shared one buffer, and a flush sent whatever it held with the settings of the instance that flushed — so with two instances (two tenants, or two keys) one tenant's events went out with the other's `api_key` and endpoint. Each destination (`aforo_endpoint` + `tenant_id` + `api_key`) now has its own buffer, delivered only with its own endpoint, tenant and key, so instances never send each other's events with the wrong key. Events never move between buffers: when a plugin's `api_key`, `tenant_id` or `aforo_endpoint` changes, events already buffered keep their original settings (rotate keys by adding the new one in Kong before revoking the old one in Aforo — see the user guide). Central metric mappings are cached per tenant.
- **Events are no longer lost when the ingestor refuses a key or part of a batch.** 401, 403 and 404 used to drop the batch. Now the newest 500 events for that destination are kept and retried with the same key, backing off from twice `flush_interval_ms` to every 5 minutes, and the log says to check the key or endpoint. Any buffered event older than 72 hours is dropped with a log line, since the ingestor no longer accepts it. When the shared dict runs low, a refused (then a failing) destination's oldest events make room for the healthy ones, so a refused destination can never stop the others from being metered. Events a 202 reports as "could not be stored" are re-sent. A batch answered 400 is split so one bad event no longer takes the others with it; if every part of it gets 400, the request itself is being refused (a wrong path, a proxy in front of the ingestor) and the events are kept as for a 404. A batch answered 413 is split until the parts are small enough.
- **A slow or failing ingestor no longer floods it and starves Kong's timers.** Every request past `flush_count` started another flush; there is now at most one flush per buffer at a time, and after a failure the next try waits `flush_interval_ms`. A failing destination counts as failing from its first failed attempt until a 2xx, so a healthy one is never refused while the failing one still has events that could make room. Events also no longer sit unsent after a failed flush or a reload: a timed flush is always pending while events wait, a reload or graceful stop makes one last quick send, and after a reload or a crashed worker the buffered events are flushed again without waiting for new traffic. The plugin's own caches (metric mappings, JWKS, quota and margin-guard answers) no longer push buffered events out of a full dict: a single cache write could evict a whole buffer of events. They now simply miss when the dict is full.
- **One bad header can no longer cost a whole batch.** A malformed UTF-8 byte in any value made the ingestor unable to read the whole batch. Client and upstream values copied into events (trace headers, `Mcp-Session-Id`) are now dropped unless they are well-formed UTF-8 text within the ingestor's limits; the path and the MCP tool name keep valid Unicode unchanged and only have malformed bytes and control characters escaped; repeated headers are handled. Lengths are counted in characters, as the ingestor counts them, not bytes. `quantity` is rounded to 6 decimals and `endpointPath` cut to 512 characters, which the ingestor would otherwise refuse. An event whose customer id is not valid text is skipped with the reason.
- **An unusable upstream header no longer bills the wrong identity.** If the upstream sent `X-Aforo-Agent-Id`, `X-Aforo-Session-Id` or `X-Aforo-Metric` with a value the plugin could not use (malformed text, or too long), the event fell back to `agent_id`, a one-request session or the default metric. It is now skipped, with a warning naming the header. The same holds for `X-Aforo-Trace-Id`.
- With `mcp_meter_non_tool_calls=true`, the non-tool messages of a mixed JSON-RPC batch are metered as one API call, as documented. They were dropped when the batch also held a `tools/call`.
- **Paths that merely start like a health check are billed again.** `exclude_paths` matched any path beginning with an entry, so the defaults skipped `/healthcare/...`, `/metrics-api/...` and `/ready-meals/...`. An entry now matches that path and the paths below it only.
- **Streamed responses are billed with `quantity_source=response_size`.** It read `Content-Length`, which a chunked or SSE response does not have, so those responses billed as nothing. It now uses the bytes actually sent.
- **`responseTimeMs` is the real response time.** It reported Kong's own overhead only (an upstream that took 504 ms showed 2). The MCP `executionDurationMs` is fixed the same way.
- **MCP metering no longer crashes on unusual bodies**, such as a body of `1` or `"params": null`, which lost the event. A JSON-RPC batch now gives one event per `tools/call` in it, and bodies too large for Kong's memory buffer (up to 1 MB) are read too.
- **MCP agent:** `X-Agent-Id` from the client request is no longer read. It was documented as unread since 2.0.0 but was still used for MCP events. The agent is now the upstream's `X-Aforo-Agent-Id` response header, else the customer (the caller of an MCP server is the agent), and every tool call is sent as `MCP_SERVER`. Before, a tool call without an agent was skipped on an `MCP_SERVER` product, so an MCP server with no Aforo code metered nothing. `config.agent_id` is not used for MCP. On an `AI_AGENT` route, MCP events take the agent and session from config and the upstream, like other events there. An MCP tool call's metric now follows `X-Aforo-Metric` and the metric mappings too, then (on an `MCP_SERVER` product) `default_metric` unless it is still `api_calls`, then `mcp_server.tool_invocations`.
- **`product_type: MCP_SERVER` meters without `mcp_enabled`,** and bills only tool calls: a `GET` or `DELETE` on the MCP endpoint is not an event.
- **An `AI_AGENT` product with no `agent_id` is metered.** Without `agent_id` or the `X-Aforo-Agent-Id` response header every event was skipped; the agent now falls back to the Kong service's id.
- **Per-event failures in the ingestor's answer are read.** `/v1/ingest/batch` answers 202 with the per-event errors under `data.errors` (the platform envelope), and the plugin read only a top-level `errors`, so it saw none: an event refused for good (for example over a HARD_LIMIT quota) went unreported, and one the ingestor could not store was never sent again. Both shapes are read now. An event the ingestor could not store is re-sent on its own; one it refused is dropped, and the log gives the count and the reasons.
- **The pre-flight quota check asks about the metric the call is billed to,** and not at all for a call that will not be billed. An MCP tool call was checked against `default_metric` but billed to its tool-call metric, and an MCP `initialize` or `tools/list` could be refused 429. The default `preflight_quota_timeout_ms` is now 300 (was 100, which timed out often over the internet and failed open). `Retry-After` on a `DENY` is now at least 1 second; it could be `0`. A `WARN` is now cached like an `ALLOW` (the ingestor answers it near a limit and for overage plans past it, which cost one quota call per request); `DENY` is still never cached.
- `metadata.endpoint_path` is sent even with `include_metadata=false`; metric mappings and filters read it.
- `AGENTIC_API` events always carry a `traceId`: the upstream's `X-Aforo-Trace-Id`, else Kong's request ID (see Security).
- **Requests the plugin refuses are no longer billed.** A request turned away by the plugin itself — for example the 503 from `preflight_quota_fail_open=false` when the quota check is unavailable — was still metered as usage. Requests refused by JWT validation, rate limiting, the margin guard or the pre-flight quota check, and requests where the plugin's own checks failed, are now never metered. `exclude_status_codes` is unchanged.
- `compound-metering.lua` (shipped for integrations, not called by the plugin itself) built unusable events: it called `kong.tools.uuid()`, which does not exist in Kong 3.x, and sent `occurredAt` as epoch milliseconds, which Aforo reads as seconds. It now uses the same helpers as the plugin (new module `event-util`). Its default CDN metrics are renamed `bandwidth-in-bytes` / `bandwidth-out-bytes`; they carry byte counts and were named `-gb`.
- `margin_guard_enabled` without `margin_guard_url` is now rejected when the plugin is configured. It used to be accepted and then return 500 on every request. **In DB-less mode this rejects the whole declarative configuration**: Kong will not start, and `kong reload` keeps the old configuration, until `margin_guard_url` is set (or `margin_guard_enabled` is false). With a database, the Admin API refuses the change. A configuration stored before this check still loads; it lets requests through and logs an error.
- The docs and setting descriptions said `metric_header` and `quantity_header` are turned off by setting them to an empty string. Kong rejects an empty string for these settings (`length must be at least 1`); set them to `null` instead.

## [2.5.0] — 2026-10-25

### Added
- `jwt_jwks_uri` is implemented. The RS256 key comes from the issuer's JWKS (https only, TLS verified, 3 s timeout, 256 KiB cap) and is chosen by the token's `kid`, so organization-service can rotate its OAuth signing key without a Kong config change. The set is cached per worker for the new `jwt_jwks_cache_ttl` (default 600 s, 30–86400). A token whose `kid` is not cached refreshes the set at most once every 30 s per worker. When a refresh fails the last good set is used for up to 24 h; after that, and before the first successful fetch, tokens are rejected (401) unless `jwt_public_key` verifies them. Keys that are private, not RSA, not for signing or not RS256 are ignored. A token without a `kid` is verified only when the JWKS has exactly one key.
- `jwt_public_key` and `jwt_jwks_uri` can be set together: the static key verifies tokens the JWKS has no key for.
- Cold start: requests that arrive while a worker's first JWKS fetch is in flight wait for it (up to the 8 s fetch budget) instead of being rejected, and a worker whose first fetch failed tries again after 5 s instead of 30 s.
- The JWKS body is read in 8 KiB chunks: a `Content-Length` over 256 KiB is refused before reading, and a body without one is dropped as soon as it passes 256 KiB. The whole fetch (connect, request, body) must finish within 8 s. A fetch left marked in flight for longer (its request was aborted) no longer blocks later refreshes.
- Only RS256 keys and tokens are supported; EC (ES256) keys in the JWKS are ignored.

### Security
- A JWKS that cannot be fetched or parsed never lets a token through, `jwt_allow_unverified_signature` included. Missing-key log lines are throttled when JWKS is in use (the caller controls `kid`).

## [2.4.0] — 2026-10-24

### Security
- Revocation checks fail closed. When Redis cannot answer the jti-blocklist or client-revocation lookup (connect fails, or the GET errors or times out), the request is refused with **503** `{"error":"temporarily_unavailable","error_description":"REVOCATION_CHECK_UNAVAILABLE"}` and `Retry-After: 1`. Before, it was let through, so a revoked token or API key kept working for as long as Redis was down. organization-service already refuses (503) for the same check.

### Added
- Config `jti_redis_fail_mode` (`closed` default, `open`). `open` restores the old behaviour; each fail-open logs a warning (once per 60s) and is counted.
- Counter `aforo_metering_revocation_check_unavailable_total{check,outcome}` (when Kong's prometheus plugin is loaded) and shared-dict keys `aforo_revocation_unavailable:<check>:<outcome>` in `aforo_buffer`.

### Changed
- A GET error after a successful connect is now treated as "Redis could not answer". It used to read as "not revoked".
- **Upgrade note:** with `jwt_validation_enabled = true` and no reachable Redis (the default host is `127.0.0.1:6379`), every token carrying a `jti` or `key_id` claim now gets 503. Point `jwt_redis_host`/`jwt_redis_port` at Redis, or set `jti_redis_fail_mode = open`.

### Fixed
- Billing: idempotency keys (standard, MCP, gRPC, GraphQL, WebSocket) are built from `ngx.var.request_id` instead of the client's `X-Request-Id` / `X-Kong-Request-Id` / `Sec-WebSocket-Key`. A caller repeating one header value was billed once for many calls. The client's `X-Request-Id` is still sent as `trace.xRequestId`. New drop reason `no_request_identity` (not expected to fire). `compound-metering.lua` seeds `correlationId` from `ngx.var.request_id` only.
- Flush comment: Bearer `sk_` keys are accepted by the ingestor (aforo-common 1.3.84+); the plugin still sends `X-API-Key`.

## [2.3.0] — 2026-10-15

### Added
- `AI_AGENT` metering. A route with `product_type = AI_AGENT` now sends events: `agentId` comes from the upstream **response** header `agent_id_header` (default `X-Aforo-Agent-Id`) or, failing that, the new per-route `agent_id`; `sessionId` from the response header `session_id_header` (default `X-Aforo-Session-Id`). Before, every AI_AGENT event was skipped, because nothing could supply those fields.
- Config: `agent_id`, `agent_id_header`, `session_id_header`.
- MCP events take `sessionId` from `session_id_header` when the request has no `Mcp-Session-Id`.

### Changed
- MCP `agentId` precedence: `agent_id_header` response header, then `agent_id`, then the payload's `params._meta.agent_id`.
- An MCP `tools/call` with no agent id is metered as a plain request (configured `product_type` and metric). It was sent as `mcp_server.tool_invocations` under the configured type, a metric/type mismatch.
- A traced request on an `AI_AGENT` route stays `AI_AGENT` (with `traceId`); only other routes become `AGENTIC_API`.

### Security
- MCP `agentId` is no longer read from the `X-Agent-Id` request header. The header is client-settable, so a caller could attribute tool calls (and agent budgets, limits and analytics) to any agent. Apigee closed the same fallback in 2026-04 (IDOR finding #11). Agent and session ids are never read from request headers.

## [2.2.0] — 2026-10-02

Merges two lines that had diverged since 2026-06-29: the public 2.1.0 release (Gowtham and Eswar) and the internal handler line 1.4.0–1.4.4. Every config key of either line is still accepted.

### Version
- One version from here on. The internal `handler.lua` `VERSION` 1.4.4 is retired; the constant is now `2.2.0`, equal to the rockspec.
- One rockspec, `kong-plugin-aforo-metering-2.2.0-1.rockspec`, listing all six modules. `2.0.4-1` and `2.1.0-1` are removed.

### From the internal line (new to 2.1.0 users)
- `customer_id_jwt_claim` + `customer_id_jwt_exclude_claims`: customer from a claim of the JWT Kong's `jwt` plugin verified.
- `executionStatus` on every event from the shared status table, `status_outcomes` overrides, gRPC `grpc-status` mapping.
- `grpc_enabled`, `graphql_enabled`, `websocket_enabled` detection (off by default).
- AGENTIC_API classification when a trace id is present.
- Drop counters (`aforo_dropped:<reason>`, optional Prometheus counter).
- Idempotency keys never contain a clock. The 2.1.0 MCP key ended in `ngx.now()`.

### From 2.1.0 (new to internal-line users)
- In-plugin RS256 verification through `resty.openssl`, fail-closed. The internal line returned "valid" when `lua-resty-jwt` or `jwt_public_key` was missing.
- `metric_mappings`, `mappings_url`, `default_metric`, `metric_header`, `quantity_header`.
- Atomic shared-dict list buffer; batches of at most 1000; transient failures re-buffered; permanent 4xx dropped; `Retry-After` honoured on 429 (30 s cap, in the flush timer).
- CORS preflights not metered; quantity ≤ 0 skipped; per-product-type required fields.
- `preflight_quota_*` wired into the access phase; sibling modules resolve under `kong.plugins.aforo-metering.*`.

### Changed
- **Identity selection.** `customer_id_jwt_claim`, when set, is the only source. Otherwise the claim of the token this plugin verified, then the Kong consumer. 2.1.0 behaviour is unchanged for configs without `customer_id_jwt_claim`.
- **`jwt_allow_unverified_signature` no longer supplies identity.** A token let through without verification grants access only; its claims are not used for `customerId` or `keyId` unless Kong's `jwt` plugin verified the same token. A throttled warning is logged. Move to `customer_id_jwt_claim`.
- **Default metric.** Internal-line configs that left `metric_name_pattern` at `{method} {path}` now send `default_metric` (`api_calls`). Set `metric_name_pattern` to any other value to keep a pattern.
- Buffer key is `aforo:events` (a list). Events buffered under the old key at upgrade time are not sent.
- Flush timers are single-flight per kind, and a flush that leaves events behind schedules the next one.

### Security
- JWT verifier: `alg` must be `RS256` (rejects `none` and HS256 by name); `exp` must be numeric; `nbf` checked; signature checked before any claim; 8 KB token cap; a private key in `jwt_public_key` is refused; an unparseable key never falls back to the opt-out.
- Central mappings: cached per tenant, response capped at 1 MB / 5000 rules, failed fetches not repeated per request.
- Customer id longer than 64 characters is not used, from any source.

### Fixed
- A metric name that is blank or longer than 255 characters is dropped and counted (`invalid_metric`) instead of failing at the ingestor.
- Events the ingestor refuses inside an accepted batch are counted (`ingestor_rejected`) and logged with its message.
- `{path}` in `metric_name_pattern` containing `%` no longer raises.

### Deprecated
- `metric_name_pattern` default `{method} {path}` (ignored). `jwt_jwks_uri` (accepted, unused). `jwt_allow_unverified_signature` for identity.

## [2.1.0] — 2026-10-01

### Added
- `product_type` config (default `API`, trimmed + upper-cased, unknown values passed through): every event now carries the `productType` the ingestor requires in production. `compound-metering.lua` `build_compound_event` takes an optional `product_type` (default `API`).

### Fixed
- MCP `tools/call` is sent as `MCP_SERVER` only when both `toolName` and `agentId` are known; otherwise the configured `product_type` is kept, instead of an event the ingestor must reject (failing its whole batch).
- Events missing the fields their `productType` requires (`MCP_SERVER`: toolName + agentId; `AI_AGENT` agentId + sessionId and gRPC/GraphQL/WebSocket/MQTT fields, which the gateway cannot observe) and events with quantity <= 0 are skipped at the log phase rather than buffered.
- Flush honours `Retry-After` on 429 (up to 30 s; longer waits re-buffer the batch for a later flush instead of sleeping in the timer).
- USER_GUIDE no longer says the key is sent as `Authorization: Bearer`; it is sent as `X-API-Key` only.

## [2.0.0] — 2026-06-29

Initial public distribution packaging for the Kong plugin: README, user guide, and versioning, documented against the 2.0.0 security-hardened source.

This packaging documents the Kong slice of the **v2.0.0 security release (2026-04-23)** — tenant/customer-ID IDOR fixes:

- `schema.lua`: removed `"header"` and `"query_param"` from the `customer_id_source` enum. Only `"consumer"` remains; both removed sources read client-settable values and enabled billing-attribution spoofing.
- `handler.lua` `resolve_customer_id()`: rewritten to prefer the JWT-validated `customer_id` claim, then the Kong consumer identity (bound to the verified credential). Request headers and query params are never read — the `headers` argument is kept for call-site compatibility but ignored.
- `rate-limit-enforce.lua`: `PER_CUSTOMER` scope sources the customer ID from the validated JWT claims, not an `X-Customer-Id` request header; falls back to per-key scope, never to an unauthenticated source.
- `margin-guard.lua` + `preflight-quota.lua`: cache keys hardened because callers now pass JWT-validated customer IDs.
- `spec/handler_spec.lua`: added security regression tests covering the IDOR scenarios (requires busted to run).

Closes the Kong findings (1 HIGH + 3 MEDIUM) from the 2026-04-20 gateway-plugins IDOR advisory.

## [1.1.0] — 2026-04-16

- Plugin runtime line aligned with the repo-wide v1.1.0 release.

## [1.0.0] — 2026-04-01

- Initial release: log-phase metering with shared-memory batching + 3x exponential-backoff retry on flush.
- Access-phase JWT/JWKS validation and Redis-backed rate-limit enforcement (sliding window).
