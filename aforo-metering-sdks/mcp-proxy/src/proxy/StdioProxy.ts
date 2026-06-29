/**
 * @file stdio transport proxy.
 * Spawns the MCP server as a child process and bridges stdin/stdout.
 *
 * Client ──stdin──► Proxy ──stdin──► Server (child process)
 * Client ◄──stdout── Proxy ◄──stdout── Server (child process)
 * Server stderr → Proxy stderr (forwarded)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { parseStreamBuffer } from '../interceptor/MessageInterceptor.js';
import { logger } from '../util/logger.js';
import { BaseProxy } from './BaseProxy.js';

export class StdioProxy extends BaseProxy {
  private child: ChildProcess | null = null;
  private clientBuffer = '';
  private serverBuffer = '';
  private sessionId: string = '';

  async start(): Promise<void> {
    const { command, args, env } = this.config;
    if (!command) throw new Error('command is required for stdio transport');

    this.sessionId = this.sessionManager.getOrCreatePrimary();
    logger.info('Starting stdio proxy', { command, args, sessionId: this.sessionId });

    // Spawn the MCP server as a child process
    this.child = spawn(command, args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    if (!this.child.stdin || !this.child.stdout) {
      throw new Error('Failed to create pipes to child process');
    }

    // Forward child stderr to our stderr
    this.child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    // Client stdin → intercept → child stdin
    process.stdin.on('data', (chunk: Buffer) => {
      this.handleClientChunk(chunk);
    });

    // Child stdout → intercept → client stdout
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.handleServerChunk(chunk);
    });

    // Handle child exit
    this.child.on('exit', (code, signal) => {
      logger.info('Child process exited', { code, signal });
      this.gracefulShutdown(signal ?? `exit:${code}`);
    });

    this.child.on('error', (err) => {
      logger.error('Child process error', { error: err.message });
      this.gracefulShutdown('child-error');
    });

    // Handle parent stdin close (client disconnected)
    process.stdin.on('end', () => {
      logger.info('Client stdin closed');
      this.gracefulShutdown('stdin-end');
    });

    logger.info('stdio proxy started');
  }

  private handleClientChunk(chunk: Buffer): void {
    this.clientBuffer += chunk.toString('utf-8');
    const { messages, remaining } = parseStreamBuffer(this.clientBuffer);
    this.clientBuffer = remaining;

    for (const raw of messages) {
      // Process message (async quota check if needed)
      this.handleClientMessage(raw, this.sessionId).then(result => {
        if (result.forward) {
          this.child?.stdin?.write(raw + '\n');
        } else if (result.response) {
          // Quota denied — send error back to client
          process.stdout.write(result.response + '\n');
        }
      }).catch(err => {
        // Fail-open — forward even if processing fails
        logger.error('Client message processing error', { error: (err as Error).message });
        this.child?.stdin?.write(raw + '\n');
      });
    }
  }

  private handleServerChunk(chunk: Buffer): void {
    this.serverBuffer += chunk.toString('utf-8');
    const { messages, remaining } = parseStreamBuffer(this.serverBuffer);
    this.serverBuffer = remaining;

    for (const raw of messages) {
      // Always forward server messages to client
      process.stdout.write(raw + '\n');

      // Track for telemetry (side-channel, non-blocking)
      this.handleServerMessage(raw, this.sessionId);
    }
  }

  protected async cleanup(): Promise<void> {
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
      // Give child 2s to exit gracefully
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          if (this.child && !this.child.killed) {
            this.child.kill('SIGKILL');
          }
          resolve();
        }, 2000);

        this.child?.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}
