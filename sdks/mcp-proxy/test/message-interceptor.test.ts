/**
 * @file Unit tests for MessageInterceptor — JSON-RPC parsing, tool call detection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMessage, extractToolCall, extractToolResponse,
  isRequest, isResponse, isMeteredMethod, isTrackedMethod,
  parseStreamBuffer,
} from '../src/interceptor/MessageInterceptor.js';

describe('parseMessage', () => {
  it('parses a valid JSON-RPC request', () => {
    const raw = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search"}}';
    const msg = parseMessage(raw);
    assert.ok(msg);
    assert.equal((msg as any).method, 'tools/call');
  });

  it('parses a valid JSON-RPC response', () => {
    const raw = '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hi"}]}}';
    const msg = parseMessage(raw);
    assert.ok(msg);
    assert.ok('result' in msg);
  });

  it('parses a JSON-RPC error response', () => {
    const raw = '{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Invalid"}}';
    const msg = parseMessage(raw);
    assert.ok(msg);
    assert.ok('error' in msg);
  });

  it('returns null for non-JSON', () => {
    assert.equal(parseMessage('not json'), null);
  });

  it('returns null for non-JSON-RPC JSON', () => {
    assert.equal(parseMessage('{"foo":"bar"}'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseMessage(''), null);
  });
});

describe('extractToolCall', () => {
  it('extracts tool name and agent ID from tools/call', () => {
    const msg = {
      jsonrpc: '2.0' as const,
      id: 42,
      method: 'tools/call',
      params: {
        name: 'search_files',
        _meta: { agent_id: 'agent_001' },
      },
    };
    const result = extractToolCall(msg);
    assert.ok(result);
    assert.equal(result.requestId, 42);
    assert.equal(result.toolName, 'search_files');
    assert.equal(result.agentId, 'agent_001');
  });

  it('uses "unknown" for missing agent_id', () => {
    const msg = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: { name: 'read_file' },
    };
    const result = extractToolCall(msg);
    assert.ok(result);
    assert.equal(result.agentId, 'unknown');
  });

  it('uses "unknown" for missing tool name', () => {
    const msg = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: {},
    };
    const result = extractToolCall(msg);
    assert.ok(result);
    assert.equal(result.toolName, 'unknown');
  });

  it('returns null for non-tools/call method', () => {
    const msg = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'initialize',
      params: {},
    };
    assert.equal(extractToolCall(msg), null);
  });

  it('returns null for notification (no id)', () => {
    const msg = {
      jsonrpc: '2.0' as const,
      method: 'tools/call',
      params: { name: 'test' },
    };
    assert.equal(extractToolCall(msg), null);
  });
});

describe('extractToolResponse', () => {
  it('extracts response info for success', () => {
    const msg = { jsonrpc: '2.0' as const, id: 42, result: { content: [] } };
    const result = extractToolResponse(msg, 100);
    assert.ok(result);
    assert.equal(result.requestId, 42);
    assert.equal(result.hasError, false);
    assert.equal(result.responseBytes, 100);
  });

  it('detects error response', () => {
    const msg = { jsonrpc: '2.0' as const, id: 42, error: { code: -1, message: 'fail' } };
    const result = extractToolResponse(msg, 50);
    assert.ok(result);
    assert.equal(result.hasError, true);
  });

  it('returns null for notification response (no id)', () => {
    const msg = { jsonrpc: '2.0' as const, result: {} };
    assert.equal(extractToolResponse(msg, 0), null);
  });
});

describe('isRequest / isResponse', () => {
  it('identifies requests', () => {
    assert.ok(isRequest({ jsonrpc: '2.0', method: 'test' }));
    assert.ok(!isRequest({ jsonrpc: '2.0', id: 1, result: {} }));
  });

  it('identifies responses', () => {
    assert.ok(isResponse({ jsonrpc: '2.0', id: 1, result: {} }));
    assert.ok(isResponse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: '' } }));
    assert.ok(!isResponse({ jsonrpc: '2.0', method: 'test' }));
  });
});

describe('isMeteredMethod / isTrackedMethod', () => {
  it('tools/call is metered', () => {
    assert.ok(isMeteredMethod('tools/call'));
  });

  it('tools/list is tracked but not metered', () => {
    assert.ok(!isMeteredMethod('tools/list'));
    assert.ok(isTrackedMethod('tools/list'));
  });

  it('resources/read is tracked', () => {
    assert.ok(isTrackedMethod('resources/read'));
  });

  it('initialize is neither metered nor tracked', () => {
    assert.ok(!isMeteredMethod('initialize'));
    assert.ok(!isTrackedMethod('initialize'));
  });
});

describe('parseStreamBuffer', () => {
  it('parses complete JSON lines', () => {
    const buffer = '{"jsonrpc":"2.0","id":1,"method":"test"}\n{"jsonrpc":"2.0","id":2,"method":"test2"}\n';
    const { messages, remaining } = parseStreamBuffer(buffer);
    assert.equal(messages.length, 2);
    assert.equal(remaining, '');
  });

  it('keeps incomplete JSON as remaining', () => {
    const buffer = '{"jsonrpc":"2.0","id":1,"method":"test"}\n{"incomplete';
    const { messages, remaining } = parseStreamBuffer(buffer);
    assert.equal(messages.length, 1);
    assert.equal(remaining, '{"incomplete');
  });

  it('handles empty buffer', () => {
    const { messages, remaining } = parseStreamBuffer('');
    assert.equal(messages.length, 0);
    assert.equal(remaining, '');
  });

  it('handles single complete message without trailing newline', () => {
    const buffer = '{"jsonrpc":"2.0","id":1,"method":"test"}';
    const { messages, remaining } = parseStreamBuffer(buffer);
    assert.equal(messages.length, 1);
    assert.equal(remaining, '');
  });
});
