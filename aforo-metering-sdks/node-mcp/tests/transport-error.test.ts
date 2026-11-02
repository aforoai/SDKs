/** onError receives the exported CoreTransportError, with kind and events. */
import { AforoMcpBilling, CoreTransportError } from '../src/index';

test('a refused batch reaches onError as CoreTransportError kind "rejected"', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 400, headers: { get: () => null }, text: async () => '{"detail":"bad"}' })) as any;
  const errors: Error[] = [];
  const b = new AforoMcpBilling({
    tenantId: 't', productId: 'p', apiKey: 'k', ingestorUrl: 'https://ingest.example', customerId: 'c1',
    flushOnExit: false, heartbeatEnabled: false, onError: (e: Error) => errors.push(e),
  });
  b.recordToolInvocation('search', 'agent_1', undefined, 'SUCCESS', 1);
  await b.flush();
  expect(errors[0]).toBeInstanceOf(CoreTransportError);
  expect(errors[0]).toMatchObject({ kind: 'rejected', status: 400 });
  expect((errors[0] as CoreTransportError<any>).events).toHaveLength(1);
  await b.shutdown();
});
