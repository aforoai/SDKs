/**
 * @file Child arguments on the CLI: repeatable `--arg <value>` (a value may
 * contain commas and spaces) next to the older comma-separated `--args`.
 * Precedence: `--arg` > `--args` > the config file's `args`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { collectArg, resolveChildArgs } from '../src/util/cliArgs.js';
import { startMockIngestor, waitUntil, type MockIngestor } from './support/mock-ingestor.js';

const CLI = resolve(__dirname, '../bin/aforo-mcp-proxy.js');

describe('resolveChildArgs', () => {
  it('collects repeated --arg values in order, commas and spaces kept', () => {
    let acc: string[] | undefined;
    for (const v of ['-y', 'a,b', 'c d', '']) acc = collectArg(v, acc);
    assert.deepEqual(resolveChildArgs({ arg: acc }), { args: ['-y', 'a,b', 'c d', ''] });
  });

  it('--args still splits on commas', () => {
    assert.deepEqual(resolveChildArgs({ args: '-y,@mcp/server-fs,/tmp' }), { args: ['-y', '@mcp/server-fs', '/tmp'] });
  });

  it('--arg wins over --args, with a warning', () => {
    const r = resolveChildArgs({ arg: ['x,y'], args: 'a,b' });
    assert.deepEqual(r.args, ['x,y']);
    assert.match(r.warning ?? '', /--arg.*--args/);
  });

  it('neither given: no args (the config file decides)', () => {
    assert.deepEqual(resolveChildArgs({}), { args: undefined });
  });
});

describe('--arg through the CLI', () => {
  let mock: MockIngestor;
  let child: string;
  before(async () => {
    mock = await startMockIngestor();
    const dir = mkdtempSync(join(tmpdir(), 'aforo-cli-args-'));
    child = join(dir, 'child.js');
    writeFileSync(child, `
      const rl = require('readline').createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        let msg; try { msg = JSON.parse(line); } catch { return; }
        if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { argv: process.argv.slice(2) } }) + '\\n');
      });
    `);
  });
  after(async () => { await mock.close(); });

  it('passes an argument that contains a comma to the child unchanged', async () => {
    const proc = spawn(process.execPath, [
      CLI, '--transport', 'stdio', '--command', process.execPath,
      '--arg', child, '--arg', 'select a,b from t', '--arg', '--flag=x,y',
      '--customer-id', 'cust_1',
    ], {
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
        AFORO_TENANT_ID: 't', AFORO_PRODUCT_ID: 'p', AFORO_API_KEY: 'sk_secret_key', AFORO_INGESTOR_URL: mock.url,
        AFORO_HEARTBEAT_INTERVAL_MS: '0',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines: string[] = [];
    createInterface({ input: proc.stdout! }).on('line', (l) => lines.push(l));
    try {
      proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
      await waitUntil(() => lines.length >= 1);
      assert.deepEqual(JSON.parse(lines[0]).result.argv, ['select a,b from t', '--flag=x,y']);
    } finally {
      await new Promise<void>((done) => {
        if (proc.exitCode !== null) return done();
        proc.once('exit', () => done());
        proc.kill('SIGTERM');
      });
    }
  });
});
