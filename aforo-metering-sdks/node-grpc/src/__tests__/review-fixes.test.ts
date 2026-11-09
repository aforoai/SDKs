/**
 * Regression test for the 2026-11-09 review (#3): wrapClientStream /
 * wrapBidiStream used to attach call.on('data') before the handler ran, which
 * put the request stream in flowing mode. A handler that awaited anything
 * before reading lost every message that arrived meanwhile. Real grpc-js.
 */
import * as grpc from '@grpc/grpc-js';
import { AforoGrpcBilling, GrpcUsageEvent } from '../index';
import { bodyJson } from '../../test-support/request-body';

const json = { s: (o: unknown) => Buffer.from(JSON.stringify(o)), d: (b: Buffer) => JSON.parse(b.toString()) };
const def = {
  Upload: { path: '/t.Svc/Upload', requestStream: true, responseStream: false,
    requestSerialize: json.s, requestDeserialize: json.d, responseSerialize: json.s, responseDeserialize: json.d },
  Chat: { path: '/t.Svc/Chat', requestStream: true, responseStream: true,
    requestSerialize: json.s, requestDeserialize: json.d, responseSerialize: json.s, responseDeserialize: json.d },
} as unknown as grpc.ServiceDefinition;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sent: GrpcUsageEvent[];
beforeEach(() => {
  sent = [];
  global.fetch = jest.fn(async (_u: any, init: any) => {
    const events = bodyJson(init).events as GrpcUsageEvent[];
    sent.push(...events);
    return new Response(JSON.stringify({ success: true, data: { accepted: events.length, failed: 0 } }), { status: 202 });
  }) as any;
});

async function serve(impl: grpc.UntypedServiceImplementation) {
  const server = new grpc.Server();
  server.addService(def, impl);
  const port = await new Promise<number>((res, rej) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  const Client = grpc.makeGenericClientConstructor(def as any, 'Svc');
  const client = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as any;
  return { server, client };
}

jest.setTimeout(30_000);

test('client-stream: a handler that awaits before reading still receives every message; the count is billed', async () => {
  const billing = new AforoGrpcBilling({ tenantId: 't', productId: 'p', apiKey: 'k', ingestorUrl: 'https://api.aforo.ai',
    serviceName: 't.Svc', customerResolver: () => 'cust_42', flushOnExit: false, flushIntervalMs: 60_000 });
  const { server, client } = await serve({
    Upload: billing.wrapClientStream('Upload', async (call: any) => {
      await sleep(100); // e.g. a database lookup before reading the upload
      let n = 0;
      for await (const _m of call) n++;
      return { received: n };
    }),
  });
  const reply = await new Promise<any>((res, rej) => {
    const call = client.Upload((err: Error | null, r: any) => (err ? rej(err) : res(r)));
    for (let i = 0; i < 3; i++) call.write({ chunk: i });
    call.end();
  });
  client.close();
  server.forceShutdown();
  await billing.shutdown();
  expect(reply.received).toBe(3);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ grpcMethod: 'Upload', grpcCallType: 'CLIENT_STREAM', messageCount: 3, grpcStatusCode: 'OK' });
});

test('bidi-stream: inbound messages are counted without starting the stream early', async () => {
  const billing = new AforoGrpcBilling({ tenantId: 't', productId: 'p', apiKey: 'k', ingestorUrl: 'https://api.aforo.ai',
    serviceName: 't.Svc', customerResolver: () => 'cust_42', flushOnExit: false, flushIntervalMs: 60_000 });
  const { server, client } = await serve({
    Chat: billing.wrapBidiStream('Chat', async (call: any) => {
      await sleep(100);
      // destroyOnReturn: false — a plain `for await (… of call)` destroys the duplex when the
      // client half-closes, and grpc-js then never sends the status (with or without this SDK).
      for await (const m of call.iterator({ destroyOnReturn: false })) call.write({ echo: m.text });
    }),
  });
  const replies = await new Promise<any[]>((res, rej) => {
    const got: any[] = [];
    const call = client.Chat();
    call.on('data', (m: any) => got.push(m));
    call.on('end', () => res(got));
    call.on('error', rej);
    for (const text of ['a', 'b']) call.write({ text });
    call.end();
  });
  client.close();
  server.forceShutdown();
  await billing.shutdown();
  expect(replies.map((r) => r.echo)).toEqual(['a', 'b']);
  expect(sent[0]).toMatchObject({ grpcMethod: 'Chat', grpcCallType: 'BIDI_STREAM', messageCount: 4 });
});
