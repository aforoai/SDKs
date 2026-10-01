// stdio transport — newline-delimited JSON-RPC 2.0 on stdin/stdout.
//
// This is the transport Claude Desktop and every local-MCP-server use
// (server-filesystem, server-github, etc.). Aforo's mcp-proxy StdioProxy
// wraps a spawned child process and speaks this shape. Test setup: spawn
// this server as the child, have mcp-proxy be the parent.
//
// Line discipline:
//   - Client writes one JSON object per line to server stdin.
//   - Server writes one JSON object per line to stdout.
//   - Anything on stderr is diagnostic / non-protocol.
// Blank lines and lines that don't parse as JSON are ignored with a
// stderr WARN so a wrapping harness can see the desync.

import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { McpTestServer } from '../server.js';
import type { JsonRpcRequest } from '../types.js';

export interface StdioTransportOptions {
  server: McpTestServer;
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

    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcRequest;
    } catch (err) {
      errorOutput.write(
        `[stdio] WARN skipping non-JSON line: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }

    if (opts.verbose) {
      errorOutput.write(`[stdio] → ${trimmed}\n`);
    }

    const response = await opts.server.handle(parsed);
    if (response === null) return; // notification — no reply

    const body = JSON.stringify(response);
    output.write(body + '\n');
    if (opts.verbose) {
      errorOutput.write(`[stdio] ← ${body}\n`);
    }
  });

  return () => rl.close();
}
