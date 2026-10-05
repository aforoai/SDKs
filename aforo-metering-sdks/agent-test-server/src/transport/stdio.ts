// stdio transport — newline-delimited JSON dispatch.
//
// Envelope (StdioRequest in types.ts): { id?, method, params? }.
// method is one of session.create | session.get | session.end | invoke.
// A request WITHOUT an id is a notification — the server processes it but
// writes nothing back on stdout (mirrors mcp-test-server's stdio semantics).
//
// Line discipline (matches mcp-test-server/stdio.ts):
//   - Client writes one JSON object per line to stdin.
//   - Server writes one JSON object per line to stdout.
//   - Anything on stderr is diagnostic / non-protocol.
// Blank lines and lines that don't parse as JSON are ignored with a stderr
// WARN so a wrapping harness can see the desync.

import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { AgentTestServer, type DispatchResult } from '../server.js';
import type { StdioRequest, StdioResponse } from '../types.js';

export interface StdioTransportOptions {
  server: AgentTestServer;
  input?: Readable;
  output?: Writable;
  errorOutput?: Writable;
  verbose?: boolean;
}

export function startStdio(opts: StdioTransportOptions): () => void {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const errorOutput = opts.errorOutput ?? process.stderr;

  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: StdioRequest;
    try {
      parsed = JSON.parse(trimmed) as StdioRequest;
    } catch (err) {
      errorOutput.write(
        `[stdio] WARN skipping non-JSON line: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }

    if (opts.verbose) errorOutput.write(`[stdio] → ${trimmed}\n`);

    const isNotification = parsed.id === undefined;
    const id = isNotification ? null : (parsed.id ?? null);

    const response = await dispatch(opts.server, parsed);

    if (isNotification) return; // no reply per JSON-RPC-style notification semantics

    const envelope: StdioResponse = { id };
    if (response.kind === 'ok') {
      envelope.result = response.value;
    } else {
      envelope.error = { code: response.code, message: response.message };
    }

    const body = JSON.stringify(envelope);
    output.write(body + '\n');
    if (opts.verbose) errorOutput.write(`[stdio] ← ${body}\n`);
  });

  return () => rl.close();
}

/**
 * Route a StdioRequest to the matching server method. Bad or missing
 * params surface as a 400-shaped DispatchResult so the wire response
 * carries the same code/message shape the HTTP transport uses.
 */
async function dispatch(
  server: AgentTestServer,
  req: StdioRequest,
): Promise<DispatchResult<unknown>> {
  const params = req.params ?? {};
  switch (req.method) {
    case 'session.create':
      return server.createSession({
        agentId: String(params.agentId ?? ''),
        tenantId: params.tenantId === undefined ? undefined : String(params.tenantId),
        metadata: (params.metadata ?? undefined) as Record<string, unknown> | undefined,
      });
    case 'session.get': {
      const id = String(params.sessionId ?? '');
      if (!id) return { kind: 'error', status: 400, code: 'missing_field', message: 'sessionId is required' };
      return server.getSession(id);
    }
    case 'session.end': {
      const id = String(params.sessionId ?? '');
      if (!id) return { kind: 'error', status: 400, code: 'missing_field', message: 'sessionId is required' };
      return server.endSession(id);
    }
    case 'invoke':
      return server.invoke({
        sessionId: String(params.sessionId ?? ''),
        capability: String(params.capability ?? ''),
        input: (params.input ?? {}) as Record<string, unknown>,
      });
    default:
      return {
        kind: 'error',
        status: 400,
        code: 'method_not_allowed',
        message: `unknown method: ${req.method}`,
      };
  }
}
