/**
 * @file Abstract base for all transport proxies.
 * Wires together: session manager, message interceptor, tool call tracker,
 * quota guard, event buffer, heartbeat emitter, listener guard (HTTP
 * transports) and the health file.
 * Handles graceful shutdown (SIGTERM/SIGINT with 3s final flush timeout).
 */

import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, Principal, ProxyConfig } from '../types.js';
import { IngestorClient } from '../telemetry/IngestorClient.js';
import { EventBuffer } from '../telemetry/EventBuffer.js';
import { HeartbeatEmitter } from '../telemetry/HeartbeatEmitter.js';
import { ToolCallTracker } from '../interceptor/ToolCallTracker.js';
import { QuotaGuard } from '../interceptor/QuotaGuard.js';
import { SessionManager } from '../session/SessionManager.js';
import {
  parseJsonRpc, extractToolCall, extractToolResponse,
  isRequest, isResponse, isMeteredMethod,
} from '../interceptor/MessageInterceptor.js';
import { ListenerGuard } from '../auth/ListenerGuard.js';
import { requireCustomerSource, requireStdioCustomerSource } from '../identity/customer.js';
import { HealthFile } from '../util/HealthFile.js';
import { checkBaseUrl as assertIngestorUrl } from '../transport-core/core.js';
import { logger, setLogLevel } from '../util/logger.js';

const SHUTDOWN_TIMEOUT_MS = 3000;
const METRIC_NAME = 'mcp_server.tool_invocations';

/** What to do with one message from the client. */
export interface ClientMessageResult {
  /** Send `raw` to the server. False when every call in it was refused. */
  forward: boolean;
  /** What to send: the message as received, or a batch without its refused calls. */
  raw: string;
  /**
   * Answer the proxy gives the client itself (refused calls): one JSON-RPC
   * response, or an array of them for a batch.
   */
  response?: string;
  /**
   * JSON-RPC ids of the `tools/call` requests in `raw` that are now waiting
   * for a response. When forwarding fails without a JSON-RPC answer, pass
   * them to {@link BaseProxy.forgetUnanswered} so nothing is billed for calls
   * the server never ran.
   */
  tracked: Array<string | number>;
}

export abstract class BaseProxy {
  protected readonly config: ProxyConfig;
  protected readonly sessionManager: SessionManager;
  protected readonly tracker: ToolCallTracker;
  protected readonly quota: QuotaGuard;
  protected readonly buffer: EventBuffer;
  protected readonly heartbeat: HeartbeatEmitter;
  /** Auth, Host and Origin checks; set for the HTTP transports only. */
  protected readonly guard: ListenerGuard | null;
  private readonly health: HealthFile | null;
  private shutdownInProgress = false;
  private stopped: Promise<void> | null = null;

  constructor(config: ProxyConfig) {
    this.config = config;

    if (config.aforo.debug) {
      setLogLevel('debug');
    }

    assertIngestorUrl(config.aforo.ingestorUrl, config.aforo.allowInsecureHttp === true);
    this.guard = config.transport === 'stdio' ? null : new ListenerGuard(config.listen);
    if (this.guard) requireCustomerSource({ ...config.aforo, tokensMapCustomers: this.guard.tokensMapCustomers });
    else requireStdioCustomerSource(config.aforo, config.listen);

    // Trimmed here as well as in loadConfig: a library caller builds ProxyConfig itself.
    const apiKey = String(config.aforo.apiKey ?? '').trim();
    if (!apiKey) throw new Error('aforo.apiKey is required');

    const client = new IngestorClient({
      baseUrl: config.aforo.ingestorUrl,
      apiKey,
      tenantId: config.aforo.tenantId,
      allowInsecureHttp: config.aforo.allowInsecureHttp,
    });

    this.buffer = new EventBuffer({
      baseUrl: config.aforo.ingestorUrl,
      apiKey,
      tenantId: config.aforo.tenantId,
      allowInsecureHttp: config.aforo.allowInsecureHttp,
      compression: config.aforo.compression,
      flushCount: config.aforo.flushCount,
      flushIntervalMs: config.aforo.flushIntervalMs,
      maxQueueSize: config.aforo.maxQueueSize,
      shutdownTimeoutMs: this.shutdownTimeoutMs(),
      onDrop: config.aforo.onDrop,
    });

    this.heartbeat = new HeartbeatEmitter({
      intervalMs: config.aforo.heartbeatIntervalMs ?? 30_000,
      client,
      tenantId: config.aforo.tenantId,
      productId: config.aforo.productId,
      transport: config.transport,
      customerId: config.aforo.customerId,
      productType: config.aforo.productType,
    });

    this.sessionManager = new SessionManager(config.transport);

    this.tracker = new ToolCallTracker({
      buffer: this.buffer,
      heartbeat: this.heartbeat,
      tenantId: config.aforo.tenantId,
      productId: config.aforo.productId,
      transport: config.transport,
      agentIdOverride: config.aforo.agentId,
      statusResolver: config.aforo.statusResolver,
      staleCallTimeoutMs: config.aforo.responseTimeoutMs,
      customerId: config.aforo.customerId,
      customerResolver: config.aforo.customerResolver,
      trustClientCustomerId: config.aforo.trustClientCustomerId,
      tokensMapCustomers: this.guard?.tokensMapCustomers === true,
      productType: config.aforo.productType,
    });

    this.quota = new QuotaGuard({
      ingestorUrl: config.aforo.ingestorUrl,
      tenantId: config.aforo.tenantId,
      apiKey,
      enabled: config.aforo.quotaEnforcement ?? false,
      timeoutMs: config.aforo.quotaTimeoutMs,
      allowCacheMs: config.aforo.quotaAllowCacheMs,
      failMode: config.aforo.quotaFailMode,
    });

    this.health = config.healthFile ? new HealthFile(config.healthFile) : null;

    if (config.handleSignals !== false) {
      process.once('SIGTERM', () => { void this.gracefulShutdown('SIGTERM'); });
      process.once('SIGINT', () => { void this.gracefulShutdown('SIGINT'); });
    }
  }

  abstract start(): Promise<void>;
  protected abstract cleanup(): Promise<void>;

  /** Called by a transport once it is serving: starts the health file. */
  protected markServing(): void {
    this.health?.start();
  }

  /**
   * Process a client-to-server message — a single JSON-RPC message or a batch.
   * Each `tools/call` in it is quota-checked (when enabled) and tracked; a
   * refused call is removed from what goes to the server and answered by the
   * proxy. Non-JSON-RPC data passes through untouched.
   */
  protected async handleClientMessage(raw: string, sessionId: string, principal?: Principal): Promise<ClientMessageResult> {
    const parsed = parseJsonRpc(raw);
    if (!parsed) return { forward: true, raw, tracked: [] };

    const tracked: Array<string | number> = [];
    const denials = await Promise.all(parsed.messages.map((msg) => this.admitRequest(msg, sessionId, principal, tracked)));
    const refused = denials.filter((d): d is JsonRpcResponse => d !== null);
    if (refused.length === 0) return { forward: true, raw, tracked };

    if (!parsed.batch) {
      return { forward: false, raw, response: JSON.stringify(refused[0]), tracked };
    }
    const remaining = parsed.messages.filter((_m, i) => denials[i] === null);
    return {
      forward: remaining.length > 0,
      raw: remaining.length > 0 ? JSON.stringify(remaining) : raw,
      response: JSON.stringify(refused),
      tracked,
    };
  }

  /**
   * Forwarding a client message produced no JSON-RPC answer for its calls (the
   * upstream was unreachable, timed out, or answered an HTTP error): forget
   * them, so a call the server never ran is not billed as TIMEOUT later.
   */
  protected forgetUnanswered(
    sessionId: string,
    tracked: ReadonlyArray<string | number>,
    answered: ReadonlyArray<string | number> = [],
  ): void {
    const left = [...tracked];
    for (const id of answered) {
      const index = left.findIndex((t) => t === id);
      if (index >= 0) left.splice(index, 1);
    }
    if (left.length > 0) this.tracker.forget(sessionId, left);
  }

  /** Quota-check and track one message. Returns the refusal, or null to forward it. */
  private async admitRequest(
    msg: JsonRpcMessage, sessionId: string, principal: Principal | undefined, tracked: Array<string | number>,
  ): Promise<JsonRpcResponse | null> {
    if (!isRequest(msg)) return null;
    if (msg.method === 'notifications/cancelled') {
      // The server sends no response for a cancelled request: meter it as CANCELLED now.
      const params = msg.params as { requestId?: unknown } | undefined;
      this.tracker.trackCancellation(params?.requestId, sessionId);
      return null;
    }
    if (!isMeteredMethod(msg.method)) return null;
    const toolCall = extractToolCall(msg as JsonRpcRequest);
    if (!toolCall) return null;

    const customerId = this.tracker.resolveCustomerId(toolCall, sessionId, principal);
    if (customerId) {
      const deny = await this.quota.check(customerId, METRIC_NAME, toolCall.requestId);
      if (deny) return deny;
    }
    // A call with no customer is not quota-checked; it runs and its event is dropped as `invalid`.
    this.tracker.trackRequest(toolCall, sessionId, principal, customerId);
    tracked.push(toolCall.requestId);
    return null;
  }

  /**
   * Process a server-to-client message (single or batch). Always forwarded by
   * the caller; telemetry is a side channel. Returns the ids of the tool
   * calls it metered.
   */
  protected handleServerMessage(raw: string, sessionId: string): Array<string | number> {
    const metered: Array<string | number> = [];
    const parsed = parseJsonRpc(raw);
    if (!parsed) return metered;
    for (const msg of parsed.messages) {
      if (!isResponse(msg)) continue;
      const bytes = parsed.batch ? Buffer.byteLength(JSON.stringify(msg), 'utf-8') : Buffer.byteLength(raw, 'utf-8');
      const toolResponse = extractToolResponse(msg, bytes);
      if (toolResponse && this.tracker.trackResponse(toolResponse, sessionId)) metered.push(toolResponse.requestId);
    }
    return metered;
  }

  /**
   * Stop serving, meter calls still waiting as CANCELLED, send SESSION_END and
   * flush, within 3 s. Does not exit the process. Safe to call twice.
   */
  stop(): Promise<void> {
    if (!this.stopped) this.stopped = this.doStop();
    return this.stopped;
  }

  private async doStop(): Promise<void> {
    this.health?.stop();
    // Stops heartbeats; the final SESSION_END is sent best-effort alongside the flush.
    const sessionEnd = this.heartbeat.stopSession();
    this.tracker.shutdown();
    try {
      await this.cleanup();
    } catch (err) {
      logger.error('Transport cleanup failed', { error: (err as Error).message });
    }
    // The buffer stops at its own deadline and reports what is left as 'shutdown';
    // the race only bounds a SESSION_END heartbeat that hangs.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([this.buffer.shutdown(), sessionEnd]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, this.shutdownTimeoutMs() + 500); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private shutdownTimeoutMs(): number {
    const configured = this.config.aforo.shutdownTimeoutMs;
    return configured !== undefined && configured >= 0 ? configured : SHUTDOWN_TIMEOUT_MS;
  }

  protected async gracefulShutdown(signal: string): Promise<void> {
    if (this.shutdownInProgress) return;
    this.shutdownInProgress = true;

    logger.info('Shutting down', { signal });

    try {
      await this.stop();
      logger.info('Shutdown complete');
    } catch (err) {
      logger.error('Shutdown error', { error: (err as Error).message });
    } finally {
      process.exit(0);
    }
  }
}
