/**
 * @aforoai/graphql-metering — Aforo GraphQL Metering SDK
 *
 * Computes per-operation complexity using the GraphQL AST, captures the
 * operation type/name, and forwards billing events to Aforo's usage
 * ingestor. Exposes:
 *   - Apollo Server plugin: aforoApolloPlugin(billing)
 *   - Express middleware:   billing.middleware()  (for graphql-http, express-graphql, etc.)
 *   - Low-level record() for custom servers
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
 *     // Who is billed: from identity your server verified (session, checked token).
 *     customerResolver: (context) => context.user?.aforoCustomerId,
 *     // productType defaults to 'GRAPHQL_API'
 *   });
 *
 *   const server = new ApolloServer({
 *     typeDefs, resolvers,
 *     plugins: [aforoApolloPlugin(billing)],
 *   });
 *
 *   // The SDK installs no signal handlers. Flush from your own:
 *   process.once('SIGTERM', async () => { await billing.shutdown(); process.exit(0); });
 */

import { createHash } from 'node:crypto';
import { TransportCore, CoreDropReason } from './transport-core/core';

/** What onError receives for delivery problems: branch on `kind`, read `events`. */
export { CoreTransportError, type CoreErrorKind } from './transport-core/core';
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
  /**
   * Who is billed for an operation, from identity your server verified (a
   * session, a checked token). Receives the Express request for
   * `middleware()` and Apollo's `contextValue` for `aforoApolloPlugin()`.
   * Required unless `trustCustomerHeader` is true. Returning nothing (or
   * throwing) drops that operation's event as 'invalid' (counted); the
   * response is never affected.
   */
  customerResolver?: (context: any) => string | undefined | null;
  /** @deprecated Use `customerResolver` (same signature). */
  customerIdExtractor?: (context: any) => string | undefined | null;
  /**
   * Bill the `x-customer-id` request header. Any client can send it, so only
   * turn this on behind a proxy you control that sets it. Default false; the
   * constructor throws when neither this nor `customerResolver` is given.
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
  /** Override the complexity scorer. Default: fieldCount + 5 × depth. */
  complexityScorer?: (doc: DocumentNode, operationName?: string) => { complexity: number; fieldCount: number };
  /** Events per request (default 500, max 1000). Reaching it wakes the background sender. */
  flushCount?: number;
  /** The background sender also runs this often, in ms (default 5000). */
  flushIntervalMs?: number;
  /** Callback for delivery problems (rejected batches, outages), resolver errors and bad executionStatus values. */
  onError?: (error: Error) => void;
  /**
   * Opt-in hook receiving events that were permanently dropped (see
   * DropReason). Events keep their idempotency keys,
   * so persisting and re-submitting them after recovery is dedup-safe.
   * Exceptions thrown by the hook are swallowed. Default: none (drops are
   * still counted in droppedCount and WARN-logged).
   */
  onDrop?: (events: GraphQlUsageEvent[], reason: DropReason) => void;
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
export const DEFAULT_PRODUCT_TYPE = 'GRAPHQL_API';
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
  private readonly config: Required<Pick<AforoGraphQlConfig, 'tenantId' | 'productId'>>;
  private readonly schemaVersion?: string;
  private readonly productType: string;
  private readonly onError: (error: Error) => void;
  private readonly resolveCustomer: (context: any) => string | undefined;
  private readonly complexityScorer: NonNullable<AforoGraphQlConfig['complexityScorer']>;
  private readonly core: TransportCore<GraphQlUsageEvent>;
  /** Request-derived labels already reported as truncated (one WARN per label). */
  private readonly truncationWarned = new Set<string>();

  constructor(config: AforoGraphQlConfig) {
    const resolver = config.customerResolver ?? config.customerIdExtractor;
    const trustHeader = config.trustCustomerHeader === true;
    if (typeof resolver !== 'function' && !trustHeader) {
      throw new Error(
        '[aforo-graphql] AforoGraphQlBilling needs a customerResolver: (context) => the Aforo customer id from ' +
          'identity your server verified. To bill the x-customer-id header instead — only safe behind a proxy that ' +
          'sets it — pass trustCustomerHeader: true.',
      );
    }
    this.config = {
      tenantId: config.tenantId,
      productId: config.productId,
    };
    this.schemaVersion = config.schemaVersion;
    this.productType = normalizeProductType(config.productType) ?? DEFAULT_PRODUCT_TYPE;
    this.onError = config.onError ?? ((err) => console.error('[aforo-graphql]', err.message));
    this.resolveCustomer = (context: any) => {
      const fromResolver = typeof resolver === 'function' ? textOrUndefined(resolver(context)) : undefined;
      if (fromResolver) return fromResolver;
      return trustHeader ? textOrUndefined(headerCustomerId(context)) : undefined;
    };
    this.complexityScorer = config.complexityScorer ?? defaultComplexityScorer;
    const onDrop = config.onDrop;
    // The core is the only holder of the API key.
    this.core = new TransportCore<GraphQlUsageEvent>({
      baseUrl: config.ingestorUrl,
      apiKey: config.apiKey,
      allowInsecureHttp: config.allowInsecureHttp,
      compression: config.compression,
      headers: { 'X-Tenant-Id': config.tenantId },
      userAgent: `aforo-graphql-metering/${SDK_VERSION}`,
      flushCount: config.flushCount,
      flushIntervalMs: config.flushIntervalMs,
      maxQueueSize: config.maxQueueSize,
      maxRetries: config.maxRetries,
      timeoutMs: config.timeoutMs,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      flushOnExit: config.flushOnExit,
      logPrefix: '[aforo-graphql]',
      onError: (err) => this.reportError(err),
      onDrop: onDrop ? (events, reason: CoreDropReason) => onDrop(events, reason as DropReason) : undefined,
    });
  }

  /**
   * @internal The customer for a request context ('' when there is none). A
   * resolver that throws is reported through onError and counts as none.
   */
  customerFor(context: unknown): string {
    try {
      return this.resolveCustomer(context) ?? '';
    } catch (err) {
      this.reportError(new Error(`[aforo-graphql] customerResolver threw: ${(err as Error)?.message ?? err}`));
      return '';
    }
  }

  /** Record a single GraphQL operation. Called by plugins/middleware or directly. */
  record(args: RecordArgs): void {
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
      customerId: typeof args.customerId === 'string' ? args.customerId : '',
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
      (!event.customerId.trim()
        ? { field: 'customerId', problem: 'no customer: the customer resolver returned nothing; the operation is not metered' }
        : undefined) ??
      tooLong('customerId', event.customerId, MAX_CUSTOMER_ID) ??
      tooLong('productType', event.productType, MAX_PRODUCT_TYPE);
    if (invalid) {
      this.core.reportDrop([event], 'invalid', invalid.problem);
      return;
    }

    // Queue only; the core's single background sender does the HTTP.
    this.core.enqueue(event);
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
        try {
          if (chunk && typeof chunk !== 'function') {
            responseBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length ?? 0;
            capture(chunk, typeof rest[0] === 'string' ? rest[0] : undefined);
          }
        } catch (err) {
          console.debug('[aforo-graphql] response capture failed', err);
        }
        // Send the response first; parse and meter afterwards, off the response path.
        const result = originalEnd(chunk, ...rest);
        const durationMs = Date.now() - start;
        const parts = captured;
        setImmediate(() => {
          try {
            const body = req.body ?? {};
            const query = body.query as string | undefined;
            if (!query) return;
            let explicit: string | undefined;
            try {
              explicit = options.executionStatus?.(req, res);
            } catch {
              explicit = undefined; // a resolver bug must never break metering
            }
            this.record({
              customerId: this.customerFor(req),
              query,
              operationName: body.operationName,
              durationMs,
              hasErrors: res.statusCode >= 400,
              responseBytes,
              executionStatus: explicit,
              response: parts ? parseGraphQlResponse(Buffer.concat(parts)) : undefined,
              httpStatus: res.statusCode,
              productType: options.productType,
            });
          } catch (err) {
            // Never let metering affect the server.
            this.reportError(new Error(`[aforo-graphql] metering failed: ${(err as Error)?.message ?? err}`));
          }
        });
        return result;
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

  /** Invoke onError; a hook bug must never break metering or flushing. */
  private reportError(err: Error): void {
    try {
      this.onError(err);
    } catch (hookErr) {
      console.debug('[aforo-graphql] onError hook threw', hookErr);
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

  /**
   * Send what is queued now and wait for it (one request at a time; never
   * concurrent). Operations whose response already went out are metered on the
   * next turn of the event loop, so this waits one turn first to include them.
   */
  async flush(): Promise<{ sent: number; failed: number; requeued: number; queued: number }> {
    await new Promise((resolve) => setImmediate(resolve));
    return this.core.flush();
  }

  /**
   * Stop accepting events and send what is queued, for at most
   * `shutdownTimeoutMs`. Events still queued then are dropped with reason
   * 'shutdown' (counted, passed to onDrop). Call it from your SIGTERM handler.
   */
  async shutdown(): Promise<void> {
    // Let operations whose response already went out be recorded first.
    await new Promise((resolve) => setImmediate(resolve));
    await this.core.shutdown();
  }

  toJSON(): Record<string, unknown> {
    return { tenantId: this.config.tenantId, productId: this.config.productId, queued: this.queuedCount, dropped: this.droppedCount };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `AforoGraphQlBilling { tenantId: '${this.config.tenantId}', productId: '${this.config.productId}', queued: ${this.queuedCount}, dropped: ${this.droppedCount} }`;
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
          // Recorded after the response goes out: willSendResponse only reads
          // what it needs, and parsing/queueing runs on the next turn.
          let snapshot: (() => void) | undefined;
          try {
            const query = rc.request?.query as string | undefined;
            if (!query) return;
            const contextValue = rc.contextValue ?? rc.context ?? {};
            const result = rc.response?.body?.singleResult ?? rc.response?.body?.initialResult;
            const errors = (result?.errors || rc.errors) ?? [];
            const durationMs = Date.now() - start;
            const operationName = rc.request?.operationName;
            const httpStatus = rc.response?.http?.status;
            snapshot = () => {
              let explicit: string | undefined;
              try {
                explicit = options.executionStatus?.(rc);
              } catch {
                explicit = undefined; // a resolver bug must never break metering
              }
              billing.record({
                customerId: billing.customerFor(contextValue),
                query,
                operationName,
                durationMs,
                hasErrors: graphQlErrorsPresent(errors),
                executionStatus: explicit,
                // Spread keeps `data` absent when Apollo omitted it (request
                // failed before execution) so it derives VALIDATION_FAILED.
                response: result
                  ? { ...result, errors: result.errors ?? (graphQlErrorsPresent(errors) ? errors : undefined) }
                  : graphQlErrorsPresent(errors)
                    ? { errors }
                    : undefined,
                httpStatus,
                productType: options.productType,
              });
            };
          } catch (err) {
            console.debug('[aforo-graphql] Apollo metering skipped', err);
            return;
          }
          const run = snapshot;
          setImmediate(() => {
            try {
              run();
            } catch (err) {
              console.debug('[aforo-graphql] Apollo metering failed', err);
            }
          });
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

/**
 * The x-customer-id header from an Express request or an Apollo context
 * (`req.headers`, `request.http.headers`, or a `headers` map). Read only
 * with `trustCustomerHeader: true`.
 */
function headerCustomerId(ctx: unknown): string | undefined {
  const c = ctx as any;
  const fromHeader =
    c?.headers?.['x-customer-id'] ??
    c?.req?.headers?.['x-customer-id'] ??
    c?.request?.http?.headers?.get?.('x-customer-id') ??
    c?.request?.headers?.get?.('x-customer-id');
  if (Array.isArray(fromHeader)) return fromHeader[0];
  return typeof fromHeader === 'string' ? fromHeader : undefined;
}

function textOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
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
