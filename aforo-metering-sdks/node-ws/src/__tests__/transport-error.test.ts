/** onError receives the exported CoreTransportError, with kind and events. */
import { AforoWsBilling, CoreTransportError } from '../index';

test('a refused batch reaches onError as CoreTransportError kind "rejected"', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 400, headers: { get: () => null }, text: async () => '{"detail":"bad"}' })) as any;
  const errors: Error[] = [];
  const b = new AforoWsBilling({ tenantId: 't', productId: 'p', apiKey: 'k', ingestorUrl: 'https://ingest.example', flushIntervalMs: 1e9, flushOnExit: false, onError: (e: Error) => errors.push(e) } as any);
  b.trackConnection({ on: () => {}, send: () => {} } as any, { customerId: 'c1' });
  await b.flush();
  expect(errors[0]).toBeInstanceOf(CoreTransportError);
  expect(errors[0]).toMatchObject({ kind: 'rejected', status: 400, willRetry: false });
  expect((errors[0] as CoreTransportError<any>).events).toHaveLength(1);
  await b.shutdown();
});
