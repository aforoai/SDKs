/**
 * @aforoai/graphql-metering — Aforo GraphQL Metering SDK
 *
 * Computes per-operation complexity using the GraphQL AST, captures the
 * operation type/name, and forwards billing events to Aforo's usage
 * ingestor. Exposes:
 *   - Apollo Server plugin: aforoApolloPlugin(billing)
 *   - Express middleware:   billing.middleware()  (for graphql-http, express-graphql, etc.)
 *   - Low-level recordOperation() for custom servers
 *
 * Usage (Apollo Server 4):
 *   import { ApolloServer } from '@apollo/server';
 *   import { AforoGraphQlBilling, aforoApolloPlugin } from '@aforoai/graphql-metering';
 *
 *   const billing = new AforoGraphQlBilling({
 *     tenantId: 'tenant_acme',
 *     productId: 'prod_graphql_001',
 *     apiKey: process.env.AFORO_API_KEY!,
 *     ingestorUrl: 'https://api.aforo.ai',
 *     schemaVersion: 'v2.1',
 *     // productType defaults to 'GRAPHQL_API'
 *   });
 *
 *   const server = new ApolloServer({
 *     typeDefs, resolvers,
 *     plugins: [aforoApolloPlugin(billing)],
 *   });
 */

import { createHash } from 'node:crypto';
import { parse, visit, Kind, type OperationDefinitionNode, type DocumentNode } from 'graphql';

export interface AforoGraphQlConfig {
  tenantId: string;
  productId: string;
  apiKey: string;
  ingestorUrl: string;
  /**
   * Aforo product type sent as top-level `productType` on every event (trimmed + uppercased).
   * Default: `GRAPHQL_API`. Override per call via `record({ productType })`, or per
   * integration via `middleware({ productType })` / `aforoApolloPlugin(billing, { productType })`.
   */
  productType?: string;
  /** GraphQL schema version string, attached to every event's metadata. */
  schemaVersion?: string;
  /** Extract Aforo customer ID from the request context. Default: ctx.headers['x-customer-id']. */
  customerIdExtractor?: (context: unknown) => string | undefined;
  /** Override the complexity scorer. Default: fieldCount + 5 × depth. */
  complexityScorer?: (doc: DocumentNode, operationName?: string) => { complexity: number; fieldCount: number };
  /** How many events to buffer before flushing (default 50). */
  flushCount?: number;
  /** Max interval in ms before a partial batch is flushed (default 5000). */
  flushIntervalMs?: number;
  /** Callback invoked when a flush fails terminally. */
  onError?: (error: Error) => void;
  /**
   * Opt-in hook receiving events that were permanently dropped (retry
   * exhaustion, a rejection by the ingestor, or a failed client-side check —
   * see DropReason). Events keep their idempotency keys,
   * so persisting and re-submitting them after recovery is dedup-safe.
   * Exceptions thrown by the hook are swallowed. Default: none (drops are
   * still counted in droppedCount and WARN-logged).
   */
  onDrop?: (events: GraphQlUsageEvent[], reason: DropReason) => void;
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
export const DEFAULT_PRODUCT_TYPE = 'GRAPHQL_API';
/** Upper bound on a server-requested Retry-After wait. */
const MAX_RETRY_AFTER_MS = 30_000;
/** The ingestor rejects batch requests with more than 1000 events. */
const MAX_BATCH_EVENTS = 1000;
/** usage-ingestor limits (IngestUsageEventRequest). */
const MAX_CUSTOMER_ID = 64;
const MAX_IDEMPOTENCY_KEY = 255;
const MAX_PRODUCT_TYPE = 20;
const MAX_GQL_OPERATION_NAME = 255;


export interface GraphQlUsageEvent {
  customerId: string;
  metricName: string;
  quantity: number;
  occurredAt: string;
  idempotencyKey: string;
  productType: string;
  gqlOperationType: 'QUERY' | 'MUTATION' | 'SUBSCRIPTION';
  gqlOperationName: string;
  gqlComplexity: number;
  gqlFieldCount: number;
  gqlHasErrors: boolean;
  dataBytes?: number;
  executionDurationMs: number;
  metadata?: Record<string, unknown>;
  /**
   * Normalized (trimmed, upper-cased) execution status; omitted when not set.
   * Explicit value first, else derived from the GraphQL response, else from
   * the HTTP status.
   */
  executionStatus?: string;
}

/** The parts of a GraphQL response the SDK reads to derive an execution status. */
export interface GraphQlResponseShape {
  data?: unknown;
  errors?: readonly unknown[] | null;
}

export interface RecordArgs {
  customerId: string;
  query: string | DocumentNode;
  operationName?: string | null;
  durationMs: number;
  hasErrors: boolean;
  responseBytes?: number;
  /**
   * Optional outcome of the request (used by OUTCOME_BASED pricing, which bills
   * each event at the weight set for its status). Events without a status bill
   * at full price. Trimmed and upper-cased by the SDK; blank is treated as absent.
   * Accepted values: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED, FAILED,
   * FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED (max 20 chars). Any other
   * value — or a Promise from an async resolver — is reported through `onError`
   * and ignored, because the server would reject the event: the status
   * derived from `response` / `httpStatus` is used instead, or the key is left
   * off when nothing can be derived. The event is always sent.
   */
  executionStatus?: string;
  /**
   * The GraphQL response, when known. Used to derive executionStatus when no
   * explicit value is given (see outcomeFromGraphQlResponse). Leave `data`
   * out entirely when the response had no `data` key.
   */
  response?: GraphQlResponseShape;
  /**
   * HTTP status of the response. Used to derive executionStatus only when
   * there is no explicit value and `response` derives nothing (see
   * outcomeFromHttpStatus).
   */
  httpStatus?: number;
  /** Per-event product type override. Default: the client-level `productType`. */
  productType?: string;
}

/** Per-integration options shared by `middleware()` and `aforoApolloPlugin()`. */
export interface AforoGraphQlIntegrationOptions {
  /** Product type for events recorded by this integration. Default: the client-level `productType`. */
  productType?: string;
}

/** Options for billing.middleware(). */
export interface GraphQlMiddlewareOptions extends AforoGraphQlIntegrationOptions {
  /**
   * Explicit execution status for a request, overriding the derived value.
   * Return undefined (or blank) to keep the derived value. Must be synchronous;
   * an unknown value or a Promise is reported through `onError` and the derived
   * value is kept.
   */
  executionStatus?: (req: any, res: any) => string | undefined;
}

/** Options for aforoApolloPlugin(). */
export interface AforoApolloPluginOptions extends AforoGraphQlIntegrationOptions {
  /**
   * Explicit execution status for a request, overriding the value derived
   * from the GraphQL response. Receives Apollo's request context. Return
   * undefined (or blank) to keep the derived value. Must be synchronous; an
   * unknown value or a Promise is reported through `onError` and the derived
   * value is kept.
   */
  executionStatus?: (requestContext: any) => string | undefined;
}

/** Response bodies larger than this are not buffered for status derivation. */
const MAX_CAPTURED_RESPONSE_BYTES = 1024 * 1024;

export class AforoGraphQlBilling {
  private readonly config: Required<
    Pick<AforoGraphQlConfig, 'tenantId' | 'productId' | 'apiKey' | 'ingestorUrl'>
  >;
  private readonly schemaVersion?: string;
  private readonly productType: string;
  private readonly flushCount: number;
  private readonly flushIntervalMs: number;
  private readonly onError: (error: Error) => void;
  private readonly onDrop?: (events: GraphQlUsageEvent[], reason: DropReason) => void;
  private readonly customerIdExtractor: (context: unknown) => string | undefined;
  private readonly complexityScorer: NonNullable<AforoGraphQlConfig['complexityScorer']>;

  private buffer: GraphQlUsageEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dropped = 0;
  /** Invalid-event count per field, for WARN throttling. */
  private readonly invalidSeen = new Map<string, number>();
  /** Request-derived labels already reported as truncated (one WARN per label). */
  private readonly truncationWarned = new Set<string>();

  constructor(config: AforoGraphQlConfig) {
    this.config = {
      tenantId: config.tenantId,
      productId: config.productId,
      apiKey: config.apiKey,
      ingestorUrl: config.ingestorUrl,
    };
    this.schemaVersion = config.schemaVersion;
    this.productType = normalizeProductType(config.productType) ?? DEFAULT_PRODUCT_TYPE;
    this.flushCount = config.flushCount ?? 50;
    this.flushIntervalMs = config.flushIntervalMs ?? 5000;
    this.onError = config.onError ?? ((err) => console.error('[aforo-graphql]', err.message));
    this.onDrop = config.onDrop;
    this.customerIdExtractor = config.customerIdExtractor ?? defaultCustomerExtractor;
    this.complexityScorer = config.complexityScorer ?? defaultComplexityScorer;
    this.startTimer();
  }

  /** Record a single GraphQL operation. Called by plugins/middleware or directly. */
  record(args: RecordArgs): void {
    // No customer resolved — not billable, not a drop.
    if (typeof args.customerId !== 'string' || !args.customerId.trim()) return;

    const doc = typeof args.query === 'string' ? safeParse(args.query) : args.query;
    if (!doc) return;

    const op = findOperation(doc, args.operationName ?? undefined);
    if (!op) return;

    const { complexity, fieldCount } = this.complexityScorer(doc, op.name?.value);

    const now = new Date();
    // The operation name is read from the incoming query. The idempotency key
    // is built from the full name; the label on the event is cut to the
    // ingestor's limit so an over-long name cannot make the call unbilled.
    const fullOpName = op.name?.value ?? 'anonymous';
    const opName = this.requestLabel('gqlOperationName', fullOpName, MAX_GQL_OPERATION_NAME);
    const event: GraphQlUsageEvent = {
      customerId: args.customerId,
      metricName: 'graphql_api.operations',
      quantity: 1,
      occurredAt: now.toISOString(),
      // Minted once, here, from the untruncated operation name. When the name
      // makes the key longer than the ingestor allows, the name is replaced by
      // its SHA-256 digest; the key itself is never cut.
      idempotencyKey: boundedIdempotencyKey(
        `gql:${this.config.tenantId}:${this.config.productId}:`,
        fullOpName,
        `:${now.getTime()}:${randomSuffix()}`,
      ),
      productType: normalizeProductType(args.productType) ?? this.productType,
      gqlOperationType: (op.operation.toUpperCase() as GraphQlUsageEvent['gqlOperationType']),
      gqlOperationName: opName,
      gqlComplexity: complexity,
      gqlFieldCount: fieldCount,
      // When the GraphQL response is known it decides the flag, with the same
      // rule the derived status uses, so the two can't disagree.
      gqlHasErrors: isGraphQlResult(args.response) ? graphQlErrorsPresent(args.response.errors) : args.hasErrors,
      dataBytes: args.responseBytes,
      executionDurationMs: Math.round(args.durationMs),
      metadata: {
        sdkVersion: SDK_VERSION,
        productId: this.config.productId,
        ...(this.schemaVersion ? { schemaVersion: this.schemaVersion } : {}),
      },
    };
    // An explicit value the ingestor wouldn't accept is reported and ignored:
    // the derived status is used when one can be derived, otherwise the key is
    // omitted (same rule as the Go and MCP SDKs).
    const explicit = checkExecutionStatus(args.executionStatus);
    if (explicit.problem) this.reportError(new Error(`[aforo-graphql] ${explicit.problem}`));
    const executionStatus =
      explicit.status ??
      (args.response ? outcomeFromGraphQlResponse(args.response) : undefined) ??
      outcomeFromHttpStatus(args.httpStatus);
    if (executionStatus) event.executionStatus = executionStatus;

    // An event the ingestor would reject is not sent (one bad event fails its
    // whole batch): it is dropped here with reason 'invalid', never thrown
    // into the request path.
    const invalid =
      tooLong('customerId', event.customerId, MAX_CUSTOMER_ID) ??
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
   * Express/Connect middleware for graphql-http, express-graphql, or any HTTP GraphQL server.
   *
   * executionStatus: when the whole response body is a JSON GraphQL result
   * (up to 1 MiB), it is derived from that body; otherwise from the HTTP
   * status. `options.executionStatus` overrides both.
   */
  middleware(options: GraphQlMiddlewareOptions = {}) {
    return (req: any, res: any, next: (err?: any) => void) => {
      const start = Date.now();
      const originalEnd = res.end.bind(res);
      let responseBytes = 0;
      let sawErrors = false;
      let captured: Buffer[] | null = [];
      let capturedBytes = 0;
      const capture = (chunk: any, encoding?: any) => {
        if (!captured || chunk == null) return;
        let buf: Buffer | null = null;
        if (typeof chunk === 'string') {
          buf = Buffer.from(chunk, typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8');
        } else if (chunk instanceof Uint8Array) {
          buf = Buffer.from(chunk);
        }
        if (!buf) return;
        capturedBytes += buf.length;
        if (capturedBytes > MAX_CAPTURED_RESPONSE_BYTES) {
          captured = null; // too large — fall back to the HTTP status
          return;
        }
        captured.push(buf);
      };

      const originalWrite = res.write?.bind(res);
      if (originalWrite) {
        res.write = (chunk: any, ...rest: any[]) => {
          if (chunk) responseBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length ?? 0;
          capture(chunk, rest[0]);
          return originalWrite(chunk, ...rest);
        };
      }

      res.end = (chunk: any, ...rest: any[]) => {
        if (chunk) responseBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length ?? 0;
        try {
          capture(chunk, rest[0]);
          const body = req.body ?? {};
          const query = body.query as string | undefined;
          if (query) {
            sawErrors = res.statusCode >= 400;
            const customerId = this.customerIdExtractor(req);
            if (customerId) {
              let explicit: string | undefined;
              try {
                explicit = options.executionStatus?.(req, res);
              } catch {
                explicit = undefined; // a resolver bug must never break the response
              }
              this.record({
                customerId,
                query,
                operationName: body.operationName,
                durationMs: Date.now() - start,
                hasErrors: sawErrors,
                responseBytes,
                executionStatus: explicit,
                response: captured ? parseGraphQlResponse(Buffer.concat(captured)) : undefined,
                httpStatus: res.statusCode,
                productType: options.productType,
              });
            }
          }
        } catch {
          // Never fail the response due to metering
        }
        return originalEnd(chunk, ...rest);
      };

      next();
    };
  }

  /**
   * Bound a label the SDK read off the incoming query to the ingestor's limit.
   * The event is still sent; one WARN per label name per client. Values the
   * SDK caller sets are never passed through here — an over-long one drops the
   * event as 'invalid'.
   */
  private requestLabel(field: string, value: string, max: number): string {
    if (typeof value !== 'string' || value.length <= max) return value;
    if (!this.truncationWarned.has(field)) {
      this.truncationWarned.add(field);
      console.warn(
        `[aforo-graphql] ${field} taken from the query was longer than the ingestor's limit and was ` +
          `truncated to ${max} characters; the event is still sent. Logged once per label.`,
      );
    }
    return truncateToLimit(value, max);
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const pending = this.buffer.splice(0, this.buffer.length);
    // The ingestor accepts at most MAX_BATCH_EVENTS events per request.
    for (let i = 0; i < pending.length; i += MAX_BATCH_EVENTS) {
      await this.send(pending.slice(i, i + MAX_BATCH_EVENTS));
    }
  }

  private async send(batch: GraphQlUsageEvent[]): Promise<void> {
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
          this.reportError(new Error(`GraphQL metering batch rejected with HTTP ${res.status}${details ? ` — ${details}` : ''} (dropped ${batch.length} events, not retried)`));
          return;
        }
        delayMs = parseRetryAfter(res) ?? delayMs;
      } else if (attempt === maxRetries) {
        this.recordDrop(batch, 'retry_exhausted');
        this.reportError(networkError ?? new Error('GraphQL metering request failed'));
        return;
      }
      if (attempt < maxRetries) await sleep(delayMs);
    }
    // Not re-queued: dropping avoids unbounded memory growth.
    this.recordDrop(batch, 'retry_exhausted');
    this.reportError(new Error(`GraphQL metering flush failed after ${maxRetries} attempts (dropped ${batch.length} events)`));
  }

  /**
   * A 2xx can still carry per-event rejections:
   * `{accepted, duplicates, failed, errors:[{index, message}]}`. Events the
   * response names by index are dropped with reason 'rejected'; a `failed`
   * count the response does not attribute to an index is counted only.
   */
  private async handlePartialFailures(res: Response, batch: GraphQlUsageEvent[]): Promise<void> {
    const { failed, details, indexes } = await readBatchResult(res, batch.length);
    if (failed <= 0) return;
    if (indexes.length > 0) this.recordDrop(indexes.map((i) => batch[i]), 'rejected');
    const unattributed = Math.min(failed, batch.length) - indexes.length;
    if (unattributed > 0) {
      this.dropped += unattributed;
      console.warn(
        `[aforo-graphql] Dropped ${unattributed} event(s) — rejected, not identified by the ingestor (${this.dropped} total dropped).`,
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
  private recordDrop(events: GraphQlUsageEvent[], reason: DropReason): void {
    this.dropped += events.length;
    console.warn(
      `[aforo-graphql] Dropped ${events.length} event(s) — ${reason} (${this.dropped} total dropped).`,
    );
    this.notifyDrop(events, reason);
  }

  /**
   * Account for an event that failed a client-side check: never buffered,
   * never sent. Runs on the hot path, so the WARN is throttled per field
   * (first occurrence, then every 1000th).
   */
  private recordInvalid(event: GraphQlUsageEvent, invalid: InvalidField): void {
    this.dropped += 1;
    const seen = (this.invalidSeen.get(invalid.field) ?? 0) + 1;
    this.invalidSeen.set(invalid.field, seen);
    if (seen === 1 || seen % 1000 === 0) {
      console.warn(
        `[aforo-graphql] Dropped 1 event — invalid: ${invalid.problem} ` +
          `(${seen} for ${invalid.field}, ${this.dropped} total dropped).`,
      );
    }
    this.notifyDrop([event], 'invalid');
  }

  private notifyDrop(events: GraphQlUsageEvent[], reason: DropReason): void {
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

// ── Apollo Server plugin ─────────────────────────────────────────

/** Apollo Server 4 plugin that records every operation through the billing instance. */
export function aforoApolloPlugin(billing: AforoGraphQlBilling, options: AforoApolloPluginOptions = {}): {
  requestDidStart: () => Promise<{
    willSendResponse: (rc: any) => Promise<void>;
  }>;
} {
  return {
    async requestDidStart() {
      const start = Date.now();
      return {
        async willSendResponse(rc: any) {
          try {
            const query = rc.request?.query as string | undefined;
            if (!query) return;
            const contextValue = rc.contextValue ?? rc.context ?? {};
            const customerIdExtractor = (billing as any).customerIdExtractor as (ctx: unknown) => string | undefined;
            const customerId = customerIdExtractor(contextValue);
            if (!customerId) return;
            const result = rc.response?.body?.singleResult ?? rc.response?.body?.initialResult;
            const errors = (result?.errors || rc.errors) ?? [];
            let explicit: string | undefined;
            try {
              explicit = options.executionStatus?.(rc);
            } catch {
              explicit = undefined; // a resolver bug must never break the response
            }
            billing.record({
              customerId,
              query,
              operationName: rc.request?.operationName,
              durationMs: Date.now() - start,
              hasErrors: graphQlErrorsPresent(errors),
              executionStatus: explicit,
              // Spread keeps `data` absent when Apollo omitted it (request
              // failed before execution) so it derives VALIDATION_FAILED.
              response: result
                ? { ...result, errors: result.errors ?? (graphQlErrorsPresent(errors) ? errors : undefined) }
                : graphQlErrorsPresent(errors)
                  ? { errors }
                  : undefined,
              httpStatus: rc.response?.http?.status,
              productType: options.productType,
            });
          } catch {
            // Never fail the response due to metering
          }
        },
      };
    },
  };
}

// ── Default complexity scorer ─────────────────────────────────────

export function defaultComplexityScorer(doc: DocumentNode, _operationName?: string) {
  let fieldCount = 0;
  let maxDepth = 0;
  let currentDepth = 0;
  visit(doc, {
    Field: {
      enter() {
        fieldCount++;
        currentDepth++;
        if (currentDepth > maxDepth) maxDepth = currentDepth;
      },
      leave() {
        currentDepth--;
      },
    },
  });
  return { complexity: fieldCount + 5 * maxDepth, fieldCount };
}

function defaultCustomerExtractor(ctx: unknown): string | undefined {
  const c = ctx as any;
  const fromHeader =
    c?.req?.headers?.['x-customer-id'] ??
    c?.request?.http?.headers?.get?.('x-customer-id') ??
    c?.headers?.['x-customer-id'];
  if (Array.isArray(fromHeader)) return fromHeader[0];
  if (typeof fromHeader === 'string') return fromHeader;
  return c?.customerId;
}

// ── Execution status ─────────────────────────────────────────────

/**
 * Derive an execution status from a GraphQL response:
 *   - no `errors` (absent, null or empty array)          → SUCCESS
 *     (any other `errors` value — a non-array object or
 *     string from a non-conforming server — counts as errors)
 *   - `errors` + non-null `data`                          → PARTIAL
 *   - `errors` + `data` present and null (failed during
 *     execution)                                          → ERROR
 *   - `errors` + `data` absent (failed before execution:
 *     parse or validation errors)                         → VALIDATION_FAILED
 * An object with neither `data` nor `errors` is not a GraphQL result and
 * derives nothing (undefined).
 */
export function outcomeFromGraphQlResponse(response: GraphQlResponseShape): string | undefined {
  if (!isGraphQlResult(response)) return undefined;
  const hasData = response.data !== undefined;
  if (!graphQlErrorsPresent(response.errors)) return 'SUCCESS';
  if (!hasData) return 'VALIDATION_FAILED';
  return response.data === null ? 'ERROR' : 'PARTIAL';
}

/**
 * Whether a GraphQL `errors` value means the response had errors: anything
 * other than undefined, null or an empty array (a non-array object or string
 * from a non-conforming server counts). Drives both gqlHasErrors and the
 * derived executionStatus.
 */
function graphQlErrorsPresent(errors: unknown): boolean {
  return errors !== undefined && errors !== null && !(Array.isArray(errors) && errors.length === 0);
}

/** A GraphQL result has a `data` or an `errors` key; anything else derives nothing. */
function isGraphQlResult(response: GraphQlResponseShape | undefined): response is GraphQlResponseShape {
  return !!response && typeof response === 'object' && (response.data !== undefined || response.errors !== undefined);
}

/**
 * Derive an execution status from an HTTP status when no GraphQL response
 * body is available: 2xx/3xx SUCCESS, 408/504 TIMEOUT, 499 CANCELLED,
 * 400/422 VALIDATION_FAILED, 401/403/429 BLOCKED, other 4xx/5xx ERROR,
 * anything else undefined (key omitted).
 */
export function outcomeFromHttpStatus(status: number | undefined): string | undefined {
  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined;
  if (status >= 200 && status < 400) return 'SUCCESS';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 499) return 'CANCELLED';
  if (status === 400 || status === 422) return 'VALIDATION_FAILED';
  if (status === 401 || status === 403 || status === 429) return 'BLOCKED';
  if (status >= 400 && status < 600) return 'ERROR';
  return undefined;
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

/** Parse a captured body as a GraphQL result; anything else → undefined. */
function parseGraphQlResponse(buf: Buffer): GraphQlResponseShape | undefined {
  if (buf.length === 0) return undefined;
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && ('data' in parsed || 'errors' in parsed)) {
      return parsed as GraphQlResponseShape;
    }
  } catch {
    // not JSON — fall back to the HTTP status
  }
  return undefined;
}

// ── Helpers ──────────────────────────────────────────────────────

function safeParse(query: string): DocumentNode | null {
  try {
    return parse(query);
  } catch {
    return null;
  }
}

function findOperation(doc: DocumentNode, operationName?: string): OperationDefinitionNode | null {
  const ops = doc.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION
  );
  if (operationName) return ops.find((o) => o.name?.value === operationName) ?? ops[0] ?? null;
  return ops[0] ?? null;
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

/** Limits mirror the ingestor's IngestUsageEventRequest; a value the caller set is never truncated. */
function tooLong(field: string, value: unknown, max: number): InvalidField | undefined {
  if (typeof value !== 'string' || value.length <= max) return undefined;
  return { field, problem: `${field} is ${value.length} chars, limit ${max}: ${preview(value)}` };
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
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The ingestor wraps every 2xx JSON body in `{success, data, meta}`. Returns
 * the inner `data` object when present, else the body unchanged (bare shape).
 */
function unwrapEnvelope(body: any): any {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? body.data : undefined;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : body;
}
