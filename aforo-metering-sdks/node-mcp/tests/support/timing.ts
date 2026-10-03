/**
 * Shared timing helpers for this package's Jest suites.
 *
 * Two families, both built on the same rule — wait for the CONDITION, never
 * for an amount of time:
 *
 *   1. Fake-timer helpers (`settleWithFakeTimers`, `drainFakeTimers`) for unit
 *      tests whose only real-time dependency is the SDK's retry backoff sleep.
 *      They fire pending fake timers one batch at a time and flush promise
 *      microtasks in between, until the awaited promise has actually settled.
 *      No real time passes, so machine load cannot change the outcome.
 *
 *   2. Real-I/O helpers (`waitFor`, `trackFetch`, `onceOrError`) for the
 *      integration suites that talk to real sockets. `waitFor` polls a
 *      condition; its deadline is a HANG GUARD derived from the test's own
 *      Jest timeout, not an assertion — a healthy run never gets near it.
 *
 * Lives under `tests/`, which `tsconfig.json` excludes from the published
 * `dist/` build — test support must not ship. Kept per-package (packages are
 * published independently — no cross-package imports).
 */

// ── Fake-timer helpers ────────────────────────────────────────────────

/** Hard cap on timer batches; a healthy 3-attempt flush needs 2. */
const MAX_TIMER_STEPS = 200;

/**
 * Flush the promise microtask queue.
 *
 * Deliberately a chain of native `await Promise.resolve()` hops: Jest's modern
 * fake timers replace `process.nextTick` and `queueMicrotask`, but never the
 * engine's own promise-job queue, so this keeps working while timers are faked.
 * `rounds` only has to exceed the deepest await chain between two timers in the
 * code under test (mocked fetch → status check → sleep is ~4 hops).
 */
export async function flushMicrotasks(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/**
 * Drive `promise` to completion under Jest fake timers and return its result.
 *
 * Loop: flush microtasks → if settled, stop → fire the timers that are pending
 * right now (the SDK's backoff sleep) → repeat. Returns exactly when the
 * promise settles, however many retries that takes.
 *
 * Throws a descriptive error after MAX_TIMER_STEPS instead of spinning: an
 * endless microtask loop would starve Jest's own test timeout, so a genuine
 * hang has to be turned into a failure here.
 */
export async function settleWithFakeTimers<T>(promise: Promise<T>, what: string): Promise<T> {
  let settled = false;
  const tracked = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (err) => {
      settled = true;
      throw err;
    },
  );
  // The caller receives `tracked` below; this only stops an "unhandled
  // rejection" firing while the loop is still running.
  tracked.catch(() => {});

  for (let step = 0; ; step++) {
    await flushMicrotasks();
    if (settled) break;
    if (step >= MAX_TIMER_STEPS) {
      throw new Error(
        `settleWithFakeTimers: ${what} did not settle after ${MAX_TIMER_STEPS} fake-timer steps ` +
          `(${jest.getTimerCount()} timer(s) still pending). It is waiting on something that is ` +
          `neither a promise microtask nor a fake timer — e.g. real I/O that was not mocked.`,
      );
    }
    jest.runOnlyPendingTimers();
  }
  return tracked;
}

/**
 * Run fake timers + microtasks until nothing is left in flight. Call from
 * afterEach BEFORE `jest.useRealTimers()` so a flush that a failed test left
 * mid-retry finishes inside its own test instead of leaking into the next one.
 * Every interval must already be cleared (shut the SDK instance down first).
 */
export async function drainFakeTimers(what: string): Promise<void> {
  for (let step = 0; ; step++) {
    await flushMicrotasks();
    if (jest.getTimerCount() === 0) return;
    if (step >= MAX_TIMER_STEPS) {
      throw new Error(
        `drainFakeTimers: ${what} still has ${jest.getTimerCount()} fake timer(s) pending after ` +
          `${MAX_TIMER_STEPS} steps — a repeating timer was not cleared (missing shutdown()?).`,
      );
    }
    jest.runOnlyPendingTimers();
  }
}

// ── Real-I/O helpers ──────────────────────────────────────────────────

/** Jest timeout for tests that drive real sockets. Purely a hang guard. */
export const INTEGRATION_TEST_TIMEOUT_MS = 30_000;

/**
 * `waitFor` gives up this long before Jest would, so a real hang fails with
 * the specific "what was I waiting for" message instead of Jest's generic
 * "Exceeded timeout of N ms for a test".
 */
export const HANG_GUARD_MS = INTEGRATION_TEST_TIMEOUT_MS - 5_000;

const POLL_INTERVAL_MS = 10;

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
 * Resolve on `event`, reject on 'error' — so a failed connect surfaces the
 * real error immediately instead of hanging until the test timeout.
 */
export function onceOrError(
  emitter: {
    once(event: string, listener: (...args: any[]) => void): unknown;
    removeListener(event: string, listener: (...args: any[]) => void): unknown;
  },
  event: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onEvent = () => {
      emitter.removeListener('error', onError);
      resolve();
    };
    const onError = (err: unknown) => {
      emitter.removeListener(event, onEvent);
      reject(err instanceof Error ? err : new Error(`'error' before '${event}': ${String(err)}`));
    };
    emitter.once(event, onEvent);
    emitter.once('error', onError);
  });
}

export interface FetchTracker {
  /** Number of `fetch` calls issued by the SDK that have not settled yet. */
  pending(): number;
  /** Put the original `fetch` back. */
  restore(): void;
}

/**
 * Count in-flight `fetch` calls. The SDK flushes fire-and-forget, so there is
 * no promise for the test to await; teardown uses this to wait until every
 * flush has landed BEFORE closing the capture ingestor. Otherwise a late flush
 * hits a closed port and retries on real timers after the test has finished.
 */
export function trackFetch(): FetchTracker {
  const original = globalThis.fetch;
  let pending = 0;
  const wrapped: typeof fetch = (...args) => {
    pending++;
    return original(...args).finally(() => {
      pending--;
    });
  };
  globalThis.fetch = wrapped;
  return {
    pending: () => pending,
    restore: () => {
      if (globalThis.fetch === wrapped) globalThis.fetch = original;
    },
  };
}

/**
 * Run every cleanup step even when earlier ones throw, then report all
 * failures together. Keeps one stuck resource from leaking the rest.
 */
export async function runCleanups(steps: Array<[name: string, run: () => unknown]>): Promise<void> {
  const failures: string[] = [];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`teardown failed:\n  ${failures.join('\n  ')}`);
  }
}
