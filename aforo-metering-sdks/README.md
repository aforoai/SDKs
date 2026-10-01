# aforo-metering-sdks

Client SDKs, gateway plugins, and testing artifacts for **Aforo metering** —
the ingest side of Aforo's billing platform. Everything a tenant installs to
send usage events to Aforo lives here.

Every package in this repo is either:

- A **production SDK** a tenant installs into their application (`@aforoai/*`, `aforo-*`, `ai.aforo:*`, `github.com/aforoai/SDKs/aforo-metering-sdks/go*`), OR
- A **testing tool** used to validate Aforo's own metering plumbing (`@aforoai/mcp-test-server`, and the `contract/` shared schema).

Tenants publish their MCP servers, agents, and APIs; Aforo meters the calls.
Every SDK in this repo is a "thin metering layer" you add to your code, or a
transparent proxy that meters without code changes.

---

## Core HTTP metering SDKs — one per language

Every real integration starts here. Wraps `POST /v1/ingest/batch` and does batching,
buffering, retries, and idempotency for you.

| Package | Directory | Install | Runtime |
|---|---|---|---|
| `@aforoai/metering` | [`node/`](./node/) | `npm i @aforoai/metering` | Node 18+ |
| `aforo-metering` | [`python/`](./python/) | `pip install aforo-metering` | Python 3.9+ |
| `ai.aforo:metering` | [`java/`](./java/) | Maven `ai.aforo:metering` (Java packages are `com.aforo.*`) | Java 17+ |
| `github.com/aforoai/SDKs/aforo-metering-sdks/go` | [`go/`](./go/) | `go get github.com/aforoai/SDKs/aforo-metering-sdks/go` | Go 1.21+ |

### Reporting the request outcome (`executionStatus`)

Each core SDK accepts an optional execution status per event. It feeds
outcome-based pricing: an OUTCOME_BASED rate plan bills each event at the
weight set for its status. Events sent without a status bill at full price.

```ts
client.track({ customerId: 'cust_42', metricName: 'api_calls', executionStatus: 'TIMEOUT' }); // Node
```
```python
client.track(customer_id="cust_42", metric_name="api_calls", execution_status="TIMEOUT")  # Python
```
```java
client.track(TrackEvent.builder("cust_42", "api_calls").executionStatus("TIMEOUT").build()); // Java
```
```go
client.Track(metering.TrackEvent{CustomerID: "cust_42", MetricName: "api_calls", ExecutionStatus: "TIMEOUT"}) // Go
```

The SDK trims and upper-cases the value and leaves it off the event when it's
blank. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`,
`VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`,
`HITL_REQUIRED`. Any other value is logged as a warning and left off the event:
sent as-is, the ingestor would reject that event and its usage would be lost.

## What every SDK does on the wire

- **Endpoint and host.** `POST https://api.aforo.ai/v1/ingest/batch` with `{"events":[...]}`, at most 1000 events per request (`@aforoai/agent-metering` posts single events to `/v1/ingest/events`). Override the host with the base-URL option.
- **Auth.** The API key goes in `X-API-Key`. No `Authorization` header is sent.
- **`productType`.** Every event carries a top-level `productType`; the production ingestor rejects events without one. Defaults: core SDKs `API`, GraphQL `GRAPHQL_API`, gRPC `GRPC_API`, WebSocket `WEBSOCKET_API`, MQTT `MQTT_BROKER`, MCP SDKs and proxy `MCP_SERVER`, agent SDKs `AI_AGENT`. Set it per client or per event.
- **Idempotency keys.** One key per event, created when the event is recorded and reused on every retry, so a re-sent batch is deduplicated. Pass your own key to control deduplication; otherwise the SDK generates a random one.
- **Retries.** Network errors, 5xx, 408 and 429 are retried (429 honours `Retry-After`). Any other 4xx is not retried.
- **Session heartbeats.** Sent one per request, outside the usage batch, best-effort. A failed heartbeat is not a dropped usage event.
- **HTTP middlewares.** The default metric is `api_calls` (it must exist in your catalog); pass a fixed metric or a resolver to change it. `OPTIONS` requests are not metered, and a request with no resolvable customer is skipped — the caller's `X-Api-Key` header is never used as a customer id.

### Dropped events

An event the SDK cannot deliver is counted (`droppedCount`), logged as a warning and passed to the optional `onDrop(events, reason)` hook. Dropped events keep their idempotency keys, so recording them again later is safe.

| Reason | When |
|---|---|
| `overflow` | The buffer was full; the oldest event was evicted. |
| `retry_exhausted` | A batch still failed after all retries. |
| `rejected` | The ingestor refused the batch with a non-retryable 4xx, or refused individual events in an otherwise accepted batch. |
| `invalid` | The event breaks a limit the ingestor enforces, so it was never sent. |

Field limits are checked before an event is buffered, because the ingestor's per-event rejection arrives on a background flush where no caller sees it. The limits are the ingestor's own: `customerId` 64 characters, `metricName` 255, `idempotencyKey` 255, `productType` 20, `quantity` greater than 0 with at most 14 integer digits and 6 decimal places, and the per-protocol fields listed in each module's guide. Nothing is truncated or rounded. `track()` does not throw for event content; Go's `Track` also returns `ErrInvalidEvent`. Limits the server lets a deployment configure (event age, clock skew, metadata size) are not checked client-side.

Each module has a `README.md`, a `USER_GUIDE.md` and a `CHANGELOG.md`. Versions: [VERSIONING.md](./VERSIONING.md). Releases: [PUBLISHING.md](./PUBLISHING.md).

## AI agent metering

`@aforoai/agent-metering` ([`node-agent/`](./node-agent/)) and
`aforo-agent-metering` ([`python-agent/`](./python-agent/)) meter AI_AGENT
products: sessions, reasoning steps, capability invocations and tokens.
Both export the 11 canonical statuses (`EXECUTION_STATUSES`, and the
`ExecutionStatus` type), so a step can be reported as `PARTIAL`, `BLOCKED`,
`HITL_REQUIRED` and so on. Steps sent without a status are `SUCCESS`.

## Protocol variants — one SDK per (language, protocol) pair

Non-HTTP transports get their own package that speaks the transport
natively and forwards to `/v1/ingest` internally.

| Protocol | Node | Python | Java | Go |
|---|---|---|---|---|
| **WebSocket** | `@aforoai/ws-metering` [`node-ws/`](./node-ws/) | `aforo-ws-metering` [`python-ws/`](./python-ws/) | `ws-metering` [`java-ws/`](./java-ws/) | `github.com/aforoai/SDKs/aforo-metering-sdks/go-ws` [`go-ws/`](./go-ws/) |
| **gRPC** | `@aforoai/grpc-metering` [`node-grpc/`](./node-grpc/) | `aforo-grpc-metering` [`python-grpc/`](./python-grpc/) | `grpc-metering` [`java-grpc/`](./java-grpc/) | `github.com/aforoai/SDKs/aforo-metering-sdks/go-grpc` [`go-grpc/`](./go-grpc/) |
| **GraphQL** | `@aforoai/graphql-metering` [`node-graphql/`](./node-graphql/) | `aforo-graphql-metering` [`python-graphql/`](./python-graphql/) | `graphql-metering` [`java-graphql/`](./java-graphql/) | `github.com/aforoai/SDKs/aforo-metering-sdks/go-graphql` [`go-graphql/`](./go-graphql/) |
| **MQTT** | `@aforoai/mqtt-metering` [`node-mqtt/`](./node-mqtt/) | `aforo-mqtt-metering` [`python-mqtt/`](./python-mqtt/) | `mqtt-metering` [`java-mqtt/`](./java-mqtt/) | `github.com/aforoai/SDKs/aforo-metering-sdks/go-mqtt` [`go-mqtt/`](./go-mqtt/) |

Every protocol variant also accepts `executionStatus` (Python:
`execution_status`), normalized and checked the same way as the core SDKs. A
valid value you pass always wins. An invalid one is logged; gRPC and GraphQL
then send the status they derive, and WebSocket and MQTT leave it off. When you
don't pass one:

| Protocol | Status the SDK sends by default |
|---|---|
| gRPC | Derived from the gRPC status code: `OK` → `SUCCESS`, `CANCELLED` → `CANCELLED`, `INVALID_ARGUMENT` / `FAILED_PRECONDITION` / `OUT_OF_RANGE` → `VALIDATION_FAILED`, `DEADLINE_EXCEEDED` → `TIMEOUT`, `PERMISSION_DENIED` / `RESOURCE_EXHAUSTED` / `UNAUTHENTICATED` → `BLOCKED`, anything else → `ERROR`. Same table as the gateway plugins. |
| GraphQL | Derived from the response: no errors → `SUCCESS`; errors with data → `PARTIAL`; errors with `data: null` (failed while running) → `ERROR`; errors with no `data` key (rejected before running) → `VALIDATION_FAILED`. `errors` counts as present unless it is missing, `null` or `[]`. Python result objects always have a `data` attribute, so there `data: None` with only path-less errors (parse/validation) is `VALIDATION_FAILED`. With only an HTTP status, the gateway plugins' HTTP table applies. |
| WebSocket, MQTT | None. Frames and messages carry no success or failure signal, so pass the status yourself when it matters. |

Each module's README shows the exact option names.

## MCP metering — three ways in

**Model Context Protocol** is the AI-tool-invocation protocol used by
Claude Desktop, LangChain, Anthropic API, and every emerging agent
framework. Aforo meters `tools/call` invocations across all three MCP
transports (HTTP, stdio, SSE / Streamable HTTP).

| Package | Directory | For |
|---|---|---|
| `@aforoai/mcp-metering` | [`node-mcp/`](./node-mcp/) | Wrap tool handlers directly. Fastest to install; the tenant owns the code. |
| `aforo-mcp-metering` | [`python-mcp/`](./python-mcp/) | Same, Python edition. |
| `@aforoai/mcp-proxy` | [`mcp-proxy/`](./mcp-proxy/) | Transparent sidecar. Meters MCP servers without SDK integration — the only path that works for stdio-only servers and third-party MCP servers you can't modify. |

**Execution status.** A tool that fails usually *returns* `{ isError: true, ... }`
rather than throwing. All three paths now bill that as `ERROR`, not `SUCCESS`:

| Outcome | `executionStatus` |
|---|---|
| Normal result | `SUCCESS` |
| Result with `isError: true` | `ERROR` |
| Thrown error / JSON-RPC error response | `ERROR` |
| Timeout: a `TimeoutError`, JSON-RPC code `-32001`, or (proxy only) no response within the response timeout (default 5 minutes, `AFORO_RESPONSE_TIMEOUT_MS`) | `TIMEOUT` |
| Cancelled or interrupted (`asyncio.CancelledError`, `KeyboardInterrupt`; Python only) | `CANCELLED` |
| Proxy shut down while the call was still waiting | `CANCELLED` |

A returned `isError` result is `ERROR`, not `FAILURE`. Whether a tool author
throws or returns the error shouldn't change the bill, and `ERROR` is what
every gateway and SDK sends for a call that ran and failed. To decide the
status yourself, pass a resolver. It receives the result and the error;
return a status, or nothing to use the default. It must be synchronous: a
Promise/coroutine, a value outside the 11 statuses, or an exception is logged
and the default is used.

```ts
billing.wrapToolHandler(handler, {
  statusResolver: (result, error) => (result?.structuredContent?.partial ? 'PARTIAL' : undefined),
});
```
```python
@billing.wrap_tool_handler(status_resolver=lambda result, error: "PARTIAL" if is_partial(result) else None)
async def handle_tool(name, arguments): ...
```

For `@aforoai/mcp-proxy`, set `aforo.statusResolver` when you embed it as a
library; the CLI has no flag for it.

**Alternative path** — Aforo's gateway plugins ([`aforo-gateway-plugins`](https://github.com/aforoai/aforo-gateway-plugins))
also detect MCP `tools/call` payloads in the HTTP path and generate metering
events. Zero-code integration when a tenant already runs Kong / Apigee / AWS
API Gateway / Azure APIM / MuleSoft in front of their MCP server.

## Testing tools (internal — not for tenant install)

| Package | Directory | Purpose |
|---|---|---|
| `@aforoai/mcp-test-server` | [`mcp-test-server/`](./mcp-test-server/) | Runnable toy MCP server (HTTP + stdio + SSE). Used by [`aforo-nextgen-loadgen`'s `mcp_jsonrpc` driver](https://github.com/aforoai/aforo-nextgen-loadgen/blob/main/scenarios/ci-mcp-jsonrpc.yaml), the nightly regression pipeline, and sales demos. Bare — does no metering itself. Meant to sit behind whatever metering layer is under test. **Not published to npm for tenant install.** |
| [`contract/`](./contract/) | Shared ingest-contract JSON schema every SDK is asserted against. Prevents wire-shape drift; asserted by all 24 SDK test suites. |

## Cross-repo pointers

- **Gateway plugins** (Kong / Apigee / AWS Lambda / Azure APIM / MuleSoft): [`aforo-gateway-plugins`](https://github.com/aforoai/aforo-gateway-plugins)
- **Load / stress testing** — including the `mcp_jsonrpc` ingestion path that pairs with `@aforoai/mcp-test-server`: [`aforo-nextgen-loadgen`](https://github.com/aforoai/aforo-nextgen-loadgen)
- **Public docs (docs.aforo.ai)** — end-user integration guides: [`aforo-nextgen-main-documentation-app`](https://github.com/aforoai/aforo-nextgen-main-documentation-app)
- **The platform's ingest endpoint** (`POST /v1/ingest`): [`aforo-nextgen-usage-ingestor-service`](https://github.com/aforoai/aforo-nextgen-usage-ingestor-service)

## Wire contract

Every SDK in this repo posts to the same canonical endpoint with the same
canonical envelope. The schema lives in [`contract/ingest-contract.json`](./contract/ingest-contract.json)
and is asserted from every language's test suite — a change to the wire
shape must be a schema change, not an SDK-local drift.

## License

Apache-2.0 — see [LICENSE](./LICENSE). Every module in this repository, including `python-agent` and the two test servers, declares Apache-2.0 in its manifest.
