/**
 * @aforo/grpc-metering — Aforo gRPC Metering SDK
 *
 * Wraps gRPC server handlers (unary, server-stream, client-stream, bidi-stream)
 * to automatically meter per-method invocations and forward billing events to
 * Aforo's usage ingestor. Works with @grpc/grpc-js.
 *
 * Usage (unary handler):
 *   import { AforoGrpcBilling } from '@aforo/grpc-metering';
 *
 *   const billing = new AforoGrpcBilling({
 *     tenantId: 'tenant_acme',
 *     productId: 'prod_grpc_001',
 *     apiKey: process.env.AFORO_API_KEY!,
 *     ingestorUrl: 'https://ingestor.aforo.ai',
 *     serviceName: 'acme.v1.UserService',
 *   });
 *
 *   const server = new grpc.Server();
 *   server.addService(UserServiceSvc, {
 *     getUser: billing.wrapUnary('GetUser', async (call) => {
 *       // business logic
 *       return { id: call.request.id, name: '...' };
 *     }),
 *   });
 */

import type {
  ServerUnaryCall,
  ServerWritableStream,
  ServerReadableStream,
  ServerDuplexStream,
  sendUnaryData,
  status as GrpcStatusNs,
} from '@grpc/grpc-js';

export interface AforoGrpcConfig {
  tenantId: string;
  productId: string;
  apiKey: string;
  ingestorUrl: string;
  /** Fully-qualified gRPC service name (e.g., acme.v1.UserService). Overridable per-call. */
  serviceName: string;
  /**
   * Extract Aforo customer ID from the gRPC call metadata. Default:
   * reads `x-customer-id` from {@code call.metadata.getMap()}.
   *
   * <p>Param type is intentionally `Record<string, unknown>` — gRPC's
   * {@code Metadata.getMap()} actually returns `MetadataValue = string | Buffer`
   * per-key, so consumers need to string-coerce their keys themselves.</p>
   */
  customerIdExtractor?: (metadata: Record<string, unknown>) => string | undefined;
  /** How many events to buffer before flushing (default 50). */
  flushCount?: number;
  /** Max interval in ms before a partial batch is flushed (default 5000). */
  flushIntervalMs?: number;
  /** Callback invoked when an ingestion flush fails terminally. */
  onError?: (error: Error) => void;
}

const SDK_VERSION = '1.0.0';

// Mapping from gRPC status codes (numeric) to descriptor enum labels
const GRPC_STATUS_LABELS: Record<number, string> = {
  0: 'OK',
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
};

interface GrpcUsageEvent {
  customerId: string;
  metricName: string;
  quantity: number;
  occurredAt: string;
  idempotencyKey: string;
  productType: 'GRPC_API';
  grpcService: string;
  grpcMethod: string;
  grpcStatusCode: string;
  grpcCallType: 'UNARY' | 'CLIENT_STREAM' | 'SERVER_STREAM' | 'BIDI_STREAM';
  messageCount: number;
  dataBytes?: number;
  executionDurationMs: number;
  metadata?: Record<string, unknown>;
}

export class AforoGrpcBilling {
  private readonly config: Required<
    Pick<AforoGrpcConfig, 'tenantId' | 'productId' | 'apiKey' | 'ingestorUrl' | 'serviceName'>
  >;
  private readonly flushCount: number;
  private readonly flushIntervalMs: number;
  private readonly onError: (error: Error) => void;
  private readonly customerIdExtractor: (metadata: Record<string, unknown>) => string | undefined;

  private buffer: GrpcUsageEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AforoGrpcConfig) {
    this.config = {
      tenantId: config.tenantId,
      productId: config.productId,
      apiKey: config.apiKey,
      ingestorUrl: config.ingestorUrl,
      serviceName: config.serviceName,
    };
    this.flushCount = config.flushCount ?? 50;
    this.flushIntervalMs = config.flushIntervalMs ?? 5000;
    this.onError = config.onError ?? ((err) => console.error('[aforo-grpc]', err.message));
    this.customerIdExtractor =
      config.customerIdExtractor ??
      ((md) => {
        const v = md['x-customer-id'];
        if (typeof v === 'string') return v;
        if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
        if (v && typeof (v as any).toString === 'function') return String(v);
        return undefined;
      });
    this.startTimer();
  }

  // ── Handler wrappers ──────────────────────────────────────────────

  /** Wrap a unary (single request, single response) handler. */
  wrapUnary<Req, Res>(
    method: string,
    handler: (call: ServerUnaryCall<Req, Res>) => Promise<Res>
  ): (call: ServerUnaryCall<Req, Res>, callback: sendUnaryData<Res>) => void {
    return (call, callback) => {
      const start = Date.now();
      const customerId = this.customerIdExtractor(call.metadata.getMap());
      handler(call)
        .then((res) => {
          this.record(method, 'UNARY', customerId, 'OK', 1, Date.now() - start);
          callback(null, res);
        })
        .catch((err: Error & { code?: number }) => {
          const code = typeof err.code === 'number' ? err.code : 2; // UNKNOWN
          this.record(method, 'UNARY', customerId, GRPC_STATUS_LABELS[code] ?? 'UNKNOWN', 1, Date.now() - start);
          callback(err, null);
        });
    };
  }

  /** Wrap a server-streaming handler (counts messages sent; emits one event on stream close). */
  wrapServerStream<Req, Res>(
    method: string,
    handler: (call: ServerWritableStream<Req, Res>) => Promise<void>
  ): (call: ServerWritableStream<Req, Res>) => void {
    return (call) => {
      const start = Date.now();
      const customerId = this.customerIdExtractor(call.metadata.getMap());
      let messageCount = 0;
      const origWrite = call.write.bind(call);
      call.write = ((chunk: Res): boolean => {
        messageCount++;
        return origWrite(chunk);
      }) as typeof call.write;

      handler(call)
        .then(() => {
          this.record(method, 'SERVER_STREAM', customerId, 'OK', messageCount, Date.now() - start);
          call.end();
        })
        .catch((err: Error & { code?: number }) => {
          const code = typeof err.code === 'number' ? err.code : 2;
          this.record(method, 'SERVER_STREAM', customerId, GRPC_STATUS_LABELS[code] ?? 'UNKNOWN', messageCount, Date.now() - start);
          call.destroy(err);
        });
    };
  }

  /** Wrap a client-streaming handler (counts messages received; emits one event on completion). */
  wrapClientStream<Req, Res>(
    method: string,
    handler: (call: ServerReadableStream<Req, Res>) => Promise<Res>
  ): (call: ServerReadableStream<Req, Res>, callback: sendUnaryData<Res>) => void {
    return (call, callback) => {
      const start = Date.now();
      const customerId = this.customerIdExtractor(call.metadata.getMap());
      let messageCount = 0;
      call.on('data', () => { messageCount++; });

      handler(call)
        .then((res) => {
          this.record(method, 'CLIENT_STREAM', customerId, 'OK', messageCount, Date.now() - start);
          callback(null, res);
        })
        .catch((err: Error & { code?: number }) => {
          const code = typeof err.code === 'number' ? err.code : 2;
          this.record(method, 'CLIENT_STREAM', customerId, GRPC_STATUS_LABELS[code] ?? 'UNKNOWN', messageCount, Date.now() - start);
          callback(err, null);
        });
    };
  }

  /** Wrap a bidirectional-streaming handler. Counts messages sent + received. */
  wrapBidiStream<Req, Res>(
    method: string,
    handler: (call: ServerDuplexStream<Req, Res>) => Promise<void>
  ): (call: ServerDuplexStream<Req, Res>) => void {
    return (call) => {
      const start = Date.now();
      const customerId = this.customerIdExtractor(call.metadata.getMap());
      let messageCount = 0;
      call.on('data', () => { messageCount++; });
      const origWrite = call.write.bind(call);
      call.write = ((chunk: Res): boolean => {
        messageCount++;
        return origWrite(chunk);
      }) as typeof call.write;

      handler(call)
        .then(() => {
          this.record(method, 'BIDI_STREAM', customerId, 'OK', messageCount, Date.now() - start);
          call.end();
        })
        .catch((err: Error & { code?: number }) => {
          const code = typeof err.code === 'number' ? err.code : 2;
          this.record(method, 'BIDI_STREAM', customerId, GRPC_STATUS_LABELS[code] ?? 'UNKNOWN', messageCount, Date.now() - start);
          call.destroy(err);
        });
    };
  }

  // ── Event recording ──────────────────────────────────────────────

  private record(
    method: string,
    callType: GrpcUsageEvent['grpcCallType'],
    customerId: string | undefined,
    status: string,
    messageCount: number,
    durationMs: number,
    dataBytes?: number
  ): void {
    if (!customerId) {
      // No customer resolved — skip metering (non-billable call, e.g. health check)
      return;
    }
    const now = new Date();
    const event: GrpcUsageEvent = {
      customerId,
      metricName: 'grpc_api.rpc_calls',
      quantity: 1,
      occurredAt: now.toISOString(),
      idempotencyKey: `grpc:${this.config.tenantId}:${this.config.serviceName}:${method}:${now.getTime()}:${randomSuffix()}`,
      productType: 'GRPC_API',
      grpcService: this.config.serviceName,
      grpcMethod: method,
      grpcStatusCode: status,
      grpcCallType: callType,
      messageCount,
      dataBytes,
      executionDurationMs: durationMs,
      metadata: {
        sdkVersion: SDK_VERSION,
        productId: this.config.productId,
      },
    };
    this.buffer.push(event);
    if (this.buffer.length >= this.flushCount) {
      void this.flush();
    }
  }

  // ── Flush buffered events to the Aforo ingestor ──────────────────

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);

    const body = JSON.stringify({ events: batch });
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(this.config.ingestorUrl.replace(/\/$/, '') + '/v1/ingest/events', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
            'X-Tenant-Id': this.config.tenantId,
          },
          body,
        });
        if (res.ok) return;
        if (attempt < maxRetries) {
          await sleep(Math.pow(2, attempt - 1) * 1000); // 1s, 2s, 4s
        }
      } catch (err) {
        if (attempt === maxRetries) {
          this.onError(err as Error);
        } else {
          await sleep(Math.pow(2, attempt - 1) * 1000);
        }
      }
    }
    // Re-queue on total failure? No — dropping avoids unbounded memory growth.
    this.onError(new Error(`Aforo ingestor flush failed after ${maxRetries} attempts (batch of ${batch.length} events dropped)`));
  }

  private startTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => { void this.flush(); }, this.flushIntervalMs);
    // Allow Node.js to exit cleanly even if the timer is still running.
    if (typeof (this.flushTimer as any).unref === 'function') (this.flushTimer as any).unref();
  }

  /** Flush any buffered events and stop the background timer. Call before process exit. */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const GRPC_STATUS = {
  OK: 0, CANCELLED: 1, UNKNOWN: 2, INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4, NOT_FOUND: 5, ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7, RESOURCE_EXHAUSTED: 8, FAILED_PRECONDITION: 9,
  ABORTED: 10, OUT_OF_RANGE: 11, UNIMPLEMENTED: 12,
  INTERNAL: 13, UNAVAILABLE: 14, DATA_LOSS: 15, UNAUTHENTICATED: 16,
} as const;
