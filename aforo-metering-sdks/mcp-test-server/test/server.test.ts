import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpTestServer } from '../src/server.js';
import { listTools } from '../src/tools.js';

test('initialize returns protocol version + server info', async () => {
  const s = new McpTestServer();
  const r = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.ok(r && 'result' in r);
  const result = r.result as { protocolVersion: string; serverInfo: { name: string } };
  assert.equal(typeof result.protocolVersion, 'string');
  assert.match(result.serverInfo.name, /mcp-test-server/);
});

test('tools/list returns the 10 canonical tools with valid schemas', async () => {
  const s = new McpTestServer();
  const r = await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(r && 'result' in r);
  const result = r.result as { tools: { name: string; inputSchema: { type: string } }[] };
  assert.equal(result.tools.length, 10);
  for (const t of result.tools) {
    assert.equal(t.inputSchema.type, 'object');
  }
});

test('tools/call dispatches to the named tool', async () => {
  const s = new McpTestServer();
  const r = await s.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'search_web', arguments: { query: 'hello' } },
  });
  assert.ok(r && 'result' in r);
  const result = r.result as { content: { type: string; text?: string }[] };
  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text ?? '', /hello/);
});

test('tools/call with unknown tool returns MethodNotFound (-32601)', async () => {
  const s = new McpTestServer();
  const r = await s.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'nope', arguments: {} },
  });
  assert.ok(r && 'error' in r);
  assert.equal(r.error.code, -32601);
});

test('tools/call with missing params.name returns InvalidParams (-32602)', async () => {
  const s = new McpTestServer();
  const r = await s.handle({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {},
  });
  assert.ok(r && 'error' in r);
  assert.equal(r.error.code, -32602);
});

test('unknown method returns MethodNotFound (-32601)', async () => {
  const s = new McpTestServer();
  const r = await s.handle({ jsonrpc: '2.0', id: 6, method: 'does/not/exist' });
  assert.ok(r && 'error' in r);
  assert.equal(r.error.code, -32601);
});

test('notification (no id) returns null — server writes nothing back', async () => {
  const s = new McpTestServer();
  const r = await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(r, null);
});

test('malformed jsonrpc version returns InvalidRequest (-32600)', async () => {
  const s = new McpTestServer();
  // deliberately break the version — bypass the TS type
  const r = await s.handle({ jsonrpc: '1.0', id: 7, method: 'ping' } as unknown as {
    jsonrpc: '2.0'; id: number; method: string;
  });
  assert.ok(r && 'error' in r);
  assert.equal(r.error.code, -32600);
});

test('ping returns empty result', async () => {
  const s = new McpTestServer();
  const r = await s.handle({ jsonrpc: '2.0', id: 8, method: 'ping' });
  assert.ok(r && 'result' in r);
});

test('tools/list is stable across the 10-tool set', () => {
  const names = listTools().map((t) => t.name).sort();
  assert.deepEqual(names, [
    'classify',
    'create_record',
    'execute_query',
    'read_file',
    'search_web',
    'send_email',
    'summarize',
    'translate',
    'vector_search',
    'write_file',
  ]);
});
