#!/usr/bin/env node
// CLI entrypoint. Compiled to dist/bin/aforo-mcp-test-server.js and shipped
// as the "aforo-mcp-test-server" bin. Consumers:
//   - loadgen scenarios (docker-compose brings this up alongside kong)
//   - local dev / demos (`npm start:http`)
//   - nightly regression pipeline

import type { AddressInfo } from 'node:net';
import { Command } from 'commander';
import { McpTestServer } from '../src/server.js';
import { startHttp } from '../src/transport/http.js';
import { startStdio } from '../src/transport/stdio.js';
import { startSse } from '../src/transport/sse.js';

const program = new Command();

program
  .name('aforo-mcp-test-server')
  .description('Toy MCP server for testing Aforo MCP metering — HTTP + stdio + SSE transports')
  .version('0.1.0')
  .option('-t, --transport <mode>', 'transport: http | stdio | sse', 'http')
  .option('-p, --port <n>', 'port (http + sse only)', (v) => parseInt(v, 10), 8080)
  .option('-h, --host <host>', 'bind host (http + sse only)', '0.0.0.0')
  .option('--simulate-latency', 'sleep per-tool "typical" latency before responding', false)
  .option('-v, --verbose', 'log request/response envelopes to stderr', false)
  .parse(process.argv);

const opts = program.opts<{
  transport: string;
  port: number;
  host: string;
  simulateLatency: boolean;
  verbose: boolean;
}>();

const server = new McpTestServer({ simulateLatency: opts.simulateLatency });

async function main() {
  switch (opts.transport) {
    case 'http': {
      // startHttp resolves after 'listening' fires so the banner is
      // guaranteed truthful — no address()-returns-null race — and we can
      // read the OS-assigned port when the caller passed --port 0.
      const s = await startHttp({ port: opts.port, host: opts.host, server, verbose: opts.verbose });
      const addr = s.address() as AddressInfo;
      process.stderr.write(
        `[aforo-mcp-test-server] HTTP transport listening on http://${opts.host}:${addr.port}/mcp\n`,
      );
      break;
    }
    case 'sse': {
      const s = await startSse({ port: opts.port, host: opts.host, server, verbose: opts.verbose });
      const addr = s.address() as AddressInfo;
      process.stderr.write(
        `[aforo-mcp-test-server] SSE (Streamable HTTP) listening on http://${opts.host}:${addr.port}/mcp\n`,
      );
      break;
    }
    case 'stdio': {
      startStdio({ server, verbose: opts.verbose });
      // No banner on stdout — that channel is protocol-only.
      process.stderr.write('[aforo-mcp-test-server] stdio transport ready\n');
      break;
    }
    default:
      process.stderr.write(`unknown transport: ${opts.transport}\n`);
      process.exit(2);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[aforo-mcp-test-server] fatal: ${msg}\n`);
  process.exit(1);
});

const shutdown = (sig: NodeJS.Signals) => {
  process.stderr.write(`[aforo-mcp-test-server] ${sig} — shutting down\n`);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
