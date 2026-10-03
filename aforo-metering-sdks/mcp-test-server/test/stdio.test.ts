import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { McpTestServer } from '../src/server.js';
import { startStdio } from '../src/transport/stdio.js';
import { waitFor } from './support/wait.js';

async function readOneLine(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    const listener = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        stream.off('data', listener);
        resolve(buf.slice(0, nl));
      }
    };
    stream.on('data', listener);
  });
}

test('stdio transport handles one JSON-RPC line and writes one response line', async () => {
  const server = new McpTestServer();
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();

  startStdio({ server, input, output, errorOutput });

  const requestP = readOneLine(output);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');

  const line = await requestP;
  const parsed = JSON.parse(line);
  assert.equal(parsed.jsonrpc, '2.0');
  assert.equal(parsed.id, 1);
  assert.ok('result' in parsed);
});

test('stdio transport skips blank lines and non-JSON with stderr WARN', async () => {
  const server = new McpTestServer();
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();

  let stderr = '';
  errorOutput.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });

  startStdio({ server, input, output, errorOutput });

  const responseP = readOneLine(output);
  input.write('\n');                                      // blank — skipped
  input.write('this is not json\n');                      // non-JSON — WARN
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) + '\n');

  const line = await responseP;
  assert.match(line, /"id":7/);
  // stderr is a separate stream from stdout — wait for the WARN itself.
  await waitFor(
    () => /WARN skipping non-JSON/.test(stderr),
    () => `the non-JSON WARN on stderr; stderr so far: ${JSON.stringify(stderr)}`,
  );
  assert.match(stderr, /WARN skipping non-JSON/);
});

test('stdio notification (no id) — server writes NOTHING back', async () => {
  const server = new McpTestServer();
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();

  let stdout = '';
  output.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });

  startStdio({ server, input, output, errorOutput });

  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // "Nothing was written" cannot be proven by sleeping. Send a sentinel
  // request AFTER the notification: lines are handled in order, so once the
  // sentinel's reply is out, a reply to the notification would be too.
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 'sentinel', method: 'ping' }) + '\n');
  await waitFor(
    () => stdout.includes('"id":"sentinel"') && stdout.endsWith('\n'),
    () => `the sentinel reply on stdout; stdout so far: ${JSON.stringify(stdout)}`,
  );

  const lines = stdout.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1, `only the sentinel may be answered; got: ${JSON.stringify(lines)}`);
  assert.equal(JSON.parse(lines[0]).id, 'sentinel');
});
