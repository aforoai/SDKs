import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startMockIngestor, loadContract } from '../src/server.mjs';

let mock;
before(async () => {
  mock = await startMockIngestor({});
});
after(async () => {
  await mock.close();
});
beforeEach(async () => {
  await fetch(`${mock.url}/__control/reset`, { method: 'POST' });
});

const event = (i, over = {}) => ({
  customerId: 'cust_1',
  metricName: 'api_calls',
  quantity: 1,
  occurredAt: '2026-10-26T10:00:00Z',
  idempotencyKey: `k-${i}`,
  ...over,
});

function post(events, headers = {}, body) {
  return fetch(`${mock.url}/v1/ingest/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'ak', ...headers },
    body: body ?? JSON.stringify({ events }),
  });
}
const faults = (list) =>
  fetch(`${mock.url}/__control/faults`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ faults: list }) });
const state = async () => (await fetch(`${mock.url}/__control/state`)).json();

test('accepts a valid batch, wraps the 202 body and records the events', async () => {
  const res = await post([event(1), event(2)]);
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.deepEqual(body.data, { accepted: 2, duplicates: 0, failed: 0, errors: [], killedSessionIds: [] });
  const s = await state();
  assert.equal(s.acceptedCount, 2);
  assert.equal(s.requests[0].eventCount, 2);
});

test('deduplicates on idempotencyKey per API key', async () => {
  await post([event(1)]);
  const body = await (await post([event(1), event(2)])).json();
  assert.equal(body.data.duplicates, 1);
  assert.equal(body.data.accepted, 1);
  assert.equal((await state()).uniqueKeys, 2);
});

test('rejects a missing X-API-Key with 401', async () => {
  const res = await fetch(`${mock.url}/v1/ingest/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [event(1)] }),
  });
  assert.equal(res.status, 401);
});

test('per-event validation follows the contract schema (UTF-16 lengths, required fields)', async () => {
  const tooLong = 'x'.repeat(65);
  const body = await (await post([event(1, { customerId: tooLong }), event(2, { metricName: '' }), event(3)])).json();
  assert.equal(body.data.accepted, 1);
  assert.equal(body.data.failed, 2);
  assert.deepEqual(body.data.errors.map((e) => e.index), [0, 1]);
  assert.ok(body.data.errors.every((e) => e.retryable === false));
});

test('batch over maxEvents is 400; Content-Encoding is refused like the real ingestor', async () => {
  const { maxEvents } = loadContract();
  const big = Array.from({ length: maxEvents + 1 }, (_, i) => event(i));
  assert.equal((await post(big)).status, 400);
  assert.equal((await post([event(1)], { 'Content-Encoding': 'gzip' })).status, 400);
});

test('scripted outage: N failures with Retry-After, then recovery', async () => {
  await faults([{ status: 503, retryAfter: '2', times: 2 }]);
  const r1 = await post([event(1)]);
  assert.equal(r1.status, 503);
  assert.equal(r1.headers.get('retry-after'), '2');
  assert.equal((await post([event(1)])).status, 503);
  assert.equal((await post([event(1)])).status, 202);
  const s = await state();
  assert.equal(s.acceptedCount, 1);
  // Faulted attempts record the keys they carried, so retries can be compared.
  assert.deepEqual(s.requests.map((r) => r.idempotencyKeys), [['k-1'], ['k-1'], ['k-1']]);
  assert.deepEqual(s.requests.map((r) => r.status), [503, 503, 202]);
});

test('HTTP-date Retry-After is passed through verbatim', async () => {
  const date = new Date(Date.now() + 3000).toUTCString();
  await faults([{ status: 429, retryAfter: date }]);
  const res = await post([event(1)]);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), date);
});

test('times:-1 keeps failing until the faults are cleared', async () => {
  await faults([{ status: 500, times: -1 }]);
  for (let i = 0; i < 3; i++) assert.equal((await post([event(1)])).status, 500);
  await fetch(`${mock.url}/__control/faults`, { method: 'DELETE' });
  assert.equal((await post([event(1)])).status, 202);
});

test('per-event retryable failure in a 2xx', async () => {
  await faults([{ perEvent: [{ index: 1, retryable: true, message: 'could not store' }] }]);
  const body = await (await post([event(1), event(2)])).json();
  assert.deepEqual(body.data.errors, [{ index: 1, message: 'could not store', retryable: true }]);
  assert.equal(body.data.accepted, 1);
});

test('killedSessionIds can be scripted on a 202', async () => {
  await faults([{ killedSessionIds: ['s1', 's2'] }]);
  const body = await (await post([event(1)])).json();
  assert.deepEqual(body.data.killedSessionIds, ['s1', 's2']);
  assert.deepEqual((await (await post([event(2)])).json()).data.killedSessionIds, []);
});

test('delay, hang and reset faults', async () => {
  await faults([{ delayMs: 150 }]);
  const t0 = Date.now();
  assert.equal((await post([event(1)])).status, 202);
  assert.ok(Date.now() - t0 >= 140);

  // A hang never answers: the client's own timeout has to fire.
  await faults([{ hang: true }]);
  await assert.rejects(
    fetch(`${mock.url}/v1/ingest/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'ak' },
      body: JSON.stringify({ events: [event(3)] }),
      signal: AbortSignal.timeout(200),
    }),
  );

  // The hung request counted as in flight until the client aborted it.
  const afterHang = await state();
  assert.equal(afterHang.maxInFlight >= 1, true);

  await faults([{ hang: true }]);
  const controller = new AbortController();
  const pending = fetch(`${mock.url}/v1/ingest/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'ak' },
    body: JSON.stringify({ events: [event(5)] }),
    signal: controller.signal,
  }).catch(() => {});
  for (let i = 0; i < 50 && (await state()).inFlight === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await state()).inFlight, 1, 'a hung request is in flight');
  controller.abort();
  await pending;
  for (let i = 0; i < 50 && (await state()).inFlight !== 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await state()).inFlight, 0, 'released when the client gives up');

  await faults([{ reset: true }]);
  await assert.rejects(post([event(4)]));
});

test('redirect, stalled-body and dripped-body faults', async () => {
  await faults([{ status: 307, location: 'https://elsewhere.example/steal' }]);
  const r = await fetch(`${mock.url}/v1/ingest/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'ak' },
    body: JSON.stringify({ events: [event(1)] }),
    redirect: 'manual',
  });
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), 'https://elsewhere.example/steal');

  await faults([{ stallBody: true }]);
  const stalled = await post([event(2)]);
  assert.equal(stalled.status, 202);
  await assert.rejects(Promise.race([stalled.text(), new Promise((_, rej) => setTimeout(() => rej(new Error('stalled')), 300))]));

  await faults([{ dripMs: 5 }]);
  const dripped = await post([event(3)]);
  const body = JSON.parse(await dripped.text());
  assert.equal(body.success, true);
  assert.equal((await state()).requests.at(-1).status, -3);
});

test('maxInFlight records concurrent ingest requests', async () => {
  await faults([{ delayMs: 100, times: 3 }]);
  await Promise.all([post([event(1)]), post([event(2)]), post([event(3)])]);
  assert.equal((await state()).maxInFlight, 3);
});

test('quota decisions are scriptable', async () => {
  await fetch(`${mock.url}/__control/quota`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'DENY', reason: 'over limit', retryAfterMs: 60000 }),
  });
  const res = await fetch(`${mock.url}/api/v1/quota/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'ak' },
    body: JSON.stringify({ customerId: 'c' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.decision, 'DENY');
  assert.equal((await state()).quotaChecks.length, 1);
});

test('CLI prints the listening line and exits on SIGTERM', async () => {
  const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/mock-ingestor.mjs');
  const child = spawn(process.execPath, [bin, '--port', '0'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const line = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) resolve(buf.slice(0, nl));
    });
    child.on('error', reject);
  });
  const info = JSON.parse(line);
  assert.equal(info.event, 'listening');
  assert.ok(info.port > 0);
  const health = await fetch(`${info.url}/__control/health`);
  assert.equal(health.status, 200);
  const exited = new Promise((r) => child.on('exit', r));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});
