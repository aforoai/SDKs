/**
 * @aforoai/mqtt-metering — Aforo MQTT Metering SDK
 *
 * Two integration modes:
 *
 *   1. **Broker hook** (preferred) — wrapAedesBroker() attaches to every PUBLISH,
 *      SUBSCRIBE, UNSUBSCRIBE, CONNECT, DISCONNECT event flowing through an
 *      Aedes broker instance. Use this when you operate the broker yourself.
 *
 *   2. **Client proxy** — wrapMqttClient() wraps an mqtt.js client to meter
 *      outbound publishes + inbound deliveries from the client's perspective.
 *      Use this when you consume a third-party broker (AWS IoT, HiveMQ Cloud,
 *      EMQ X Cloud) and need client-side billing.
 *
 * Usage (Aedes broker):
 *   import aedes from 'aedes';
 *   import { AforoMqttBilling } from '@aforoai/mqtt-metering';
 *
 *   const billing = new AforoMqttBilling({
 *     tenantId: 'tenant_acme',
 *     productId: 'prod_mqtt_telemetry',
 *     apiKey: process.env.AFORO_API_KEY!,
 *     ingestorUrl: 'https://api.aforo.ai',
 *     // productType defaults to 'MQTT_BROKER'
 *   });
 *
 *   const broker = aedes();
 *   billing.wrapAedesBroker(broker, {
 *     resolveCustomerId: (clientId) => customerIdLookup(clientId),
 *   });
 */

import { createHash } from 'node:crypto';

export interface AforoMqttConfig {
  tenantId: string;
  productId: string;
  apiKey: string;
  ingestorUrl: string;
  /**
   * Aforo product type sent as top-level `productType` on every event (trimmed + uppercased).
   * Default: `MQTT_BROKER`. Override per integration via `wrapAedesBroker(broker, { productType })` / `wrapMqttClient(client, { productType })`.
   */
  productType?: string;
  /** How many events to buffer before flushing (default 200 — MQTT is very high-volume). */
  flushCount?: number;
  /** Max interval in ms before a partial batch is flushed (default 2000). */
  flushIntervalMs?: number;
  /** Emit one event per fanout delivery in addition to the publish (default false — costly). */
  emitDeliverEvents?: boolean;
  /** Callback for terminal flush failures. */
  onError?: (error: Error) => void;
  /**
   * Opt-in hook receiving events that were permanently dropped (retry
   * exhaustion, a rejection by the ingestor, or a failed client-side check —
   * see DropReason). Events keep their idempotency keys,
   * so persisting and re-submitting them after recovery is dedup-safe.
   * Exceptions thrown by the hook are swallowed. Default: none (drops are
   * still counted in droppedCount and WARN-logged).
   */
  onDrop?: (events: MqttUsageEvent[], reason: DropReason) => void;
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

export interface AedesBrokerOptions {
  /** Map an MQTT client ID to an Aforo customer ID. Required. */
  resolveCustomerId: (clientId: string, username?: string) => string | undefined | Promise<string | undefined>;
  /** Optional per-client metadata (tags, device type). */
  resolveMetadata?: (clientId: string) => Record<string, unknown> | undefined;
  /**
   * Optional outcome of the request (used by OUTCOME_BASED pricing, which bills
   * each event at the weight set for its status). Events without a status bill
   * at full price. Trimmed and upper-cased by the SDK; blank is treated as absent.
   * Accepted values: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED, FAILED,
   * FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED (max 20 chars). Any other
   * value — or a Promise from an async resolver — is reported through `onError`
   * and left off the event (the event is still sent), because the server would
   * reject the event. Resolvers must be synchronous.
   *
   * MQTT packets carry no success/failure signal the broker hook sees, so the
   * SDK never derives one: pass a fixed string, or a function called for each
   * event (with the MQTT client ID) that returns the status or undefined.
   */
  executionStatus?: string | ((event: MqttUsageEvent, clientId: string) => string | undefined);
  /** Product type for events from this broker. Default: the client-level `productType`. */
  productType?: string;
}

export interface MqttClientOptions {
  /** Customer ID to attribute all traffic on this client to. */
  customerId: string;
  /** Fixed client identifier (defaults to mqtt.js connection options.clientId). */
  clientId?: string;
  /**
   * Optional outcome of the request (used by OUTCOME_BASED pricing, which bills
   * each event at the weight set for its status). Events without a status bill
   * at full price. Trimmed and upper-cased by the SDK; blank is treated as absent.
   * Accepted values: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED, FAILED,
   * FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED (max 20 chars). Any other
   * value — or a Promise from an async resolver — is reported through `onError`
   * and left off the event (the event is still sent), because the server would
   * reject the event. Resolvers must be synchronous.
   *
   * Never derived by the SDK (publishes are metered before the broker
   * acknowledges them): pass a fixed string, or a function called for each
   * event that returns the status or undefined.
   */
  executionStatus?: string | ((event: MqttUsageEvent) => string | undefined);
  /** Product type for events from this client. Default: the client-level `productType`. */
  productType?: string;
}

type ExecutionStatusOption = string | ((event: MqttUsageEvent) => string | undefined);

const SDK_VERSION = '1.2.2';
/** Default top-level `productType` for this SDK. */
export const DEFAULT_PRODUCT_TYPE = 'MQTT_BROKER';
/** Upper bound on a server-requested Retry-After wait. */
const MAX_RETRY_AFTER_MS = 30_000;
/**
 * mqttTopic is required on every MQTT_BROKER event, but CONNECT / DISCONNECT
 * have no topic. These per-client `$SYS/clients/<id>/connected|disconnected`
 * topics stand in for them (`$SYS/` is reserved for the broker by the MQTT
 * spec, so they can never collide with a client topic). Same topics as the
 * Python, Go and Java SDKs.
 */
export const mqttConnectTopic = (clientId: string): string =>
  `$SYS/clients/${clientId || 'unknown'}/connected`;
export const mqttDisconnectTopic = (clientId: string): string =>
  `$SYS/clients/${clientId || 'unknown'}/disconnected`;
/** The ingestor rejects batch requests with more than 1000 events. */
const MAX_BATCH_EVENTS = 1000;
/** usage-ingestor limits (IngestUsageEventRequest). */
const MAX_CUSTOMER_ID = 64;
const MAX_IDEMPOTENCY_KEY = 255;
const MAX_PRODUCT_TYPE = 20;
const MAX_MQTT_TOPIC = 500;
const MAX_MQTT_CLIENT_ID = 128;

type MqttEventType = 'PUBLISH' | 'DELIVER' | 'SUBSCRIBE' | 'UNSUBSCRIBE' | 'CONNECT' | 'DISCONNECT';

export interface MqttUsageEvent {
  customerId: string;
  metricName: string;
  quantity: number;
  occurredAt: string;
  idempotencyKey: string;
  productType: string;
  mqttTopic: string;
  mqttQos: number;
  mqttRetained: boolean;
  mqttEventType: MqttEventType;
  mqttClientId: string;
  dataBytes: number;
  metadata?: Record<string, unknown>;
  /** Normalized (trimmed, upper-cased) execution status; omitted when not set. */
  executionStatus?: string;
}

/** Minimal Aedes broker surface — matches the `aedes` package. */
interface MinimalAedes {
  on(event: 'publish', fn: (packet: any, client: any) => void): void;
  on(event: 'subscribe', fn: (subs: any[] | any, client: any) => void): void;
  on(event: 'unsubscribe', fn: (unsubs: any[] | any, client: any) => void): void;
  on(event: 'client', fn: (client: any) => void): void;
  on(event: 'clientDisconnect', fn: (client: any) => void): void;
}

/** Minimal mqtt.js client surface. */
interface MinimalMqttClient {
  on(event: 'message', fn: (topic: string, payload: Buffer, packet: any) => void): void;
  on(event: 'connect', fn: () => void): void;
  on(event: 'close', fn: () => void): void;
  publish: (topic: string, message: any, opts?: any, cb?: any) => any;
  options?: { clientId?: string };
}

export class AforoMqttBilling {
  private readonly config: Required<
    Pick<AforoMqttConfig, 'tenantId' | 'productId' | 'apiKey' | 'ingestorUrl'>
  >;
  private readonly productType: string;
  private readonly flushCount: number;
  private readonly flushIntervalMs: number;
  private readonly emitDeliverEvents: boolean;
  private readonly onError: (error: Error) => void;

  private readonly onDrop?: (events: MqttUsageEvent[], reason: DropReason) => void;

  private buffer: MqttUsageEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dropped = 0;
  /** Invalid-event count per field, for WARN throttling. */
  private readonly invalidSeen = new Map<string, number>();
  /** Request-derived labels already reported as truncated (one WARN per label). */
  private readonly truncationWarned = new Set<string>();

  constructor(config: AforoMqttConfig) {
    this.config = {
      tenantId: config.tenantId,
      productId: config.productId,
      apiKey: config.apiKey,
      ingestorUrl: config.ingestorUrl,
    };
    this.productType = normalizeProductType(config.productType) ?? DEFAULT_PRODUCT_TYPE;
    this.flushCount = config.flushCount ?? 200;
    this.flushIntervalMs = config.flushIntervalMs ?? 2000;
    this.emitDeliverEvents = config.emitDeliverEvents ?? false;
    this.onError = config.onError ?? ((err) => console.error('[aforo-mqtt]', err.message));
    this.onDrop = config.onDrop;
    this.startTimer();
  }

  // ── Broker-side integration (Aedes) ─────────────────────────────

  wrapAedesBroker(broker: MinimalAedes, options: AedesBrokerOptions): void {
    const resolveCustomer = async (clientId: string, username?: string) =>
      Promise.resolve(options.resolveCustomerId(clientId, username));
    const status = options.executionStatus;
    const brokerStatus = (clientId: string): ExecutionStatusOption | undefined =>
      typeof status === 'function' ? (event) => status(event, clientId) : status;

    broker.on('publish', async (packet: any, client: any) => {
      if (!client) return; // broker-originated publishes skip billing
      const clientId = client.id;
      const customerId = await resolveCustomer(clientId, client.username);
      if (!customerId) return;

      const payload = packet.payload;
      const bytes = estimateBytes(payload);
      this.push({
        customerId,
        mqttTopic: this.topicLabel(packet.topic),
        mqttQos: packet.qos ?? 0,
        mqttRetained: !!packet.retain,
        mqttEventType: 'PUBLISH',
        mqttClientId: this.clientIdLabel(clientId),
        productType: options.productType,
        dataBytes: bytes,
        metadata: options.resolveMetadata?.(clientId),
      }, brokerStatus(clientId), clientId);
    });

    broker.on('subscribe', async (subs: any[] | any, client: any) => {
      const clientId = client?.id;
      if (!clientId) return;
      const customerId = await resolveCustomer(clientId, client.username);
      if (!customerId) return;
      const arr = Array.isArray(subs) ? subs : [subs];
      for (const s of arr) {
        this.push({
          customerId,
          mqttTopic: this.topicLabel(s.topic),
          mqttQos: s.qos ?? 0,
          mqttRetained: false,
          mqttEventType: 'SUBSCRIBE',
          mqttClientId: this.clientIdLabel(clientId),
          productType: options.productType,
          dataBytes: 0,
          metadata: options.resolveMetadata?.(clientId),
        }, brokerStatus(clientId), clientId);
      }
    });

    broker.on('unsubscribe', async (unsubs: any[] | any, client: any) => {
      const clientId = client?.id;
      if (!clientId) return;
      const customerId = await resolveCustomer(clientId, client.username);
      if (!customerId) return;
      const arr = Array.isArray(unsubs) ? unsubs : [unsubs];
      for (const topic of arr) {
        this.push({
          customerId,
          mqttTopic: this.topicLabel(typeof topic === 'string' ? topic : topic?.topic ?? ''),
          mqttQos: 0,
          mqttRetained: false,
          mqttEventType: 'UNSUBSCRIBE',
          mqttClientId: this.clientIdLabel(clientId),
          productType: options.productType,
          dataBytes: 0,
          metadata: options.resolveMetadata?.(clientId),
        }, brokerStatus(clientId), clientId);
      }
    });

    broker.on('client', async (client: any) => {
      const clientId = client.id;
      const customerId = await resolveCustomer(clientId, client.username);
      if (!customerId) return;
      this.push({
        customerId,
        // CONNECT has no topic; mqttTopic is required. Built from the bounded
        // client id so the stand-in topic keeps its `/connected` suffix.
        mqttTopic: mqttConnectTopic(this.clientIdLabel(clientId)),
        mqttQos: 0,
        mqttRetained: false,
        mqttEventType: 'CONNECT',
        mqttClientId: this.clientIdLabel(clientId),
        productType: options.productType,
        dataBytes: 0,
        metadata: options.resolveMetadata?.(clientId),
      }, brokerStatus(clientId), clientId);
    });

    broker.on('clientDisconnect', async (client: any) => {
      const clientId = client.id;
      const customerId = await resolveCustomer(clientId, client.username);
      if (!customerId) return;
      this.push({
        customerId,
        mqttTopic: mqttDisconnectTopic(this.clientIdLabel(clientId)),
        mqttQos: 0,
        mqttRetained: false,
        mqttEventType: 'DISCONNECT',
        mqttClientId: this.clientIdLabel(clientId),
        productType: options.productType,
        dataBytes: 0,
        metadata: options.resolveMetadata?.(clientId),
      }, brokerStatus(clientId), clientId);
    });
  }

  // ── Client-side integration (mqtt.js) ───────────────────────────

  wrapMqttClient(client: MinimalMqttClient, options: MqttClientOptions): void {
    const clientId = options.clientId ?? client.options?.clientId ?? 'mqtt-client';

    client.on('connect', () => {
      this.push({
        customerId: options.customerId,
        mqttTopic: mqttConnectTopic(this.clientIdLabel(clientId)),
        mqttQos: 0,
        mqttRetained: false,
        mqttEventType: 'CONNECT',
        mqttClientId: this.clientIdLabel(clientId),
        productType: options.productType,
        dataBytes: 0,
      }, options.executionStatus, clientId);
    });

    client.on('close', () => {
      this.push({
        customerId: options.customerId,
        mqttTopic: mqttDisconnectTopic(this.clientIdLabel(clientId)),
        mqttQos: 0,
        mqttRetained: false,
        mqttEventType: 'DISCONNECT',
        mqttClientId: this.clientIdLabel(clientId),
        productType: options.productType,
        dataBytes: 0,
      }, options.executionStatus, clientId);
    });

    client.on('message', (topic, payload, packet) => {
      this.push({
        customerId: options.customerId,
        mqttTopic: this.topicLabel(topic),
        mqttQos: packet?.qos ?? 0,
        mqttRetained: !!packet?.retain,
        mqttEventType: 'DELIVER',
        mqttClientId: this.clientIdLabel(clientId),
        productType: options.productType,
        dataBytes: estimateBytes(payload),
      }, options.executionStatus, clientId);
    });

    const origPublish = client.publish.bind(client);
    client.publish = (topic: string, message: any, opts?: any, cb?: any) => {
      this.push({
        customerId: options.customerId,
        mqttTopic: this.topicLabel(topic),
        mqttQos: opts?.qos ?? 0,
        mqttRetained: !!opts?.retain,
        mqttEventType: 'PUBLISH',
        mqttClientId: this.clientIdLabel(clientId),
        productType: options.productType,
        dataBytes: estimateBytes(message),
      }, options.executionStatus, clientId);
      return origPublish(topic, message, opts, cb);
    };
  }

  // ── Event pipeline ──────────────────────────────────────────────

  /**
   * Bound an MQTT label (topic, client id) to the ingestor's limit. The event
   * is still sent; one WARN per label name per client. Identity fields
   * (customerId, productType) never go through here — an over-long one drops
   * the event as 'invalid'.
   */
  private requestLabel(field: string, value: string, max: number): string {
    if (typeof value !== 'string' || value.length <= max) return value;
    if (!this.truncationWarned.has(field)) {
      this.truncationWarned.add(field);
      console.warn(
        `[aforo-mqtt] ${field} was longer than the ingestor's limit and was ` +
          `truncated to ${max} characters; the event is still sent. Logged once per label.`,
      );
    }
    return truncateToLimit(value, max);
  }

  /** Topic off an incoming packet, bound to the ingestor's mqttTopic limit. */
  private topicLabel(topic: unknown): string {
    return typeof topic === 'string' ? this.requestLabel('mqttTopic', topic, MAX_MQTT_TOPIC) : (topic as string);
  }

  /** Client id a connecting client chose, bound to the ingestor's mqttClientId limit. */
  private clientIdLabel(clientId: unknown): string {
    return typeof clientId === 'string' ? this.requestLabel('mqttClientId', clientId, MAX_MQTT_CLIENT_ID) : (clientId as string);
  }


  private push(
    partial: Omit<MqttUsageEvent, 'metricName' | 'quantity' | 'occurredAt' | 'idempotencyKey' | 'productType' | 'executionStatus'> & { productType?: string },
    executionStatus?: ExecutionStatusOption,
    /** Untruncated client id for the idempotency key, when `partial.mqttClientId` was cut to the limit. */
    keyClientId?: string
  ): void {
    if (!this.emitDeliverEvents && partial.mqttEventType === 'DELIVER') return;
    // No customer resolved — not billable, not a drop.
    if (typeof partial.customerId !== 'string' || !partial.customerId.trim()) return;

    const now = new Date();
    const mqttClientId = typeof partial.mqttClientId === 'string' ? partial.mqttClientId : String(partial.mqttClientId ?? '');
    const event: MqttUsageEvent = {
      ...partial,
      mqttQos: partial.mqttQos === 1 || partial.mqttQos === 2 ? partial.mqttQos : 0,
      mqttClientId,
      metricName: `mqtt_broker.${partial.mqttEventType.toLowerCase()}`,
      quantity: 1,
      occurredAt: now.toISOString(),
      // Minted once, here, from the untruncated client id; the topic is left
      // out. When the client id makes the key longer than the ingestor allows,
      // it is replaced by its SHA-256 digest; the key itself is never cut.
      idempotencyKey: boundedIdempotencyKey(
        `mqtt:${this.config.tenantId}:`,
        typeof keyClientId === 'string' ? keyClientId : mqttClientId,
        `:${partial.mqttEventType}:${now.getTime()}:${randomSuffix()}`,
      ),
      productType: normalizeProductType(partial.productType) ?? this.productType,
      metadata: {
        ...(partial.metadata ?? {}),
        sdkVersion: SDK_VERSION,
        productId: this.config.productId,
      },
    };
    const checked = checkExecutionStatus(resolveExecutionStatus(executionStatus, event));
    if (checked.problem) this.reportError(new Error(`[aforo-mqtt] ${checked.problem}`));
    if (checked.status) event.executionStatus = checked.status;

    // An event the ingestor would reject is not sent (one bad event fails its
    // whole batch): it is dropped here with reason 'invalid', never thrown
    // into the broker / client handlers. mqttTopic is required on every
    // MQTT_BROKER event.
    const invalid =
      tooLong('customerId', event.customerId, MAX_CUSTOMER_ID) ??
      requiredText('mqttTopic', event.mqttTopic) ??
      tooLong('mqttTopic', event.mqttTopic, MAX_MQTT_TOPIC) ??
      tooLong('mqttClientId', event.mqttClientId, MAX_MQTT_CLIENT_ID) ??
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

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const pending = this.buffer.splice(0, this.buffer.length);
    // The ingestor accepts at most MAX_BATCH_EVENTS events per request.
    for (let i = 0; i < pending.length; i += MAX_BATCH_EVENTS) {
      await this.send(pending.slice(i, i + MAX_BATCH_EVENTS));
    }
  }

  private async send(batch: MqttUsageEvent[]): Promise<void> {
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
          this.reportError(new Error(`MQTT metering batch rejected with HTTP ${res.status}${details ? ` — ${details}` : ''} (dropped ${batch.length} events, not retried)`));
          return;
        }
        delayMs = parseRetryAfter(res) ?? delayMs;
      } else if (attempt === maxRetries) {
        this.recordDrop(batch, 'retry_exhausted');
        this.reportError(networkError ?? new Error('MQTT metering request failed'));
        return;
      }
      if (attempt < maxRetries) await sleep(delayMs);
    }
    // Not re-queued: dropping avoids unbounded memory growth.
    this.recordDrop(batch, 'retry_exhausted');
    this.reportError(new Error(`MQTT metering flush failed after ${maxRetries} attempts (dropped ${batch.length} events)`));
  }

  /**
   * A 2xx can still carry per-event rejections:
   * `{accepted, duplicates, failed, errors:[{index, message}]}`. Events the
   * response names by index are dropped with reason 'rejected'; a `failed`
   * count the response does not attribute to an index is counted only.
   */
  private async handlePartialFailures(res: Response, batch: MqttUsageEvent[]): Promise<void> {
    const { failed, details, indexes } = await readBatchResult(res, batch.length);
    if (failed <= 0) return;
    if (indexes.length > 0) this.recordDrop(indexes.map((i) => batch[i]), 'rejected');
    const unattributed = Math.min(failed, batch.length) - indexes.length;
    if (unattributed > 0) {
      this.dropped += unattributed;
      console.warn(
        `[aforo-mqtt] Dropped ${unattributed} event(s) — rejected, not identified by the ingestor (${this.dropped} total dropped).`,
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
  private recordDrop(events: MqttUsageEvent[], reason: DropReason): void {
    this.dropped += events.length;
    console.warn(
      `[aforo-mqtt] Dropped ${events.length} event(s) — ${reason} (${this.dropped} total dropped).`,
    );
    this.notifyDrop(events, reason);
  }

  /**
   * Account for an event that failed a client-side check: never buffered,
   * never sent. Runs on the hot path, so the WARN is throttled per field
   * (first occurrence, then every 1000th).
   */
  private recordInvalid(event: MqttUsageEvent, invalid: InvalidField): void {
    this.dropped += 1;
    const seen = (this.invalidSeen.get(invalid.field) ?? 0) + 1;
    this.invalidSeen.set(invalid.field, seen);
    if (seen === 1 || seen % 1000 === 0) {
      console.warn(
        `[aforo-mqtt] Dropped 1 event — invalid: ${invalid.problem} ` +
          `(${seen} for ${invalid.field}, ${this.dropped} total dropped).`,
      );
    }
    this.notifyDrop([event], 'invalid');
  }

  private notifyDrop(events: MqttUsageEvent[], reason: DropReason): void {
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

function estimateBytes(data: any): number {
  if (data == null) return 0;
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (Buffer.isBuffer?.(data)) return data.length;
  if (data?.byteLength != null) return data.byteLength;
  return 0;
}

/** Statuses the Aforo ingestor accepts (contract/ingest-contract.json, max 20 chars). */
const CANONICAL_EXECUTION_STATUSES: ReadonlySet<string> = new Set([
  'SUCCESS', 'PARTIAL', 'TIMEOUT', 'ERROR', 'VALIDATION_FAILED', 'FAILED',
  'FAILURE', 'CANCELLED', 'PENDING', 'BLOCKED', 'HITL_REQUIRED',
]);

/**
 * Check a caller-supplied status. `{ status }` when canonical; `{ problem }`
 * when it has to be left off the event (an unknown value would make the
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

function resolveExecutionStatus(option: ExecutionStatusOption | undefined, event: MqttUsageEvent): unknown {
  if (typeof option !== 'function') return option;
  try {
    return option(event);
  } catch {
    return undefined; // a resolver bug must never break metering
  }
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

/** Limits mirror the ingestor's IngestUsageEventRequest; identity values are never truncated. */
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
