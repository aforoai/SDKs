# @aforo/mcp-metering

Wrap your MCP server's tool handlers so every `tools/call` is metered for billing, with session heartbeats and server-driven session kill signals — without changing your tool logic. Best when you own the MCP server source and want metering inline, not a sidecar.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

```bash
npm i @aforo/mcp-metering
```

> **Not yet on the public npm registry.** Until it's published, install from source:
> ```bash
> git clone https://github.com/aforoai/aforo-metering-sdks.git
> cd aforo-metering-sdks/node-mcp
> npm install && npm run build
> npm pack        # produces aforo-mcp-metering-1.0.0.tgz
> # then in your MCP server: npm i /path/to/aforo-mcp-metering-1.0.0.tgz
> ```

Requires Node >= 18 (uses the built-in `fetch` and `AbortSignal.timeout`).

## Quickstart

Wrap the handler you already pass to `setRequestHandler`. The wrapper times the call, fires a usage event, and re-throws any error unchanged:

```ts
import { AforoMcpBilling } from '@aforo/mcp-metering';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const billing = new AforoMcpBilling({
  tenantId: 'tenant_smartai',
  productId: 'prod_mcp_001',
  apiKey: process.env.AFORO_API_KEY!,
  ingestorUrl: 'https://usage-ingestor.aforo.ai',
});

server.setRequestHandler(
  CallToolRequestSchema,
  billing.wrapToolHandler(async (request) => {
    // your tool logic, unchanged
    return { content: [{ type: 'text', text: 'done' }] };
  }),
);

// On shutdown, flush remaining events and stop timers:
process.on('SIGTERM', () => billing.shutdown());
```

The wrapper reads `agent_id` and `session_id` from `request.params._meta`. If a `session_id` is present, the first wrapped call auto-starts a heartbeat for that session.

> ⚠ `ingestorUrl` is the **base** URL — the SDK appends `/v1/ingest/batch` itself. Pass `https://usage-ingestor.aforo.ai`, not `https://usage-ingestor.aforo.ai/v1/ingest/batch`. A trailing slash is stripped for you.

## Configuration

Pass these to `new AforoMcpBilling({...})`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `string` | — (required) | Aforo tenant scope. Sent as `X-Tenant-Id`; also the heartbeat's `customerId`. |
| `productId` | `string` | — (required) | The MCP_SERVER product these events bill against. Carried in event metadata. |
| `apiKey` | `string` | — (required) | Sent as `Authorization: Bearer <apiKey>`. |
| `ingestorUrl` | `string` | — (required) | Base ingestor URL. The SDK appends `/v1/ingest/batch`. |
| `entitlementMode` | `'SERVER_LEVEL' \| 'TOOL_LEVEL'` | unset | Reserved for entitlement scoping. Accepted but not enforced client-side at this version. |
| `sessionConfig.idleTimeoutSec` | `number` | unset | Reserved for session idle/duration policy. Accepted; not enforced client-side at this version. |
| `sessionConfig.maxDurationSec` | `number` | unset | Reserved; same as above. |
| `flushIntervalMs` | `number` | `5000` | Periodic flush interval. A timer flushes the buffer on this cadence. |
| `flushCount` | `number` | `50` | Force a flush once the buffer reaches this many events. |
| `heartbeatIntervalMs` | `number` | `30000` | Interval between `system.session.heartbeat` events while a session is active. |
| `heartbeatEnabled` | `boolean` | `true` | Set `false` to disable session heartbeats entirely. |
| `onError` | `(err: Error) => void` | logs to `console.error` | Called on a non-retryable 4xx or after retries are exhausted. |
| `onSessionKilled` | `(sessionId, reason) => void` | unset | Fired when a batch response lists the active session in `killedSessionIds`. |

## Walk me through it

Step-by-step from install to a verified metered tool call: [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

This SDK **records** tool usage and reacts to a server kill signal — it does **not** pre-flight a quota check or block a call before it runs. Pre-flight quota gating lives in `@aforo/mcp-proxy` (the sidecar), not here. Delivery is best-effort with a 3-attempt exponential backoff; after that the batch is handed to `onError` and dropped. Heartbeats report uptime and (where the runtime exposes it) process heap — they are not an SLA monitor.

> Source note: `package.json` declares version `1.0.0` and the docs track that. The source carries an internal `SDK_VERSION = '1.1.0'` constant stamped into heartbeat metadata, and `recordToolInvocation` stamps `sdkVersion: '1.0.0'` in its own metadata — an internal inconsistency that is metadata-only and doesn't affect behavior. The authoritative package version is `1.0.0`.
