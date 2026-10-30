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
 *     // Who is billed: from identity your server verified (mTLS peer, a checked token).
 *     customerResolver: (call) => authenticatedCustomer(call),
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
 *
 *   // The SDK installs no signal handlers. Flush from your own:
 *   process.once('SIGTERM', async () => { await billing.shutdown(); process.exit(0); });
 */

import { createHash } from 'node:crypto';
import { TransportCore, CoreDropReason } from './transport-core/core';

/** What onError receives for delivery problems: branch on `kind`, read `events`. */
export { CoreTransportError, type CoreErrorKind } from './transport-core/core';
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
   * Who is billed for a call, from identity your server verified (the mTLS
   * peer certificate, an auth token you checked in an interceptor). Receives
   * the gRPC call object. Required unless `trustCustomerHeader` is true.
   * Returning nothing (or throwing) drops that call's event as 'invalid'
   * (counted); the RPC itself is never affected.
   */
  customerResolver?: (call: any) => string | undefined | null;
  /**
   * @deprecated Use `customerResolver`. Receives `call.metadata.getMap()`
   * (values are `string | Buffer`).
   */
  customerIdExtractor?: (metadata: Record<string, unknown>) => string | undefined | null;
  /**
   * Bill the `x-customer-id` call metadata. Any client can set metadata, so
   * only turn this on behind a proxy you control that sets it. Default false;
   * the constructor throws when neither this nor `customerResolver` is given.
   */
  trustCustomerHeader?: boolean;
  /** Allow a plain http:// ingestorUrl on a non-local host. Default false (https required). */
  allowInsecureHttp?: boolean;
  /**
   * Request compression: 'gzip' (default) sends batches of 1 KiB or more with
   * Content-Encoding: gzip (needs usage-ingestor wave 8 or later); 'none'
   * always sends plain JSON.
   */
  compression?: 'gzip' | 'none';
  /** Events per request (default 500, max 1000). Reaching it wakes the background sender. */
  flushCount?: number;
  /** The background sender also runs this often, in ms (default 5000). */
  flushIntervalMs?: number;
  /** Queue capacity (default 10 000). The oldest event is dropped on overflow. */
  maxQueueSize?: number;
  /** Retries per batch before the breaker opens (default 3). */
  maxRetries?: number;
  /** Total deadline per request, in ms (default 10 000). */
  timeoutMs?: number;
  /** How long shutdown() keeps sending, in ms (default 5000). */
  shutdownTimeoutMs?: number;
  /** Send queued events on the process 'beforeExit' event (default true). */
  flushOnExit?: boolean;
  /** Callback for delivery problems (rejected batches, outages), resolver errors and bad executionStatus values. */
  onError?: (error: Error) => void;
  /**
   * Opt-in hook receiving events that were permanently dropped (see
   * DropReason). Events keep their idempotency keys,
   * so persisting and re-submitting them after recovery is dedup-safe.
   * Exceptions thrown by the hook are swallowed. Default: none (drops are
   * still counted in droppedCount and WARN-logged).
   */
  onDrop?: (events: GrpcUsageEvent[], reason: DropReason) => void;
}

/**
 * Why events were permanently dropped. `overflow`: the queue was full and the
 * oldest event was evicted. `rejected`: the ingestor refused the batch
 * (non-retryable 4xx) or individual events of an accepted batch. `invalid`:
 * the event failed a client-side check, or the customer resolver returned no
 * customer. `shutdown`: still queued when the shutdown deadline passed.
 * `closed`: recorded after shutdown(). `retry_exhausted`: kept for
 * compatibility, not produced by 2.x — an outage keeps events queued.
 */
export type DropReason = 'overflow' | 'retry_exhausted' | 'rejected' | 'invalid' | 'shutdown' | 'closed';

const SDK_VERSION = '2.1.0';
/** Default top-level `productType` for this SDK. */
export const DEFAULT_PRODUCT_TYPE = 'GRPC_API';
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
  private readonly config: Required<Pick<AforoGrpcConfig, 'tenantId' | 'productId' | 'serviceName'>>;
  private readonly productType: string;
  private readonly onError: (error: Error) => void;
  private readonly resolveCustomer: (call: any) => string | undefined;
  private readonly core: TransportCore<GrpcUsageEvent>;
  /** Labels already reported as truncated (one WARN per label). */
  private readonly truncationWarned = new Set<string>();

  constructor(config: AforoGrpcConfig) {
    const resolver = config.customerResolver;
    const legacy = config.customerIdExtractor;
    const trustHeader = config.trustCustomerHeader === true;
    if (typeof resolver !== 'function' && typeof legacy !== 'function' && !trustHeader) {
      throw new Error(
        '[aforo-grpc] AforoGrpcBilling needs a customerResolver: (call) => the Aforo customer id from identity your ' +
          'server verified (mTLS peer, a checked token). To bill the x-customer-id metadata instead — only safe ' +
          'behind a proxy that sets it — pass trustCustomerHeader: true.',
      );
    }
    this.config = {
      tenantId: config.tenantId,
      productId: config.productId,
      serviceName: config.serviceName,
    };
    this.productType = normalizeProductType(config.productType) ?? DEFAULT_PRODUCT_TYPE;
    this.onError = config.onError ?? ((err) => console.error('[aforo-grpc]', err.message));
    this.resolveCustomer = (call: any) => {
      const md = () => (typeof call?.metadata?.getMap === 'function' ? call.metadata.getMap() : {});
      const fromResolver =
        typeof resolver === 'function'
          ? textOrUndefined(resolver(call))
          : typeof legacy === 'function'
            ? textOrUndefined(legacy(md()))
            : undefined;
      if (fromResolver) return fromResolver;
      return trustHeader ? textOrUndefined(metadataText(md()['x-customer-id'])) : undefined;
    };
    const onDrop = config.onDrop;
    // The core is the only holder of the API key.
    this.core = new TransportCore<GrpcUsageEvent>({
      baseUrl: config.ingestorUrl,
      apiKey: config.apiKey,
      allowInsecureHttp: config.allowInsecureHttp,
      compression: config.compression,
      headers: { 'X-Tenant-Id': config.tenantId },
      userAgent: `aforo-grpc-metering/${SDK_VERSION}`,
      flushCount: config.flushCount,
      flushIntervalMs: config.flushIntervalMs,
      maxQueueSize: config.maxQueueSize,
      maxRetries: config.maxRetries,
      timeoutMs: config.timeoutMs,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      flushOnExit: config.flushOnExit,
      logPrefix: '[aforo-grpc]',
      onError: (err) => this.reportError(err),
      onDrop: onDrop ? (events, reason: CoreDropReason) => onDrop(events, reason as DropReason) : undefined,
    });
  }

  /** The customer for a call; a resolver that throws is reported and counts as "no customer". */
  private customerOf(call: any): string | undefined {
    try {
      return this.resolveCustomer(call);
    } catch (err) {
      this.reportError(new Error(`[aforo-grpc] customerResolver threw: ${(err as Error)?.message ?? err}`));
      return undefined;
    }
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
      const customerId = this.customerOf(call);
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
      const customerId = this.customerOf(call);
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
      const customerId = this.customerOf(call);
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
      const customerId = this.customerOf(call);
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
    const now = new Date();
    const service = this.config.serviceName;
    // The idempotency key is minted here, once, and travels with the event
    // through every retry and into onDrop.
    const event: GrpcUsageEvent = {
      customerId: customerId ?? '',
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
      (typeof customerId !== 'string' || !customerId.trim()
        ? { field: 'customerId', problem: 'no customer: the customer resolver returned nothing; the call is not metered' }
        : undefined) ??
      tooLong('customerId', event.customerId, MAX_CUSTOMER_ID) ??
      requiredText('grpcService', event.grpcService) ??
      requiredText('grpcMethod', event.grpcMethod) ??
      tooLong('grpcService', event.grpcService, MAX_GRPC_SERVICE) ??
      tooLong('grpcMethod', event.grpcMethod, MAX_GRPC_METHOD) ??
      tooLong('productType', event.productType, MAX_PRODUCT_TYPE);
    if (invalid) {
      this.core.reportDrop([event], 'invalid', invalid.problem);
      return;
    }

    // Queue only; the core's single background sender does the HTTP.
    this.core.enqueue(event);
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

  /** Invoke onError; a hook bug must never break metering or flushing. */
  private reportError(err: Error): void {
    try {
      this.onError(err);
    } catch (hookErr) {
      console.debug('[aforo-grpc] onError hook threw', hookErr);
    }
  }

  /** Number of events permanently dropped since this instance was created (every DropReason). */
  get droppedCount(): number {
    return this.core.droppedCount;
  }

  /** Number of events waiting to be sent. */
  get queuedCount(): number {
    return this.core.queued;
  }

  /** Send what is queued now and wait for it (one request at a time; never concurrent). */
  async flush(): Promise<{ sent: number; failed: number; requeued: number; queued: number }> {
    return this.core.flush();
  }

  /**
   * Stop accepting events and send what is queued, for at most
   * `shutdownTimeoutMs`. Events still queued then are dropped with reason
   * 'shutdown' (counted, passed to onDrop). Call it from your SIGTERM handler.
   */
  async shutdown(): Promise<void> {
    await this.core.shutdown();
  }

  toJSON(): Record<string, unknown> {
    return { tenantId: this.config.tenantId, productId: this.config.productId, serviceName: this.config.serviceName, queued: this.queuedCount, dropped: this.droppedCount };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `AforoGrpcBilling { tenantId: '${this.config.tenantId}', serviceName: '${this.config.serviceName}', queued: ${this.queuedCount}, dropped: ${this.droppedCount} }`;
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

function textOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

/** gRPC metadata values are string | Buffer (or an array of them). */
function metadataText(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v === 'string') return v;
  if (v && typeof (v as any).toString === 'function') return String(v);
  return undefined;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}


export const GRPC_STATUS = {
  OK: 0, CANCELLED: 1, UNKNOWN: 2, INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4, NOT_FOUND: 5, ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7, RESOURCE_EXHAUSTED: 8, FAILED_PRECONDITION: 9,
  ABORTED: 10, OUT_OF_RANGE: 11, UNIMPLEMENTED: 12,
  INTERNAL: 13, UNAVAILABLE: 14, DATA_LOSS: 15, UNAUTHENTICATED: 16,
} as const;
