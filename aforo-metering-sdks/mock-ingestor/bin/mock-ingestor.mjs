#!/usr/bin/env node
// Starts the fault-injecting mock ingestor. Prints one JSON line on stdout,
// {"event":"listening","port":N,"url":"http://127.0.0.1:N"}, which test
// harnesses in every language read to learn the port. Exits on SIGTERM/SIGINT
// or when stdin closes (so a test runner that dies takes the mock with it).
import { startMockIngestor } from '../src/server.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const mock = await startMockIngestor({
  port: Number(arg('port', '0')),
  host: arg('host', '127.0.0.1'),
  apiKey: arg('api-key', undefined),
  contractPath: arg('contract', undefined),
});
process.stdout.write(JSON.stringify({ event: 'listening', port: mock.port, url: mock.url }) + '\n');

let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await mock.close();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
if (!process.argv.includes('--no-stdin-watch')) {
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
  process.stdin.resume();
}
