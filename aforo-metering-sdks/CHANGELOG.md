# Aforo metering SDKs — Changelog

Each directory is its own package with its own version. Go modules are
released by git tag; their in-code `sdkVersion` constant is bumped here so
events report the right version. Publishing is a DevOps step — merging to
`main` does not release anything.

## Unreleased — 2026-10-02

### npm scope is `@aforoai` for every package

The seven packages that were named `@aforo/*` are now `@aforoai/*`, matching what is on npm (`@aforoai/metering`, `graphql-metering`, `grpc-metering`, `ws-metering`, `mqtt-metering`, `mcp-metering`, `mcp-proxy`; `@aforoai/agent-metering` already was). The two internal test servers are renamed the same way. Names only: package manifests and lockfiles, imports in docs and examples, log prefixes. Each `package.json` now carries `repository`, `homepage` and `bugs` pointing at `aforoai/SDKs`, which npm provenance requires. No version changes: every version here is already higher than the `1.0.0` on npm and PyPI and the Go `v1.0.0` tags. READMEs and user guides state the minimum version to install.

## Unreleased — 2026-10-01

### Over-long labels from the incoming request are truncated, not dropped (21 modules, patch bump)

An event whose label exceeded an ingestor limit was dropped as `invalid`. For a label that comes from the API consumer's request, that let the consumer avoid metering: a 300-character GraphQL operation name or a 600-character MQTT topic, and the call was never billed.

- **Truncated and still sent:** `endpointPath` 512 and `httpMethod` 16 (core HTTP middlewares); `gqlOperationName` 255; `grpcMethod` 128; `mqttTopic` 500 and `mqttClientId` 128; MCP `toolName` 64 (`node-mcp`, `python-mcp`, `mcp-proxy`); `wsCloseReason` 32 (`python-ws`); a capability name read from the call by `python-agent`'s decorator, 64. The protocol variants truncate in their `record*` methods as well as in the wrappers.
- **Limits** are the ingestor's `@Size` values, counted in UTF-16 code units as the server counts them. A surrogate pair is never split: the cut lands one unit earlier. Go previously cut `endpointPath` at 512 bytes and Python at 512 code points.
- **One WARN per label name** per client (per process in the core middlewares).
- **Still dropped as `invalid`, never altered:** `customerId`, `metricName`, `idempotencyKey`, `productType`, `agentId`, `sessionId`, configuration values such as the gRPC service name, and anything passed to core `track()` / python-agent `record_*()`. An unknown `executionStatus` is still left off the event.
- **Idempotency keys** are built from the untruncated label. A key is never cut: when it would exceed 255, the label inside it is replaced by the SHA-256 hex of its full text (the old code cut the key, in some modules removing its unique tail). Keys of 255 or fewer are built exactly as before. Each key is minted once per event and re-sent unchanged on retry.
- **Versions:** `node`, `python`, `java`, `go` 1.1.2; `node-graphql`, `node-grpc`, `node-mqtt`, `python-graphql`, `python-grpc`, `python-mqtt`, `python-ws`, `java-graphql`, `java-grpc`, `java-mqtt`, `go-graphql`, `go-grpc`, `go-mqtt`, `mcp-proxy` 1.2.2; `node-mcp`, `python-mcp` 1.3.2; `python-agent` 0.3.2. Unchanged: `node-ws`, `java-ws`, `go-ws` (no label is copied from the request), `node-agent`.
- `python-mqtt`: a test fixture now joins in-flight flush threads; one test failed intermittently before.

### One licence: Apache-2.0

`python-agent`, `mcp-test-server` and `agent-test-server` declared MIT; they now declare Apache-2.0 like every other module (manifest licence fields, the python-agent classifier, the two test-server lockfiles and READMEs). The root `LICENSE` is the only licence file. There is no `NOTICE` file and none is required: Apache-2.0 asks for one only when the work ships one. No source file carries a licence header and no third-party code is vendored in this repository.

### Responses are read from the `{success, data}` envelope (24 modules, patch bump)

The ingestor wraps every 2xx JSON body in `{success, data, meta}`. Every client here read response fields at the top level, where they are never present.

- **`mcp-proxy` 1.2.1** — `--quota-enforcement` never denied: `decision` sits under `data`. Fixed; a denied call gets JSON-RPC `-32000` with the server's `reason` and `retryAfterMs`. The check now asks about the customer the call is billed to.
- **All batch senders** (core ×4, protocol variants ×16, `node-mcp`, `python-mcp`, `python-agent`, `mcp-proxy`) — `failed` / `errors[]` in a 2xx response were never seen, so events the ingestor rejected were counted as sent and `onDrop(…, "rejected")` never fired for them. `killedSessionIds` was never seen either (`node-mcp`, `python-mcp`, `python`, `mcp-proxy`).
- A bare (unwrapped) body is still accepted everywhere.
- `contract/ingest-contract.json` gains a `responses` section (envelope, quota check, batch response) derived from `ApiResponseAdvice` and the controllers. The `mcp-proxy` suite loads its fixtures from it; every other suite's main partial-failure fixture now uses the enveloped shape.
- `node-agent` is unchanged (it reads no 2xx body).

### Merge with the public mirror (`aforoai/SDKs@585a54f`)

Ports Gowtham's work from the public repo so this repo holds everything before the first publish. Every module has a new version and its own `CHANGELOG.md`, `USER_GUIDE.md` and README.

- **Auth.** The API key is sent as `X-API-Key`; `Authorization: Bearer` is no longer sent. `X-API-Key` works for every key and every server version.
- **Default host** is `https://api.aforo.ai` (was `ingest.aforo.ai` / `usage-ingestor.aforo.ai`).
- **`productType` on every event.** The production ingestor requires it. Client option plus per-event override; defaults per module are in the README.
- **Field limits.** Events that break an ingestor limit (`customerId` 64, `metricName` 255, `idempotencyKey` 255, `productType` 20, `quantity` 14 integer / 6 decimal digits, per-protocol fields) are stopped before they are buffered. Nothing is truncated: the public repo's truncation of gRPC, GraphQL and MQTT fields was not ported, because a truncated id bills the wrong thing.
- **New drop reason `invalid`.** The public repo threw from `track()` for invalid events. Here they are counted, logged and passed to `onDrop` instead, and `track()` does not throw for event content. Go's `Track` also returns `ErrInvalidEvent`. python-agent's `record_*` methods no longer raise for blank fields.
- **Retries.** A 4xx other than 408/429 is sent once, not three times. 429 honours `Retry-After`. Events the ingestor refuses individually in an accepted batch are counted as `rejected`.
- **Heartbeats** are posted one per request, outside the usage batch, with quantity 1. They used to be buffered with quantity 0, which the ingestor refuses.
- **HTTP middlewares** (Express, Koa, Fastify, Flask, Django, FastAPI, net/http, chi, servlet filter, Spring starter): default metric `api_calls`, metric and customer resolvers, `OPTIONS` not metered, no fallback to the caller's `X-Api-Key` header as customer id.
- **Batch size** capped at 1000 events per request.
- **Idempotency keys** are unchanged in behaviour: one random key per event, created when the event is recorded and reused on retries. Both repos had made this fix independently. mcp-proxy adds a random component so a reused JSON-RPC id cannot collide.
- **Maven groupId is `ai.aforo`** (was `com.aforo`). Java package names stay `com.aforo.*`.
- **java-graphql / java-grpc:** `productType` is a seventh `record(...)` argument. **node-ws:** `durationMs` is sent as `executionDurationMs`. **MQTT SDKs:** connect and disconnect events use `$SYS/clients/<id>/connected|disconnected`.
- **Licence** metadata is Apache-2.0, matching the public repo's `LICENSE`.
- **New at the root:** `PUBLISHING.md`, `VERSIONING.md`, `LICENSE`, CI and publish workflows. Publish and release workflows only run in `aforoai/SDKs`.

Versions: node, python, java, go 1.1.0; the 16 protocol variants, mcp-proxy and node-agent 1.2.0; node-mcp and python-mcp 1.3.0; python-agent 0.3.0.

## Unreleased — 2026-09-30

### Execution status everywhere (outcome-based pricing)

**Review fixes (same day).**
- **Unknown statuses no longer lose the event — all 25 SDKs.** A caller status outside the 11 canonical values (or longer than 20 characters) used to be sent as-is, and the ingestor rejected that event, so its usage was lost. Now it is logged and left off; gRPC, GraphQL and the MCP SDKs send the status they derive instead. Versions: node 1.0.1, python 1.0.1, java 1.0.1; all 16 protocol variants 1.1.1; node-mcp 1.2.1, python-mcp 1.2.1, mcp-proxy 1.1.1, node-agent 1.1.1, python-agent 0.2.1.
- **MCP status resolvers.** An async resolver was ignored and, in Node, a rejecting one could crash the host with an unhandled rejection; it is now logged, its rejection swallowed, and the default used. python-mcp also accepts sync (`def`) handlers — they used to fail every call — and bills `KeyboardInterrupt`/`SystemExit` as `CANCELLED`.
- **mcp-proxy.** Calls are matched by session and JSON-RPC id, so two Streamable HTTP clients both using id `1` no longer overwrite each other (one call was lost, the other billed with the wrong result). Calls still waiting at shutdown are metered once as `CANCELLED`; they were lost. The 5-minute response timeout is configurable (`AFORO_RESPONSE_TIMEOUT_MS`, `--response-timeout-ms`, `aforo.responseTimeoutMs`), and `defaultToolStatus`, `EXECUTION_STATUSES`, `JsonRpcError` and `ToolStatusResolver` are exported.
- **python-agent decorator.** `wrap_capability_handler` billed a cancelled handler as `SUCCESS` and a timeout as `ERROR`; now `CANCELLED` and `TIMEOUT`. node-agent: a `metadata.executionStatus` can no longer override the step's status.
- **python-grpc.** Servers that fail with `context.abort(...)` or `context.set_code(...)` were billed `ERROR` / `SUCCESS`; the status now comes from `context.code()`, e.g. abort with `PERMISSION_DENIED` → `BLOCKED`.
- **go-grpc.** A handler returning `ctx.Err()` was billed `ERROR`; it is now `CANCELLED` / `TIMEOUT`, matching what grpc-go sends the client.
- **GraphQL.** One rule everywhere: `errors` is present unless missing, `null` or `[]`. node-graphql treated a non-array `errors` as none, so a failed request billed `SUCCESS`; its `gqlHasErrors` flag now agrees with the status. python-graphql: parse/validation failures are `VALIDATION_FAILED` (were `ERROR`), and the Strawberry extension uses the `on_operation` hook — the old hooks don't exist in current Strawberry, so it recorded nothing.
- **node-ws.** The connection-level `executionStatus` applies to the close event only, as in Python. It was stamped on the open event and every frame, so an `ERROR` meant for the close made every frame weight 0.
- **python-graphql default customer lookup.** For Strawberry's object context the extractor never read the `x-customer-id` header (an operator-precedence bug), so, with the extension now recording, every event would have gone out without a customer and been skipped. **python-grpc:** `record(status=grpc.StatusCode.X)` is sent as the code's name; the enum wasn't JSON-serializable and failed the whole batch.
- **Java variants.** A size-triggered flush and `close()` could drain the buffer at the same time and split one batch into two requests (flaky java-mqtt / java-ws tests); draining is now serialized.
- **@aforoai/metering (node) ESM build.** `npm run build` failed at the ESM step, and the ESM output couldn't be imported (extensionless imports, no `type: module` marker), so `import '@aforoai/metering'` failed in ESM projects. Both are fixed; CJS is unchanged.

- **node-agent 1.1.0, python-agent 0.2.0.** `ExecutionStatus` now lists all 11 canonical statuses. In Node, `PARTIAL`, `FAILED`, `VALIDATION_FAILED`, `FAILURE`, `PENDING` and `BLOCKED` used to fail to compile. Both SDKs export `EXECUTION_STATUSES`, and a test checks it against `contract/ingest-contract.json`. python-agent now trims and upper-cases the status. A blank or `None` status is left off the event instead of being sent as-is.
- **node-mcp 1.2.0, python-mcp 1.2.0, mcp-proxy 1.1.0.** A tool result with `isError: true` is now `ERROR`; it used to bill as `SUCCESS`, and that is the normal way an MCP tool reports failure. Timeouts (`TimeoutError`, JSON-RPC `-32001`) are `TIMEOUT`. python-mcp: a cancelled call is `CANCELLED`; before, `asyncio.CancelledError` slipped past `except Exception` and billed as `SUCCESS`. mcp-proxy: a call with no response after 5 minutes is now metered once as `TIMEOUT`; it used to be dropped unmetered. Each SDK takes an optional status resolver: `wrapToolHandler(handler, { statusResolver })`, `@wrap_tool_handler(status_resolver=...)`, and `aforo.statusResolver` for the proxy. node-mcp and python-mcp now report one consistent `sdkVersion` (it read 1.0.0 in some events and 1.1.0 in others).
- **All 16 protocol variants 1.1.0** (node / python / java / go × grpc, graphql, ws, mqtt). Each can send `executionStatus`, normalized like the core SDKs. gRPC derives it from the status code and GraphQL from the response (see README). WebSocket and MQTT send it only when you pass it. Endpoints, idempotency keys and the other event fields are unchanged.
