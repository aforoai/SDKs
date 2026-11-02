/** onError receives the exported CoreTransportError, with kind and events. */
import { AforoGrpcBilling, CoreTransportError } from '../index';

test('a refused batch reaches onError as CoreTransportError kind "rejected"', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 400, headers: { get: () => null }, text: async () => '{"detail":"bad"}' })) as any;
  const errors: Error[] = [];
  const b = new AforoGrpcBilling({
    tenantId: 't', productId: 'p', apiKey: 'k', ingestorUrl: 'https://ingest.example', serviceName: 'acme.v1.S',
    flushIntervalMs: 1e9, flushOnExit: false, customerResolver: () => 'c1', onError: (e: Error) => errors.push(e),
  } as any);
  const wrapped = b.wrapUnary('M', async () => ({}));
  await new Promise<void>((resolve) => wrapped({ metadata: { getMap: () => ({}) } } as any, () => resolve()));
  await b.flush();
  expect(errors[0]).toBeInstanceOf(CoreTransportError);
  expect(errors[0]).toMatchObject({ kind: 'rejected', status: 400 });
  expect((errors[0] as CoreTransportError<any>).events).toHaveLength(1);
  await b.shutdown();
});
