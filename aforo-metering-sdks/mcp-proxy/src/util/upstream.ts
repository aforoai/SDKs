/**
 * @file Limits on what the proxy waits for and buffers from the upstream MCP
 * server when it forwards a client POST. Without them an upstream that never
 * answers holds the client's request open forever, and one that streams an
 * endless body grows the proxy's memory until it dies.
 */

/** Largest upstream answer to a POST the proxy reads into memory (16 MiB). */
export const UPSTREAM_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Default wait for the upstream's answer to a POST: the tool-call response timeout (5 minutes). */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 300_000;

/** The upstream's answer was larger than UPSTREAM_MAX_RESPONSE_BYTES. */
export class UpstreamResponseTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`upstream response is larger than ${limit} bytes`);
    this.name = 'UpstreamResponseTooLargeError';
  }
}

/** The upstream did not answer within the deadline. */
export class UpstreamTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`upstream did not answer within ${timeoutMs} ms`);
    this.name = 'UpstreamTimeoutError';
  }
}

/**
 * One deadline for a forwarded request: pass `signal` to fetch, read the body
 * before `done()`. The signal aborts with an UpstreamTimeoutError.
 */
export function upstreamDeadline(timeoutMs: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new UpstreamTimeoutError(timeoutMs)), timeoutMs);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/** Read a response body as UTF-8, refusing (and cancelling) one over `maxBytes`. */
export async function readCappedText(res: Response, maxBytes: number = UPSTREAM_MAX_RESPONSE_BYTES): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new UpstreamResponseTooLargeError(maxBytes);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new UpstreamResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
}

/** HTTP status and body the proxy answers its client with when the upstream forward failed. */
export function upstreamFailure(err: unknown, signal?: AbortSignal): { status: number; error: string } {
  const reason = signal?.aborted ? signal.reason : undefined;
  if (err instanceof UpstreamTimeoutError || reason instanceof UpstreamTimeoutError) {
    return { status: 504, error: 'Gateway Timeout: the MCP server did not answer in time' };
  }
  if (err instanceof UpstreamResponseTooLargeError) {
    return { status: 502, error: `Bad Gateway: the MCP server's answer is too large (over ${err.limit} bytes)` };
  }
  return { status: 502, error: 'Bad Gateway' };
}
