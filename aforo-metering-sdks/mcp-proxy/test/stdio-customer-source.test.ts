/**
 * @file stdio has no HTTP listener, so a bearer-token → customer map can never
 * apply to it. A stdio proxy configured with only a tokens file must fail at
 * startup with a message that says so, not start and drop every call as
 * invalid, and not point the user at the tokens file as the fix.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { StdioProxy } from '../src/proxy/StdioProxy.js';
import type { ProxyConfig } from '../src/types.js';

describe('stdio with only a tokens file as the customer source', () => {
  let dir: string;
  let tokens: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aforo-stdio-'));
    tokens = path.join(dir, 'tokens.json');
    fs.writeFileSync(tokens, JSON.stringify({ 'token-for-customer-a-0001': 'cust_a' }));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const expectStdioError = (fn: () => unknown) =>
    assert.throws(fn, (err: Error) => {
      assert.match(err.message, /stdio/);
      assert.match(err.message, /authTokensFile|tokens file/);
      assert.match(err.message, /customerId|customer-id/);
      return true;
    });

  it('loadConfig refuses it', () => {
    const saved = { ...process.env };
    try {
      process.env.AFORO_TENANT_ID = 't';
      process.env.AFORO_PRODUCT_ID = 'p';
      process.env.AFORO_API_KEY = 'k';
      process.env.AFORO_INGESTOR_URL = 'http://localhost:1';
      process.env.AFORO_PROXY_AUTH_TOKENS_FILE = tokens;
      delete process.env.AFORO_CUSTOMER_ID;
      delete process.env.AFORO_TRUST_CLIENT_CUSTOMER_ID;
      expectStdioError(() => loadConfig({ transport: 'stdio', command: 'node' } as never));
    } finally {
      process.env = saved;
    }
  });

  it('the StdioProxy constructor refuses it (library use)', () => {
    const config = {
      transport: 'stdio', command: 'node', handleSignals: false,
      listen: { port: 0, authTokensFile: tokens },
      aforo: { tenantId: 't', productId: 'p', apiKey: 'k', ingestorUrl: 'http://localhost:1' },
    } as ProxyConfig;
    expectStdioError(() => new StdioProxy(config));
  });

  it('a fixed customerId is still accepted alongside an unused tokens file', () => {
    const config = {
      transport: 'stdio', command: 'node', handleSignals: false,
      listen: { port: 0, authTokensFile: tokens },
      aforo: { tenantId: 't', productId: 'p', apiKey: 'k', ingestorUrl: 'http://localhost:1', customerId: 'cust_fixed' },
    } as ProxyConfig;
    assert.doesNotThrow(() => new StdioProxy(config));
  });
});
