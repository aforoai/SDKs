/**
 * @file Starts the repo's fault-injecting mock ingestor (../../mock-ingestor)
 * as a subprocess and wraps its control API. Tests wait on conditions, never
 * on fixed sleeps.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

// dist/test/support at run time → the repo root is four levels up.
const BIN = resolve(__dirname, '../../../../mock-ingestor/bin/mock-ingestor.mjs');

export interface MockState {
  requests: Array<{ path: string; status: number; eventCount: number; idempotencyKeys: string[]; apiKeyPresent: boolean }>;
  events: Array<Record<string, any>>;
  acceptedCount: number;
  quotaChecks: Array<Record<string, any>>;
  maxInFlight: number;
}

export interface MockIngestor {
  url: string;
  state(): Promise<MockState>;
  faults(faults: Array<Record<string, unknown>>): Promise<void>;
  quota(answer: Record<string, unknown>): Promise<void>;
  reset(): Promise<void>;
  /** Poll `/__control/state` until `predicate` holds (default 5 s). */
  waitFor(predicate: (s: MockState) => boolean, timeoutMs?: number): Promise<MockState>;
  close(): Promise<void>;
}

export async function startMockIngestor(): Promise<MockIngestor> {
  const child: ChildProcess = spawn(process.execPath, [BIN, '--port', '0'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const url = await new Promise<string>((resolveUrl, reject) => {
    const rl = createInterface({ input: child.stdout! });
    const timer = setTimeout(() => reject(new Error('mock ingestor did not start')), 10_000);
    rl.once('line', (line) => {
      clearTimeout(timer);
      try {
        resolveUrl(JSON.parse(line).url);
      } catch (err) {
        reject(err);
      }
    });
    child.once('exit', (code) => reject(new Error(`mock ingestor exited (${code})`)));
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  };

  const mock: MockIngestor = {
    url,
    state: () => call('GET', '/__control/state') as Promise<MockState>,
    faults: async (faults) => { await call('POST', '/__control/faults', { faults }); },
    quota: async (answer) => { await call('POST', '/__control/quota', answer); },
    reset: async () => { await call('POST', '/__control/reset'); },
    async waitFor(predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      let last: MockState = await mock.state();
      while (!predicate(last)) {
        if (Date.now() > deadline) {
          throw new Error(`condition not met within ${timeoutMs} ms; state: ${JSON.stringify({ events: last.events.length, quotaChecks: last.quotaChecks.length })}`);
        }
        await new Promise((r) => setTimeout(r, 20));
        last = await mock.state();
      }
      return last;
    },
    close: () => new Promise<void>((done) => {
      if (child.exitCode !== null) return done();
      child.once('exit', () => done());
      child.kill('SIGTERM');
    }),
  };
  return mock;
}

/** Poll `predicate` until true (default 5 s). */
export async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`${what} not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
