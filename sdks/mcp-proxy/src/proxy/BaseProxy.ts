/**
 * @file Abstract base for all transport proxies.
 * Wires together: session manager, message interceptor, tool call tracker,
 * quota guard, event buffer, heartbeat emitter.
 * Handles graceful shutdown (SIGTERM/SIGINT with 3s final flush timeout).
 */

import type { ProxyConfig, JsonRpcMessage, JsonRpcRequest } from '../types.js';
import { IngestorClient } from '../telemetry/IngestorClient.js';
import { EventBuffer } from '../telemetry/EventBuffer.js';
import { HeartbeatEmitter } from '../telemetry/HeartbeatEmitter.js';
import { ToolCallTracker } from '../interceptor/ToolCallTracker.js';
import { QuotaGuard } from '../interceptor/QuotaGuard.js';
import { SessionManager } from '../session/SessionManager.js';
import {
  parseMessage, extractToolCall, extractToolResponse,
  isRequest, isResponse, isMeteredMethod,
} from '../interceptor/MessageInterceptor.js';
import { logger, setLogLevel } from '../util/logger.js';

const SHUTDOWN_TIMEOUT_MS = 3000;

export abstract class BaseProxy {
  protected readonly config: ProxyConfig;
  protected readonly sessionManager: SessionManager;
  protected readonly tracker: ToolCallTracker;
  protected readonly quota: QuotaGuard;
  protected readonly buffer: EventBuffer;
  protected readonly heartbeat: HeartbeatEmitter;
  private shutdownInProgress = false;

  constructor(config: ProxyConfig) {
    this.config = config;

    if (config.aforo.debug) {
      setLogLevel('debug');
    }

    const client = new IngestorClient({
      baseUrl: config.aforo.ingestorUrl,
      apiKey: config.aforo.apiKey,
      tenantId: config.aforo.tenantId,
    });

    this.buffer = new EventBuffer({
      flushCount: config.aforo.flushCount ?? 50,
      flushIntervalMs: config.aforo.flushIntervalMs ?? 5000,
      client,
    });

    this.heartbeat = new HeartbeatEmitter({
      intervalMs: config.aforo.heartbeatIntervalMs ?? 30_000,
      buffer: this.buffer,
      tenantId: config.aforo.tenantId,
      productId: config.aforo.productId,
      transport: config.transport,
    });

    this.sessionManager = new SessionManager(config.transport);

    this.tracker = new ToolCallTracker({
      buffer: this.buffer,
      heartbeat: this.heartbeat,
      tenantId: config.aforo.tenantId,
      productId: config.aforo.productId,
      transport: config.transport,
      agentIdOverride: config.aforo.agentId,
    });

    this.quota = new QuotaGuard({
      ingestorUrl: config.aforo.ingestorUrl,
      tenantId: config.aforo.tenantId,
      apiKey: config.aforo.apiKey,
      enabled: config.aforo.quotaEnforcement ?? false,
    });

    // Register shutdown handlers
    process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => this.gracefulShutdown('SIGINT'));
  }

  abstract start(): Promise<void>;
  protected abstract cleanup(): Promise<void>;

  /**
   * Process a client-to-server message. Returns:
   * - { forward: true, raw } — forward to server
   * - { forward: false, response } — send response back to client (quota denied)
   */
  protected async handleClientMessage(raw: string, sessionId: string): Promise<{
    forward: boolean;
    raw: string;
    response?: string;
  }> {
    const msg = parseMessage(raw);
    if (!msg || !isRequest(msg)) {
      return { forward: true, raw }; // Not JSON-RPC or not a request — pass through
    }

    const request = msg as JsonRpcRequest;

    // Check if this is a metered method (tools/call)
    if (isMeteredMethod(request.method)) {
      const toolCall = extractToolCall(request);
      if (toolCall) {
        // Quota check (if enabled)
        const denyResponse = await this.quota.check(
          this.config.aforo.agentId ?? toolCall.agentId,
          'mcp_server.tool_invocations',
          toolCall.requestId,
        );

        if (denyResponse) {
          // Quota exceeded — return error to client, don't forward
          return {
            forward: false,
            raw,
            response: JSON.stringify(denyResponse),
          };
        }

        // Track the request (start timer)
        this.tracker.trackRequest(toolCall, sessionId);
      }
    }

    return { forward: true, raw };
  }

  /**
   * Process a server-to-client message. Always forwarded (telemetry is side-channel).
   */
  protected handleServerMessage(raw: string, sessionId: string): void {
    const msg = parseMessage(raw);
    if (!msg || !isResponse(msg)) return;

    const toolResponse = extractToolResponse(msg, Buffer.byteLength(raw, 'utf-8'));
    if (toolResponse) {
      this.tracker.trackResponse(toolResponse, sessionId);
    }
  }

  protected async gracefulShutdown(signal: string): Promise<void> {
    if (this.shutdownInProgress) return;
    this.shutdownInProgress = true;

    logger.info('Shutting down', { signal });

    try {
      await this.heartbeat.stopSession();
      this.tracker.shutdown();
      await this.cleanup();

      // Final flush with timeout
      await Promise.race([
        this.buffer.shutdown(),
        new Promise(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ]);

      logger.info('Shutdown complete');
    } catch (err) {
      logger.error('Shutdown error', { error: (err as Error).message });
    } finally {
      process.exit(0);
    }
  }
}
