/**
 * @aforoai/grpc-metering — Aforo gRPC Metering SDK
 *
 * Wraps gRPC server handlers (unary, server-stream, client-stream, bidi-stream)
 * to automatically meter per-method invocations and forward billing events to
 * Aforo's usage ingestor. Works with @grpc/grpc-js.
 *
 * Usage (unary handler):
 *   import { AforoGrpcBilling } from '@aforoai/grpc-metering';
 *
 *   const billing = new AforoGrpcBilling({
 *     tenantId: 'tenant_acme',
 *     productId: 'prod_grpc_001',
 *     apiKey: process.env.AFORO_API_KEY!,
 *     ingestorUrl: 'https://api.aforo.ai',
 *     serviceName: 'acme.v1.UserService',
 *     // productType defaults to 'GRPC_API'
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

import { createHash } from 'node:crypto';
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
  /**
   * Aforo product type sent as top-level `productType` on every event (trimmed + uppercased).
   * Default: `GRPC_API`. Override per handler via the wrappers' `options.productType`.
   */
  productType?: string;
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
  /**
   * Opt-in hook receiving events that were permanently dropped (retry
   * exhaustion, a rejection by the ingestor, or a failed client-side check —
   * see DropReason). Events keep their idempotency keys,
   * so persisting and re-submitting them after recovery is dedup-safe.
   * Exceptions thrown by the hook are swallowed. Default: none (drops are
   * still counted in droppedCount and WARN-logged).
   */
  onDrop?: (events: GrpcUsageEvent[], reason: DropReason) => void;
}

/**
 * Why events were permanently dropped. `retry_exhausted`: the ingestor stayed
 * unreachable / kept answering 408, 429 or 5xx. `rejected`: the ingestor
 * refused the batch (non-retryable 4xx) or individual events of an accepted
 * batch. `invalid`: the event failed a client-side check and was never sent.
 * The buffer is unbounded (drained at flush start), so unlike the core SDK
 * there is no 'overflow' reason here.
 */
export type DropReason = 'retry_exhausted' | 'rejected' | 'invalid';

const SDK_VERSION = '1.2.2';
/** Default top-level `productType` for this SDK. */
export const DEFAULT_PRODUCT_TYPE = 'GRPC_API';
/** Upper bound on a server-requested Retry-After wait. */
const MAX_RETRY_AFTER_MS = 30_000;
/** The ingestor rejects batch requests with more than 1000 events. */
const MAX_BATCH_EVENTS = 1000;
/** usage-ingestor limits (IngestUsageEventRequest). */
const MAX_CUSTOMER_ID = 64;
const MAX_IDEMPOTENCY_KEY = 255;
const MAX_PRODUCT_TYPE = 20;
const MAX_GRPC_SERVICE = 255;
const MAX_GRPC_METHOD = 128;

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

export interface GrpcUsageEvent {
  customerId: string;
  metricName: string;
  quantity: number;
  occurredAt: string;
  idempotencyKey: string;
  productType: string;
  grpcService: string;
  grpcMethod: string;
  grpcStatusCode: string;
  grpcCallType: 'UNARY' | 'CLIENT_STREAM' | 'SERVER_STREAM' | 'BIDI_STREAM';
  messageCount: number;
  dataBytes?: number;
  executionDurationMs: number;
  metadata?: Record<string, unknown>;
  /**
   * Normalized (trimmed, upper-cased) execution status; omitted when not set.
   * Derived from the gRPC status code (see outcomeFromGrpcStatus) unless the
   * wrap* call supplied an explicit value.
   */
  executionStatus?: string;
}

/** What the wrapper saw when the handler finished; passed to an executionStatus resolver. */
export interface GrpcCallOutcome<Call = unknown> {
  /** The gRPC call object the handler received. */
  call: Call;
  /** Numeric gRPC status code (0 = OK; 2 = UNKNOWN when the thrown error had no numeric code). */
  code: number;
  /** The error the handler threw, if any. */
  error?: Error;
}

/** Per-method options for the wrap* helpers. */
export interface GrpcWrapOptions<Call = unknown> {
  /**
   * Optional outcome of the request (used by OUTCOME_BASED pricing, which bills
   * each event at the weight set for its status). Events without a status bill
   * at full price. Trimmed and upper-cased by the SDK; blank is treated as absent.
   * Accepted values: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED, FAILED,
   * FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED (max 20 chars). Any other
   * value — or a Promise from an async resolver — is reported through `onError`
   * and ignored: the event gets the status derived from the gRPC code instead,
   * because the server would reject the event. Resolvers must be synchronous.
   */
  executionStatus?: string | ((outcome: GrpcCallOutcome<Call>) => string | undefined);
  /** Product type for events from this handler (trimmed + uppercased). Default: the client-level `productType`. */
  productType?: string;
}

/** Alias of {@link GrpcWrapOptions}. */
export type WrapOptions<Call = unknown> = GrpcWrapOptions<Call>;

export class AforoGrpcBilling {
  private readonly config: Required<
    Pick<AforoGrpcConfig, 'tenantId' | 'productId' | 'apiKey' | 'ingestorUrl' | 'serviceName'>
  >;
  private readonly productType: string;
  private readonly flushCount: number;
  private readonly flushIntervalMs: number;
  private readonly onError: (error: Error) => void;
  private readonly onDrop?: (events: GrpcUsageEvent[], reason: DropReason) => void;
  private readonly customerIdExtractor: (metadata: Record<string, unknown>) => string | undefined;

  private buffer: GrpcUsageEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dropped = 0;
  /** Invalid-event count per field, for WARN throttling. */
  private readonly invalidSeen = new Map<string, number>();
  /** Labels already reported as truncated (one WARN per label). */
  private readonly truncationWarned = new Set<string>();

  constructor(config: AforoGrpcConfig) {
    this.config = {
      tenantId: config.tenantId,
      productId: config.productId,
      apiKey: config.apiKey,
      ingestorUrl: config.ingestorUrl,
      serviceName: config.serviceName,
    };
    this.productType = normalizeProductType(config.productType) ?? DEFAULT_PRODUCT_TYPE;
    this.flushCount = config.flushCount ?? 50;
    this.flushIntervalMs = config.flushIntervalMs ?? 5000;
    this.onError = config.onError ?? ((err) => console.error('[aforo-grpc]', err.message));
    this.onDrop = config.onDrop;
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
    handler: (call: ServerUnaryCall<Req, Res>) => Promise<Res>,
    options?: GrpcWrapOptions<ServerUnaryCall<Req, Res>>
  ): (call: ServerUnaryCall<Req, Res>, callback: sendUnaryData<Res>) => void {
    return (call, callback) => {
      const start = Date.now();
      const customerId = this.customerIdExtractor(call.metadata.getMap());
      handler(call)
        .then((res) => {
          this.record(method, 'UNARY', customerId, { call, code: 0 }, options, 1, Date.now() - start);
          callback(null, res);
        })
        .catch((err: Error & { code?: number }) => {
          this.record(method, 'UNARY', customerId, { call, code: errorCode(err), error: err }, options, 1, Date.now() - start);
          callback(err, null);
        });
    };
  }

  /** Wrap a server-streaming handler (counts messages sent; emits one event on stream close). */
  wrapServerStream<Req, Res>(
    method: string,
    handler: (call: ServerWritableStream<Req, Res>) => Promise<void>,
    options?: GrpcWrapOptions<ServerWritableStream<Req, Res>>
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
          this.record(method, 'SERVER_STREAM', customerId, { call, code: 0 }, options, messageCount, Date.now() - start);
          call.end();
        })
        .catch((err: Error & { code?: number }) => {
          this.record(method, 'SERVER_STREAM', customerId, { call, code: errorCode(err), error: err }, options, messageCount, Date.now() - start);
          call.destroy(err);
        });
    };
  }

  /** Wrap a client-streaming handler (counts messages received; emits one event on completion). */
  wrapClientStream<Req, Res>(
    method: string,
    handler: (call: ServerReadableStream<Req, Res>) => Promise<Res>,
    options?: GrpcWrapOptions<ServerReadableStream<Req, Res>>
  ): (call: ServerReadableStream<Req, Res>, callback: sendUnaryData<Res>) => void {
    return (call, callback) => {
      const start = Date.now();
      const customerId = this.customerIdExtractor(call.metadata.getMap());
      let messageCount = 0;
      call.on('data', () => { messageCount++; });

      handler(call)
        .then((res) => {
          this.record(method, 'CLIENT_STREAM', customerId, { call, code: 0 }, options, messageCount, Date.now() - start);
          callback(null, res);
        })
        .catch((err: Error & { code?: number }) => {
          this.record(method, 'CLIENT_STREAM', customerId, { call, code: errorCode(err), error: err }, options, messageCount, Date.now() - start);
          callback(err, null);
        });
    };
  }

  /** Wrap a bidirectional-streaming handler. Counts messages sent + received. */
  wrapBidiStream<Req, Res>(
    method: string,
    handler: (call: ServerDuplexStream<Req, Res>) => Promise<void>,
    options?: GrpcWrapOptions<ServerDuplexStream<Req, Res>>
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
          this.record(method, 'BIDI_STREAM', customerId, { call, code: 0 }, options, messageCount, Date.now() - start);
          call.end();
        })
        .catch((err: Error & { code?: number }) => {
          this.record(method, 'BIDI_STREAM', customerId, { call, code: errorCode(err), error: err }, options, messageCount, Date.now() - start);
          call.destroy(err);
        });
    };
  }

  // ── Event recording ──────────────────────────────────────────────

  private record<Call>(
    method: string,
    callType: GrpcUsageEvent['grpcCallType'],
    customerId: string | undefined,
    outcome: GrpcCallOutcome<Call>,
    options: GrpcWrapOptions<Call> | undefined,
    messageCount: number,
    durationMs: number,
    dataBytes?: number
  ): void {
    if (typeof customerId !== 'string' || !customerId.trim()) {
      // No customer resolved — skip metering (non-billable call, e.g. health check)
      return;
    }
    const now = new Date();
    const service = this.config.serviceName;
    // The idempotency key is minted here, once, and travels with the event
    // through every retry and into onDrop.
    const event: GrpcUsageEvent = {
      customerId,
      metricName: 'grpc_api.rpc_calls',
      quantity: 1,
      occurredAt: now.toISOString(),
      // Built from the untruncated method. When the method makes the key
      // longer than the ingestor allows it is replaced by its SHA-256 digest;
      // the key itself is never cut.
      idempotencyKey: boundedIdempotencyKey(
        `grpc:${this.config.tenantId}:${service}:`,
        String(method),
        `:${now.getTime()}:${randomSuffix()}`,
      ),
      productType: normalizeProductType(options?.productType) ?? this.productType,
      grpcService: service,
      // The method names the RPC the consumer called: an over-long one is cut
      // to the ingestor's limit and the call is still billed.
      grpcMethod: this.requestLabel('grpcMethod', method, MAX_GRPC_METHOD),
      grpcStatusCode: GRPC_STATUS_LABELS[outcome.code] ?? 'UNKNOWN',
      grpcCallType: callType,
      messageCount,
      dataBytes,
      executionDurationMs: durationMs,
      metadata: {
        sdkVersion: SDK_VERSION,
        productId: this.config.productId,
      },
    };
    // Explicit caller value wins; otherwise derive from the gRPC status code.
    // An explicit value the ingestor wouldn't accept is reported and ignored,
    // so the derived status is used instead (same rule as the Go and MCP SDKs).
    const explicit = checkExecutionStatus(resolveExplicitStatus(options, outcome));
    if (explicit.problem) this.reportError(new Error(`[aforo-grpc] ${explicit.problem}`));
    const executionStatus = explicit.status ?? outcomeFromGrpcStatus(outcome.code);
    if (executionStatus) event.executionStatus = executionStatus;

    // An event the ingestor would reject is not sent (one bad event fails its
    // whole batch): it is dropped here with reason 'invalid', never thrown
    // into the RPC path.
    const invalid =
      tooLong('customerId', event.customerId, MAX_CUSTOMER_ID) ??
      requiredText('grpcService', event.grpcService) ??
      requiredText('grpcMethod', event.grpcMethod) ??
      tooLong('grpcService', event.grpcService, MAX_GRPC_SERVICE) ??
      tooLong('grpcMethod', event.grpcMethod, MAX_GRPC_METHOD) ??
      tooLong('productType', event.productType, MAX_PRODUCT_TYPE);
    if (invalid) {
      this.recordInvalid(event, invalid);
      return;
    }

    this.buffer.push(event);
    if (this.buffer.length >= this.flushCount) {
      void this.flush();
    }
  }

  /**
   * Bound a label that originates from the incoming RPC to the ingestor's
   * limit. The event is still sent; one WARN per label name per client.
   * Configuration (serviceName) and identity fields never go through here —
   * an over-long one drops the event as 'invalid'.
   */
  private requestLabel(field: string, value: string, max: number): string {
    if (typeof value !== 'string' || value.length <= max) return value;
    if (!this.truncationWarned.has(field)) {
      this.truncationWarned.add(field);
      console.warn(
        `[aforo-grpc] ${field} was longer than the ingestor's limit and was ` +
          `truncated to ${max} characters; the event is still sent. Logged once per label.`,
      );
    }
    return truncateToLimit(value, max);
  }

  // ── Flush buffered events to the Aforo ingestor ──────────────────

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const pending = this.buffer.splice(0, this.buffer.length);
    // The ingestor accepts at most MAX_BATCH_EVENTS events per request.
    for (let i = 0; i < pending.length; i += MAX_BATCH_EVENTS) {
      await this.send(pending.slice(i, i + MAX_BATCH_EVENTS));
    }
  }

  private async send(batch: GrpcUsageEvent[]): Promise<void> {
    // Serialized once, so every retry re-sends the same idempotencyKeys.
    const body = JSON.stringify({ events: batch });
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let delayMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
      let res: Response | undefined;
      let networkError: Error | undefined;
      try {
        res = await fetch(this.config.ingestorUrl.replace(/\/$/, '') + '/v1/ingest/batch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.config.apiKey,
            'X-Tenant-Id': this.config.tenantId,
          },
          body,
        });
      } catch (err) {
        networkError = err as Error;
      }

      if (res) {
        if (res.ok) {
          await this.handlePartialFailures(res, batch);
          return;
        }
        if (!isRetryableStatus(res.status)) {
          // 4xx other than 408/429: the same body would be refused again.
          const { details } = await readBatchResult(res, batch.length);
          this.recordDrop(batch, 'rejected');
          this.reportError(new Error(`gRPC metering batch rejected with HTTP ${res.status}${details ? ` — ${details}` : ''} (dropped ${batch.length} events, not retried)`));
          return;
        }
        delayMs = parseRetryAfter(res) ?? delayMs;
      } else if (attempt === maxRetries) {
        this.recordDrop(batch, 'retry_exhausted');
        this.reportError(networkError ?? new Error('gRPC metering request failed'));
        return;
      }
      if (attempt < maxRetries) await sleep(delayMs);
    }
    // Not re-queued: dropping avoids unbounded memory growth.
    this.recordDrop(batch, 'retry_exhausted');
    this.reportError(new Error(`gRPC metering flush failed after ${maxRetries} attempts (dropped ${batch.length} events)`));
  }

  /**
   * A 2xx can still carry per-event rejections:
   * `{accepted, duplicates, failed, errors:[{index, message}]}`. Events the
   * response names by index are dropped with reason 'rejected'; a `failed`
   * count the response does not attribute to an index is counted only.
   */
  private async handlePartialFailures(res: Response, batch: GrpcUsageEvent[]): Promise<void> {
    const { failed, details, indexes } = await readBatchResult(res, batch.length);
    if (failed <= 0) return;
    if (indexes.length > 0) this.recordDrop(indexes.map((i) => batch[i]), 'rejected');
    const unattributed = Math.min(failed, batch.length) - indexes.length;
    if (unattributed > 0) {
      this.dropped += unattributed;
      console.warn(
        `[aforo-grpc] Dropped ${unattributed} event(s) — rejected, not identified by the ingestor (${this.dropped} total dropped).`,
      );
    }
    this.reportError(new Error(`Aforo ingestor rejected ${failed} event(s)${details ? ` — ${details}` : ''}`));
  }

  /** Invoke onError; a hook bug must never break metering or flushing. */
  private reportError(err: Error): void {
    try {
      this.onError(err);
    } catch {
      // ignore
    }
  }

  /** Number of events permanently dropped since this instance was created. */
  get droppedCount(): number {
    return this.dropped;
  }

  /**
   * Account for permanently lost events: bump the counter, WARN-log, and
   * invoke the opt-in onDrop hook. The buffer is drained at flush start, so
   * drops here are bounded by flush cadence — no log throttle needed.
   */
  private recordDrop(events: GrpcUsageEvent[], reason: DropReason): void {
    this.dropped += events.length;
    console.warn(
      `[aforo-grpc] Dropped ${events.length} event(s) — ${reason} (${this.dropped} total dropped).`,
    );
    this.notifyDrop(events, reason);
  }

  /**
   * Account for an event that failed a client-side check: never buffered,
   * never sent. Runs on the hot path, so the WARN is throttled per field
   * (first occurrence, then every 1000th).
   */
  private recordInvalid(event: GrpcUsageEvent, invalid: InvalidField): void {
    this.dropped += 1;
    const seen = (this.invalidSeen.get(invalid.field) ?? 0) + 1;
    this.invalidSeen.set(invalid.field, seen);
    if (seen === 1 || seen % 1000 === 0) {
      console.warn(
        `[aforo-grpc] Dropped 1 event — invalid: ${invalid.problem} ` +
          `(${seen} for ${invalid.field}, ${this.dropped} total dropped).`,
      );
    }
    this.notifyDrop([event], 'invalid');
  }

  private notifyDrop(events: GrpcUsageEvent[], reason: DropReason): void {
    if (!this.onDrop) return;
    try {
      this.onDrop(events, reason);
    } catch {
      // A hook bug must never break metering or flushing.
    }
  }

  private startTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => { void this.flush(); }, this.flushIntervalMs);
    // Unref so the background timer never blocks host-process exit (final flush still needs shutdown()).
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

/**
 * Map a numeric gRPC status code to an Aforo execution status. Same table as
 * the Aforo gateway plugins: OK → SUCCESS; CANCELLED → CANCELLED;
 * INVALID_ARGUMENT / FAILED_PRECONDITION / OUT_OF_RANGE → VALIDATION_FAILED;
 * DEADLINE_EXCEEDED → TIMEOUT; PERMISSION_DENIED / RESOURCE_EXHAUSTED /
 * UNAUTHENTICATED → BLOCKED; every other code → ERROR.
 */
export function outcomeFromGrpcStatus(code: number): string {
  switch (code) {
    case 0: return 'SUCCESS';
    case 1: return 'CANCELLED';
    case 3:
    case 9:
    case 11: return 'VALIDATION_FAILED';
    case 4: return 'TIMEOUT';
    case 7:
    case 8:
    case 16: return 'BLOCKED';
    default: return 'ERROR';
  }
}

/** Statuses the Aforo ingestor accepts (contract/ingest-contract.json, max 20 chars). */
const CANONICAL_EXECUTION_STATUSES: ReadonlySet<string> = new Set([
  'SUCCESS', 'PARTIAL', 'TIMEOUT', 'ERROR', 'VALIDATION_FAILED', 'FAILED',
  'FAILURE', 'CANCELLED', 'PENDING', 'BLOCKED', 'HITL_REQUIRED',
]);

/**
 * Check a caller-supplied status. `{ status }` when canonical; `{ problem }`
 * when it can't be used (an unknown value would make the
 * ingestor reject the event; a Promise from an async resolver can't be
 * awaited on this path); `{}` when blank or absent.
 */
function checkExecutionStatus(value: unknown): { status?: string; problem?: string } {
  if (value !== null && typeof value === 'object' && typeof (value as any).then === 'function') {
    // Swallow a later rejection so it doesn't surface as an unhandled rejection.
    (value as PromiseLike<unknown>).then(undefined, () => {});
    return { problem: 'executionStatus resolver returned a Promise — resolvers must be synchronous; field omitted' };
  }
  const status = normalizeExecutionStatus(value);
  if (!status) return {};
  if (!CANONICAL_EXECUTION_STATUSES.has(status)) {
    return {
      problem: `unknown executionStatus "${status.slice(0, 40)}" — field omitted. ` +
        `Expected one of: ${[...CANONICAL_EXECUTION_STATUSES].join(', ')}`,
    };
  }
  return { status };
}

/** Trim + upper-case; blank/absent → undefined (key omitted from the wire body). */
function normalizeExecutionStatus(value?: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}

function resolveExplicitStatus<Call>(
  options: GrpcWrapOptions<Call> | undefined,
  outcome: GrpcCallOutcome<Call>
): string | undefined {
  const opt = options?.executionStatus;
  if (typeof opt === 'function') {
    try {
      return opt(outcome);
    } catch {
      return undefined; // a resolver bug must never break the call or metering
    }
  }
  return opt;
}

function errorCode(err: { code?: unknown } | undefined): number {
  return typeof err?.code === 'number' ? err.code : 2; // UNKNOWN
}

/** Trim + uppercase a product type; blank/non-string → undefined (unknown values pass through). */
function normalizeProductType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}

/** A client-side check an event failed: which field, and a message naming the limit and the value. */
interface InvalidField {
  field: string;
  problem: string;
}

/** The offending value for a WARN line, cut to 80 chars. */
function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text);
}

/** Limits mirror the ingestor's IngestUsageEventRequest; identity and configuration values are never truncated. */
function tooLong(field: string, value: unknown, max: number): InvalidField | undefined {
  if (typeof value !== 'string' || value.length <= max) return undefined;
  return { field, problem: `${field} is ${value.length} chars, limit ${max}: ${preview(value)}` };
}

function requiredText(field: string, value: unknown): InvalidField | undefined {
  if (typeof value === 'string' && value.trim()) return undefined;
  return { field, problem: `${field} is required and must not be blank: ${preview(value)}` };
}

/** Network errors, 408, 429 and 5xx are transient; every other 4xx (400/401/403/422...) is not. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Retry-After (delta-seconds or HTTP date) in ms, capped at MAX_RETRY_AFTER_MS. */
function parseRetryAfter(res: Response): number | undefined {
  const raw = (res as any)?.headers?.get?.('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
  return undefined;
}

/**
 * Reads the ingestor's batch response body, if any: the `failed` count, the
 * first 5 `errors[].message` entries, and the batch indexes `errors[]` names.
 */
async function readBatchResult(
  res: Response,
  batchSize: number,
): Promise<{ failed: number; details: string; indexes: number[] }> {
  const none = { failed: 0, details: '', indexes: [] };
  if (typeof (res as any)?.json !== 'function') return none;
  try {
    const body: any = unwrapEnvelope(await res.json());
    const errors: any[] | undefined = Array.isArray(body?.errors) ? body.errors : undefined;
    const details = errors
      ? errors.slice(0, 5).map((e: any) => `#${e?.index}: ${e?.message}`).join('; ')
      : typeof body?.message === 'string' ? body.message : '';
    const indexes = [
      ...new Set(
        (errors ?? [])
          .map((e: any) => e?.index)
          .filter((i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < batchSize),
      ),
    ].sort((a, b) => a - b);
    const failed = typeof body?.failed === 'number' && body.failed > 0 ? body.failed : 0;
    return { failed, details, indexes };
  } catch {
    return none; // Non-JSON or empty body — nothing to report.
  }
}

/**
 * Cut `value` to at most `max` UTF-16 code units — how the ingestor counts
 * (`String.length()` in Java) — without leaving half a surrogate pair.
 */
export function truncateToLimit(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = Math.max(0, max);
  const last = end > 0 ? value.charCodeAt(end - 1) : 0;
  // A high surrogate at the cut means its low half was cut off: drop it too.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/**
 * Build `head + component + tail`, where `component` is text taken from the
 * incoming request and may be any length. Returned unchanged when it fits the
 * ingestor's idempotencyKey limit; otherwise the component is replaced by the
 * SHA-256 hex digest of its full, untruncated value (and, if the fixed parts
 * alone are too long, `head + component` is). The key is never cut, so the
 * unique tail always survives and two different components never share a key
 * prefix by accident.
 */
function boundedIdempotencyKey(head: string, component: string, tail: string): string {
  const key = `${head}${component}${tail}`;
  if (key.length <= MAX_IDEMPOTENCY_KEY) return key;
  const hashed = `${head}${sha256Hex(component)}${tail}`;
  if (hashed.length <= MAX_IDEMPOTENCY_KEY) return hashed;
  return `${sha256Hex(head + component)}${tail}`;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

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

/**
 * The ingestor wraps every 2xx JSON body in `{success, data, meta}`. Returns
 * the inner `data` object when present, else the body unchanged (bare shape).
 */
function unwrapEnvelope(body: any): any {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? body.data : undefined;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : body;
}
