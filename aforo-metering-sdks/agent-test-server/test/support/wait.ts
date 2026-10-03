/**
 * Condition-based waiting for the transport tests.
 *
 * Tests wait for the thing they assert on — never for an amount of time. The
 * deadline here is only a hang guard: node:test has no default per-test
 * timeout, so without it a condition that never comes true would hang the run
 * instead of failing with a message that says what was being waited for.
 */

import type http from 'node:http';

export const HANG_GUARD_MS = 25_000;

const POLL_INTERVAL_MS = 5;

/**
 * Wait until `probe` returns a truthy value and return it.
 *
 * @param probe     evaluated repeatedly; any truthy return ends the wait
 * @param describe  what is being waited for + the state to print if it never
 *                  happens (evaluated lazily, only on failure)
 */
export async function waitFor<T>(
  probe: () => T | undefined | null | false | 0 | '',
  describe: () => string,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() - startedAt >= HANG_GUARD_MS) {
      throw new Error(`waitFor hang guard (${HANG_GUARD_MS}ms) hit while waiting for: ${describe()}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Close an http.Server AND every connection still attached to it. A plain
 * close() waits for open sockets; an SSE stream a failed test never closed
 * would keep the server — and the whole test process — alive.
 */
export function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}
