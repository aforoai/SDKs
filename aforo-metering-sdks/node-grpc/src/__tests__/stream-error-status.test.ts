/**
 * Regression test for the 2026-11-09 end-to-end run (F1): when a wrapped
 * server-stream or bidi handler failed, the wrapper destroyed the stream, so
 * grpc-js never sent the status and the client waited until its deadline
 * (forever without one). The client must now get the handler's status at once,
 * as it does without the SDK, and the call is still billed with that status.
 * Real grpc-js server and client.
 */
import * as grpc from '@grpc/grpc-js';
import { AforoGrpcBilling, GrpcUsageEvent } from '../index';
import { bodyJson } from '../../test-support/request-body';

const json = { s: (o: unknown) => Buffer.from(JSON.stringify(o)), d: (b: Buffer) => JSON.parse(b.toString()) };
const def = {
  Feed: { path: '/t.Svc/Feed', requestStream: false, responseStream: true,
    requestSerialize: json.s, requestDeserialize: json.d, responseSerialize: json.s, responseDeserialize: json.d },
  Chat: { path: '/t.Svc/Chat', requestStream: true, responseStream: true,
    requestSerialize: json.s, requestDeserialize: json.d, responseSerialize: json.s, responseDeserialize: json.d },
} as unknown as grpc.ServiceDefinition;

// The old bug made the client wait out its whole deadline (DEADLINE_EXCEEDED). The status must
// arrive well before it; the bound is loose so a loaded CI host does not flake.
const DEADLINE_MS = 10_000;
const PROMPT_MS = DEADLINE_MS / 2;
let sent: GrpcUsageEvent[];
beforeEach(() => {
  sent = [];
  global.fetch = jest.fn(async (_u: any, init: any) => {
    const events = bodyJson(init).events as GrpcUsageEvent[];
    sent.push(...events);
    return new Response(JSON.stringify({ success: true, data: { accepted: events.length, failed: 0 } }), { status: 202 });
  }) as any;
});
jest.setTimeout(30_000);

function newBilling() {
  return new AforoGrpcBilling({ tenantId: 't', productId: 'p', apiKey: 'k', ingestorUrl: 'https://api.aforo.ai',
    serviceName: 't.Svc', customerResolver: () => 'cust_42', flushOnExit: false, flushIntervalMs: 60_000 });
}

async function serve(impl: grpc.UntypedServiceImplementation) {
  const server = new grpc.Server();
  server.addService(def, impl);
  const port = await new Promise<number>((res, rej) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  const Client = grpc.makeGenericClientConstructor(def as any, 'Svc');
  const client = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as any;
  // Connect first, so the timings below measure the call, not channel setup.
  await new Promise<void>((res, rej) => client.waitForReady(Date.now() + DEADLINE_MS, (e: Error | undefined) => (e ? rej(e) : res())));
  return { server, client };
}

/** Status the client sees for a stream, and how long it took. */
function outcome(call: any): Promise<{ code: number; details: string; ms: number; received: number }> {
  const t0 = Date.now();
  let received = 0;
  return new Promise((resolve) => {
    call.on('data', () => { received++; });
    call.on('error', (e: any) => resolve({ code: e.code, details: e.details, ms: Date.now() - t0, received }));
    call.on('end', () => resolve({ code: 0, details: 'OK', ms: Date.now() - t0, received }));
  });
}

const unavailable = () => Object.assign(new Error('backend went away'), { code: grpc.status.UNAVAILABLE });

test('server-stream: a handler that fails mid-stream sends its status to the client at once and is billed with it', async () => {
  const billing = newBilling();
  const { server, client } = await serve({
    Feed: billing.wrapServerStream('Feed', async (call: any) => { call.write({ n: 1 }); throw unavailable(); }),
  });
  const got = await outcome(client.Feed({}, { deadline: Date.now() + DEADLINE_MS }));
  client.close();
  server.forceShutdown();
  await billing.shutdown();
  expect(got.code).toBe(grpc.status.UNAVAILABLE);
  expect(got.details).toBe('backend went away');
  expect(got.received).toBe(1);
  expect(got.ms).toBeLessThan(PROMPT_MS);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ grpcMethod: 'Feed', grpcCallType: 'SERVER_STREAM', grpcStatusCode: 'UNAVAILABLE', executionStatus: 'ERROR', messageCount: 1 });
});

test('bidi-stream: a handler that fails sends its status to the client at once and is billed with it', async () => {
  const billing = newBilling();
  const { server, client } = await serve({
    Chat: billing.wrapBidiStream('Chat', async (call: any) => {
      for await (const m of call.iterator({ destroyOnReturn: false })) {
        call.write({ echo: m.text });
        throw Object.assign(new Error('bad input'), { code: grpc.status.INVALID_ARGUMENT });
      }
    }),
  });
  const call = client.Chat({ deadline: Date.now() + DEADLINE_MS });
  const pending = outcome(call);
  call.write({ text: 'hi' });
  const got = await pending;
  client.close();
  server.forceShutdown();
  await billing.shutdown();
  expect(got.code).toBe(grpc.status.INVALID_ARGUMENT);
  expect(got.ms).toBeLessThan(PROMPT_MS);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ grpcMethod: 'Chat', grpcCallType: 'BIDI_STREAM', grpcStatusCode: 'INVALID_ARGUMENT', executionStatus: 'VALIDATION_FAILED', messageCount: 2 });
});

test('server-stream: an error without a numeric code reaches the client as UNKNOWN and is billed as UNKNOWN', async () => {
  const billing = newBilling();
  const { server, client } = await serve({
    Feed: billing.wrapServerStream('Feed', async () => { throw new Error('plain failure'); }),
  });
  const got = await outcome(client.Feed({}, { deadline: Date.now() + DEADLINE_MS }));
  client.close();
  server.forceShutdown();
  await billing.shutdown();
  expect(got.code).toBe(grpc.status.UNKNOWN);
  expect(got.ms).toBeLessThan(PROMPT_MS);
  expect(sent[0]).toMatchObject({ grpcStatusCode: 'UNKNOWN', executionStatus: 'ERROR', messageCount: 0 });
});
