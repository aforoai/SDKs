/**
 * ws.send(data, options, cb): the metering wrapper must pass every argument
 * through. It used to accept (data, cb) only, so the caller's callback in the
 * third position was never called and send options landed in its place.
 */
import { EventEmitter } from 'events';
import { AforoWsBilling } from '../index';

global.fetch = jest.fn(async () => ({ ok: true, status: 202, headers: new Map(), text: async () => '' })) as any;

class RecordingWs extends EventEmitter {
  readyState = 1;
  calls: any[][] = [];
  send(...args: any[]) {
    this.calls.push(args);
    const cb = args.find((a) => typeof a === 'function');
    cb?.();
  }
}

const billing = () =>
  new AforoWsBilling({ tenantId: 't', productId: 'p', apiKey: 'k', ingestorUrl: 'https://ingest.example', flushIntervalMs: 1e9, flushOnExit: false } as any);

test('send(data, options, cb) reaches ws with options and the caller callback', async () => {
  const b = billing();
  const ws = new RecordingWs();
  b.trackConnection(ws as any, { customerId: 'c1' });
  const cb = jest.fn();
  const options = { binary: true, compress: false };
  (ws as any).send(Buffer.from('ab'), options, cb);
  expect(ws.calls[0][1]).toBe(options);
  expect(typeof ws.calls[0][2]).toBe('function');
  expect(cb).toHaveBeenCalledTimes(1);
  await b.shutdown();
});

test('send(data, cb) and send(data) keep working', async () => {
  const b = billing();
  const ws = new RecordingWs();
  b.trackConnection(ws as any, { customerId: 'c1' });
  const cb = jest.fn();
  (ws as any).send('x', cb);
  (ws as any).send('y');
  expect(ws.calls[0][0]).toBe('x');
  expect(ws.calls[1][0]).toBe('y');
  expect(ws.calls[0]).toHaveLength(2);
  expect(ws.calls[1]).toHaveLength(2);
  expect(cb).toHaveBeenCalledTimes(1);
  await b.shutdown();
});

class FailingWs extends EventEmitter {
  readyState = 3;
  send(...args: any[]) {
    const cb = args.find((a) => typeof a === 'function');
    cb?.(new Error('WebSocket is not open'));
  }
}

test('a frame the socket refuses is not billed; the caller still gets the error', async () => {
  const pushed: any[] = [];
  const b = billing();
  (b as any).perFrameEvents = true;
  const origPush = (b as any).push.bind(b);
  (b as any).push = (e: any, ...r: any[]) => { pushed.push(e); return origPush(e, ...r); };
  const ws = new FailingWs();
  b.trackConnection(ws as any, { customerId: 'c1' });
  const cb = jest.fn();
  (ws as any).send('lost', cb);
  expect(cb).toHaveBeenCalledWith(expect.any(Error));
  expect(pushed.filter((e) => e.wsDirection === 'SERVER_TO_CLIENT' && e.messageCount === 1 && e.wsFrameType === 'TEXT')).toHaveLength(0);
  ws.emit('close', 1000);
  const closed = pushed.find((e) => e.wsFrameType === 'CLOSE');
  expect(closed.messageCount).toBe(0);
  expect(closed.dataBytes).toBe(0);
  await b.shutdown();
});
