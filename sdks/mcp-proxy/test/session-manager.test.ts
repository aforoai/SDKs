/**
 * @file Unit tests for SessionManager.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/session/SessionManager.js';

describe('SessionManager', () => {
  it('creates a primary session for stdio', () => {
    const mgr = new SessionManager('stdio');
    const id = mgr.getOrCreatePrimary();
    assert.ok(id.startsWith('proxy:stdio:'));

    // Same session returned on subsequent calls
    const id2 = mgr.getOrCreatePrimary();
    assert.equal(id, id2);
  });

  it('creates unique sessions for SSE connections', () => {
    const mgr = new SessionManager('sse');
    const id1 = mgr.getOrCreate();
    const id2 = mgr.getOrCreate();

    assert.ok(id1.startsWith('proxy:sse:'));
    assert.ok(id2.startsWith('proxy:sse:'));
    assert.notEqual(id1, id2);
  });

  it('reuses session by external ID', () => {
    const mgr = new SessionManager('streamable-http');
    const id = mgr.getOrCreate('external-session-123');
    const id2 = mgr.getOrCreate('external-session-123');

    assert.equal(id, 'external-session-123');
    assert.equal(id2, 'external-session-123');
  });

  it('ends a session', () => {
    const mgr = new SessionManager('stdio');
    const id = mgr.getOrCreatePrimary();

    mgr.endSession(id);

    // After ending, getOrCreatePrimary creates a new session
    const newId = mgr.getOrCreatePrimary();
    assert.notEqual(id, newId);
  });
});
