/**
 * @aforo/graphql-metering — Aforo GraphQL Metering SDK
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
 *   import { AforoGraphQlBilling, aforoApolloPlugin } from '@aforo/graphql-metering';
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
}

const SDK_VERSION = '1.0.0';
/** Default top-level `productType` for this SDK. */
export const DEFAULT_PRODUCT_TYPE = 'GRAPHQL_API';
/** Upper bound on a server-requested Retry-After wait. */
const MAX_RETRY_AFTER_MS = 30_000;
/** The ingestor rejects batch requests with more than 1000 events. */
const MAX_BATCH_EVENTS = 1000;
/** usage-ingestor limits (IngestUsageEventRequest). */
const MAX_CUSTOMER_ID = 64;
const MAX_IDEMPOTENCY_KEY = 255;

interface GraphQlUsageEvent {
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
}

interface RecordArgs {
  customerId: string;
  query: string | DocumentNode;
  operationName?: string | null;
  durationMs: number;
  hasErrors: boolean;
  responseBytes?: number;
  /** Per-event product type override. Default: the client-level `productType`. */
  productType?: string;
}

/** Per-integration options for `middleware()` and `aforoApolloPlugin()`. */
export interface AforoGraphQlIntegrationOptions {
  /** Product type for events recorded by this integration. Default: the client-level `productType`. */
  productType?: string;
}

export class AforoGraphQlBilling {
  private readonly config: Required<
    Pick<AforoGraphQlConfig, 'tenantId' | 'productId' | 'apiKey' | 'ingestorUrl'>
  >;
  private readonly schemaVersion?: string;
  private readonly productType: string;
  private readonly flushCount: number;
  private readonly flushIntervalMs: number;
  private readonly onError: (error: Error) => void;
  private readonly customerIdExtractor: (context: unknown) => string | undefined;
  private readonly complexityScorer: NonNullable<AforoGraphQlConfig['complexityScorer']>;

  private buffer: GraphQlUsageEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

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
    this.customerIdExtractor = config.customerIdExtractor ?? defaultCustomerExtractor;
    this.complexityScorer = config.complexityScorer ?? defaultComplexityScorer;
    this.startTimer();
  }

  /** Record a single GraphQL operation. Called by plugins/middleware or directly. */
  record(args: RecordArgs): void {
    if (!args.customerId || !args.customerId.trim()) return;
    if (args.customerId.length > MAX_CUSTOMER_ID) {
      this.onError(new Error(`GraphQL metering: customerId longer than ${MAX_CUSTOMER_ID} chars; event dropped`));
      return;
    }

    const doc = typeof args.query === 'string' ? safeParse(args.query) : args.query;
    if (!doc) return;

    const op = findOperation(doc, args.operationName ?? undefined);
    if (!op) return;

    const { complexity, fieldCount } = this.complexityScorer(doc, op.name?.value);

    const now = new Date();
    const opName = (op.name?.value ?? 'anonymous').slice(0, 255);
    const event: GraphQlUsageEvent = {
      customerId: args.customerId,
      metricName: 'graphql_api.operations',
      quantity: 1,
      occurredAt: now.toISOString(),
      // Tail-trimmed to the ingestor's limit, keeping the unique millis:random suffix.
      idempotencyKey: `gql:${this.config.tenantId}:${this.config.productId}:${opName}:${now.getTime()}:${randomSuffix()}`.slice(-MAX_IDEMPOTENCY_KEY),
      productType: normalizeProductType(args.productType) ?? this.productType,
      gqlOperationType: (op.operation.toUpperCase() as GraphQlUsageEvent['gqlOperationType']),
      gqlOperationName: opName,
      gqlComplexity: complexity,
      gqlFieldCount: fieldCount,
      gqlHasErrors: args.hasErrors,
      dataBytes: args.responseBytes,
      executionDurationMs: Math.round(args.durationMs),
      metadata: {
        sdkVersion: SDK_VERSION,
        productId: this.config.productId,
        ...(this.schemaVersion ? { schemaVersion: this.schemaVersion } : {}),
      },
    };

    this.buffer.push(event);
    if (this.buffer.length >= this.flushCount) {
      void this.flush();
    }
  }

  /** Express/Connect middleware for graphql-http, express-graphql, or any HTTP GraphQL server. */
  middleware(options: AforoGraphQlIntegrationOptions = {}) {
    return (req: any, res: any, next: (err?: any) => void) => {
      const start = Date.now();
      const originalEnd = res.end.bind(res);
      let responseBytes = 0;
      let sawErrors = false;

      const originalWrite = res.write?.bind(res);
      if (originalWrite) {
        res.write = (chunk: any, ...rest: any[]) => {
          if (chunk) responseBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length ?? 0;
          return originalWrite(chunk, ...rest);
        };
      }

      res.end = (chunk: any, ...rest: any[]) => {
        if (chunk) responseBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length ?? 0;
        try {
          const body = req.body ?? {};
          const query = body.query as string | undefined;
          if (query) {
            sawErrors = res.statusCode >= 400;
            const customerId = this.customerIdExtractor(req);
            if (customerId) {
              this.record({
                customerId,
                query,
                operationName: body.operationName,
                durationMs: Date.now() - start,
                hasErrors: sawErrors,
                responseBytes,
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
      let delayMs = Math.pow(2, attempt - 1) * 1000;
      try {
        const res = await fetch(this.config.ingestorUrl.replace(/\/$/, '') + '/v1/ingest/batch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.config.apiKey,
            'X-Tenant-Id': this.config.tenantId,
          },
          body,
        });
        if (res.ok) {
          await this.reportPartialFailures(res);
          return;
        }
        if (!isRetryableStatus(res.status)) {
          const { details } = await readErrorMessages(res);
          this.onError(new Error(`GraphQL metering batch rejected with HTTP ${res.status}${details ? ` — ${details}` : ''} (dropped ${batch.length} events, not retried)`));
          return;
        }
        delayMs = parseRetryAfter(res) ?? delayMs;
      } catch (err) {
        if (attempt === maxRetries) {
          this.onError(err as Error);
          return;
        }
      }
      if (attempt < maxRetries) await sleep(delayMs);
    }
    this.onError(new Error(`GraphQL metering flush failed after ${maxRetries} attempts (dropped ${batch.length} events)`));
  }

  /** A 202 can still carry per-event rejections: `{accepted, duplicates, failed, errors:[{index, message}]}`. */
  private async reportPartialFailures(res: Response): Promise<void> {
    const { failed, details } = await readErrorMessages(res);
    if (failed && failed > 0) {
      this.onError(new Error(`Aforo ingestor rejected ${failed} event(s)${details ? ` — ${details}` : ''}`));
    }
  }

  private startTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => { void this.flush(); }, this.flushIntervalMs);
    // Unref so the background timer never blocks host-process exit (final flush still needs shutdown()).
    if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      this.flushTimer.unref();
    }
    if (typeof (this.flushTimer as any).unref === 'function') (this.flushTimer as any).unref();
  }

  /** Flush buffered events and stop timer. Call before process exit. */
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
export function aforoApolloPlugin(billing: AforoGraphQlBilling, options: AforoGraphQlIntegrationOptions = {}): {
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
            const errors = (rc.response?.body?.singleResult?.errors || rc.errors) ?? [];
            billing.record({
              customerId,
              query,
              operationName: rc.request?.operationName,
              durationMs: Date.now() - start,
              hasErrors: Array.isArray(errors) && errors.length > 0,
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

/** Reads the ingestor's `errors[].message` entries (first 5) from a response body, if any. */
async function readErrorMessages(res: Response): Promise<{ failed?: number; details: string }> {
  if (typeof (res as any)?.json !== 'function') return { details: '' };
  try {
    const body: any = await res.json();
    const details = Array.isArray(body?.errors)
      ? body.errors.slice(0, 5).map((e: any) => `#${e?.index}: ${e?.message}`).join('; ')
      : typeof body?.message === 'string' ? body.message : '';
    return { failed: typeof body?.failed === 'number' ? body.failed : undefined, details };
  } catch {
    return { details: '' }; // Non-JSON or empty body — nothing to report.
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
