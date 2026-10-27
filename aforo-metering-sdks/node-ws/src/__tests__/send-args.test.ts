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
  expect(ws.calls[0][2]).toBe(cb);
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
  expect(ws.calls[0]).toEqual(['x', cb]);
  expect(ws.calls[1]).toEqual(['y']);
  expect(cb).toHaveBeenCalledTimes(1);
  await b.shutdown();
});
