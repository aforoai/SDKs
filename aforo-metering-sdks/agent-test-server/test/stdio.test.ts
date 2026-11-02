import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { AgentTestServer } from '../src/server.js';
import { startStdio } from '../src/transport/stdio.js';
import type { StdioResponse } from '../src/types.js';

interface Driver {
  write: (obj: Record<string, unknown>) => void;
  waitFor: (n: number) => Promise<StdioResponse[]>;
  close: () => void;
}

function driveStdio(server: AgentTestServer): Driver {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const stop = startStdio({ server, input, output, errorOutput });

  const responses: StdioResponse[] = [];
  const waiters: Array<{ target: number; resolve: () => void }> = [];
  let buf = '';
  output.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length === 0) continue;
      try {
        responses.push(JSON.parse(line) as StdioResponse);
      } catch {
        // ignore lines that aren't JSON (banners, etc.)
      }
      for (const w of [...waiters]) {
        if (responses.length >= w.target) {
          w.resolve();
        }
      }
    }
  });

  return {
    write: (obj) => {
      input.write(JSON.stringify(obj) + '\n');
    },
    waitFor: (n) =>
      new Promise<StdioResponse[]>((resolve) => {
        if (responses.length >= n) {
          resolve(responses.slice(0, n));
          return;
        }
        waiters.push({
          target: n,
          resolve: () => resolve(responses.slice(0, n)),
        });
      }),
    close: () => {
      stop();
      input.end();
      output.end();
      errorOutput.end();
    },
  };
}

test('stdio session.create → invoke → session.end round-trip echoes ids', async () => {
  const server = new AgentTestServer();
  const drv = driveStdio(server);

  try {
    drv.write({ id: 1, method: 'session.create', params: { agentId: 'agt_stdio' } });
    const [createResp] = await drv.waitFor(1);
    assert.equal(createResp.id, 1);
    assert.ok(createResp.result);
    const sessionId = (createResp.result as { sessionId: string }).sessionId;
    assert.match(sessionId, /^sess_/);

    drv.write({
      id: 'req-2',
      method: 'invoke',
      params: {
        sessionId,
        capability: 'extract_entities',
        input: { text: 'The quick brown fox jumps over Alice.' },
      },
    });
    const responses = await drv.waitFor(2);
    const invResp = responses[1];
    assert.equal(invResp.id, 'req-2');
    assert.ok(invResp.result);
    const inv = invResp.result as { capability: string; executionStatus: string };
    assert.equal(inv.capability, 'extract_entities');
    assert.equal(inv.executionStatus, 'SUCCESS');

    drv.write({ id: 3, method: 'session.end', params: { sessionId } });
    const responses2 = await drv.waitFor(3);
    assert.equal(responses2[2].id, 3);
  } finally {
    drv.close();
    server.dispose();
  }
});

test('stdio notification (no id) produces no response line', async () => {
  const server = new AgentTestServer();
  const drv = driveStdio(server);

  try {
    // A well-formed request WITHOUT an id — server should still process it
    // (create the session) but write nothing back.
    drv.write({ method: 'session.create', params: { agentId: 'agt_notif' } });
    // Fire a second WITH an id so we have something to wait on — if the
    // first had produced output, waitFor(1) would return that first response
    // and the assertion would trip.
    drv.write({ id: 99, method: 'session.create', params: { agentId: 'agt_2' } });
    const [resp] = await drv.waitFor(1);
    assert.equal(resp.id, 99, 'first response line must be the id=99 request; notification produced no line');
  } finally {
    drv.close();
    server.dispose();
  }
});

test('stdio unknown method returns method_not_allowed error envelope', async () => {
  const server = new AgentTestServer();
  const drv = driveStdio(server);

  try {
    drv.write({ id: 7, method: 'bogus.method' });
    const [resp] = await drv.waitFor(1);
    assert.equal(resp.id, 7);
    assert.ok(resp.error);
    assert.equal(resp.error?.code, 'method_not_allowed');
  } finally {
    drv.close();
    server.dispose();
  }
});
