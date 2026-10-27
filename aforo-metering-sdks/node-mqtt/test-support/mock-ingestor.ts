/**
 * Starts the repo's fault-injecting mock ingestor (`mock-ingestor/`) as a
 * subprocess for integration tests. Kept per package: packages are published
 * independently, so test support is never shared across them.
 *
 * Talks to the mock with node:http directly (not global fetch), so a test that
 * replaces global.fetch does not break the control channel.
 */
import { spawn, ChildProcess } from 'child_process';
import { request } from 'http';
import * as path from 'path';

export interface MockFault {
  match?: 'ingest' | 'quota';
  times?: number;
  status?: number;
  retryAfter?: string;
  delayMs?: number;
  hang?: boolean;
  reset?: boolean;
  perEvent?: Array<{ index: number; message?: string; retryable?: boolean }>;
}

export interface MockRequest {
  status: number;
  eventCount: number;
  idempotencyKeys: Array<string | null>;
  contentEncoding: string | null;
  userAgent: string | null;
  apiKeyPresent: boolean;
}

export interface MockState {
  requests: MockRequest[];
  events: Array<Record<string, unknown>>;
  acceptedCount: number;
  uniqueKeys: number;
  duplicates: number;
  maxInFlight: number;
  inFlight: number;
  faultsRemaining: number;
}

export interface MockIngestor {
  url: string;
  faults(faults: MockFault[]): Promise<void>;
  clearFaults(): Promise<void>;
  state(): Promise<MockState>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

/** Path of the mock's entry point, found by walking up to the repo root. */
export function mockIngestorBin(fromDir: string): string {
  let dir = fromDir;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'mock-ingestor', 'bin', 'mock-ingestor.mjs');
    try {
      require('fs').accessSync(candidate);
      return candidate;
    } catch {
      dir = path.dirname(dir);
    }
  }
  throw new Error(`mock-ingestor not found above ${fromDir}`);
}

function call(base: string, method: string, pathName: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      base + pathName,
      { method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(text ? JSON.parse(text) : undefined);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

export async function startMockIngestor(fromDir: string = __dirname): Promise<MockIngestor> {
  const child: ChildProcess = spawn(process.execPath, [mockIngestorBin(fromDir), '--port', '0'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        child.stdout!.off('data', onData);
        try {
          resolve(JSON.parse(buf.slice(0, nl)).url);
        } catch (e) {
          reject(e);
        }
      }
    };
    child.stdout!.on('data', onData);
    child.once('exit', (code) => reject(new Error(`mock ingestor exited early (${code})`)));
  });
  return {
    url,
    faults: (faults) => call(url, 'POST', '/__control/faults', { faults }),
    clearFaults: () => call(url, 'DELETE', '/__control/faults'),
    state: () => call(url, 'GET', '/__control/state'),
    reset: () => call(url, 'POST', '/__control/reset'),
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

/** Poll `check` until it returns true; the deadline is a hang guard, not an assertion. */
export async function waitFor(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
