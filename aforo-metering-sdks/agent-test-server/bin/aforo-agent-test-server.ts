#!/usr/bin/env node
// CLI entrypoint. Compiled to dist/bin/aforo-agent-test-server.js and shipped
// as the "aforo-agent-test-server" bin. Consumers:
//   - loadgen scenarios (docker-compose brings this up alongside a gateway)
//   - local dev / demos (`npm start:http`)
//   - nightly regression pipeline

import type { AddressInfo } from 'node:net';
import { Command } from 'commander';
import { AgentTestServer } from '../src/server.js';
import { startHttp } from '../src/transport/http.js';
import { startStdio } from '../src/transport/stdio.js';
import { startSse } from '../src/transport/sse.js';

const program = new Command();

program
  .name('aforo-agent-test-server')
  .description('Toy AI_AGENT test server for testing Aforo agent metering — HTTP + stdio + SSE transports')
  .version('0.1.0')
  .option('-t, --transport <mode>', 'transport: http | stdio | sse', 'http')
  .option('-p, --port <n>', 'port (http + sse only)', (v) => parseInt(v, 10), 8090)
  .option('-h, --host <host>', 'bind host (http + sse only)', '0.0.0.0')
  .option('--simulate-latency', 'sleep per-capability simulated latency before responding', false)
  .option('-v, --verbose', 'log request/response envelopes to stderr', false)
  .parse(process.argv);

const opts = program.opts<{
  transport: string;
  port: number;
  host: string;
  simulateLatency: boolean;
  verbose: boolean;
}>();

const server = new AgentTestServer({ simulateLatency: opts.simulateLatency });

async function main() {
  switch (opts.transport) {
    case 'http': {
      const s = await startHttp({ port: opts.port, host: opts.host, server, verbose: opts.verbose });
      const addr = s.address() as AddressInfo;
      process.stderr.write(
        `[aforo-agent-test-server] HTTP transport listening on http://${opts.host}:${addr.port}\n`,
      );
      process.stderr.write(
        `[aforo-agent-test-server]   POST   /agent/session    → create a session\n`,
      );
      process.stderr.write(
        `[aforo-agent-test-server]   POST   /agent/invoke     → invoke a capability\n`,
      );
      process.stderr.write(
        `[aforo-agent-test-server]   GET    /health           → health check\n`,
      );
      break;
    }
    case 'sse': {
      const s = await startSse({ port: opts.port, host: opts.host, server, verbose: opts.verbose });
      const addr = s.address() as AddressInfo;
      process.stderr.write(
        `[aforo-agent-test-server] SSE transport listening on http://${opts.host}:${addr.port}\n`,
      );
      process.stderr.write(
        `[aforo-agent-test-server]   GET    /agent/stream/{id} → subscribe to session invocations\n`,
      );
      break;
    }
    case 'stdio': {
      startStdio({ server, verbose: opts.verbose });
      // No banner on stdout — that channel is protocol-only.
      process.stderr.write('[aforo-agent-test-server] stdio transport ready\n');
      break;
    }
    default:
      process.stderr.write(`unknown transport: ${opts.transport}\n`);
      process.exit(2);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[aforo-agent-test-server] fatal: ${msg}\n`);
  process.exit(1);
});

const shutdown = (sig: NodeJS.Signals) => {
  process.stderr.write(`[aforo-agent-test-server] ${sig} — shutting down\n`);
  server.dispose();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
