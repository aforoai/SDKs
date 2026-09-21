/**
 * @aforo/mqtt-metering — Aforo MQTT Metering SDK
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
 *   import { AforoMqttBilling } from '@aforo/mqtt-metering';
 *
 *   const billing = new AforoMqttBilling({
 *     tenantId: 'tenant_acme',
 *     productId: 'prod_mqtt_telemetry',
 *     apiKey: process.env.AFORO_API_KEY!,
 *     ingestorUrl: 'https://usage-ingestor.aforo.ai',
 *   });
 *
 *   const broker = aedes();
 *   billing.wrapAedesBroker(broker, {
 *     resolveCustomerId: (clientId) => customerIdLookup(clientId),
 *   });
 */

export interface AforoMqttConfig {
  tenantId: string;
  productId: string;
  apiKey: string;
  ingestorUrl: string;
  /** How many events to buffer before flushing (default 200 — MQTT is very high-volume). */
  flushCount?: number;
  /** Max interval in ms before a partial batch is flushed (default 2000). */
  flushIntervalMs?: number;
  /** Emit one event per fanout delivery in addition to the publish (default false — costly). */
  emitDeliverEvents?: boolean;
  /** Callback for terminal flush failures. */
  onError?: (error: Error) => void;
}

export interface AedesBrokerOptions {
  /** Map an MQTT client ID to an Aforo customer ID. Required. */
  resolveCustomerId: (clientId: string, username?: string) => string | undefined | Promise<string | undefined>;
  /** Optional per-client metadata (tags, device type). */
  resolveMetadata?: (clientId: string) => Record<string, unknown> | undefined;
}

export interface MqttClientOptions {
  /** Customer ID to attribute all traffic on this client to. */
  customerId: string;
  /** Fixed client identifier (defaults to mqtt.js connection options.clientId). */
  clientId?: string;
}

const SDK_VERSION = '1.0.0';
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

type MqttEventType = 'PUBLISH' | 'DELIVER' | 'SUBSCRIBE' | 'UNSUBSCRIBE' | 'CONNECT' | 'DISCONNECT';

interface MqttUsageEvent {
  customerId: string;
  metricName: string;
  quantity: number;
  occurredAt: string;
  idempotencyKey: string;
  productType: 'MQTT_BROKER';
  mqttTopic: string;
  mqttQos: number;
  mqttRetained: boolean;
  mqttEventType: MqttEventType;
  mqttClientId: string;
  dataBytes: number;
  metadata?: Record<string, unknown>;
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
  private readonly flushCount: number;
  private readonly flushIntervalMs: number;
  private readonly emitDeliverEvents: boolean;
  private readonly onError: (error: Error) => void;

  private buffer: MqttUsageEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AforoMqttConfig) {
    this.config = {
      tenantId: config.tenantId,
      productId: config.productId,
      apiKey: config.apiKey,
      ingestorUrl: config.ingestorUrl,
    };
    this.flushCount = config.flushCount ?? 200;
    this.flushIntervalMs = config.flushIntervalMs ?? 2000;
    this.emitDeliverEvents = config.emitDeliverEvents ?? false;
    this.onError = config.onError ?? ((err) => console.error('[aforo-mqtt]', err.message));
    this.startTimer();
  }

  // ── Broker-side integration (Aedes) ─────────────────────────────

  wrapAedesBroker(broker: MinimalAedes, options: AedesBrokerOptions): void {
    const resolveCustomer = async (clientId: string, username?: string) =>
      Promise.resolve(options.resolveCustomerId(clientId, username));

    broker.on('publish', async (packet: any, client: any) => {
      if (!client) return; // broker-originated publishes skip billing
      const clientId = client.id;
      const customerId = await resolveCustomer(clientId, client.username);
      if (!customerId) return;

      const payload = packet.payload;
      const bytes = estimateBytes(payload);
      this.push({
        customerId,
        mqttTopic: packet.topic,
        mqttQos: packet.qos ?? 0,
        mqttRetained: !!packet.retain,
        mqttEventType: 'PUBLISH',
        mqttClientId: clientId,
        dataBytes: bytes,
        metadata: options.resolveMetadata?.(clientId),
      });
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
          mqttTopic: s.topic,
          mqttQos: s.qos ?? 0,
          mqttRetained: false,
          mqttEventType: 'SUBSCRIBE',
          mqttClientId: clientId,
          dataBytes: 0,
          metadata: options.resolveMetadata?.(clientId),
        });
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
          mqttTopic: typeof topic === 'string' ? topic : topic?.topic ?? '',
          mqttQos: 0,
          mqttRetained: false,
          mqttEventType: 'UNSUBSCRIBE',
          mqttClientId: clientId,
          dataBytes: 0,
          metadata: options.resolveMetadata?.(clientId),
        });
      }
    });

    broker.on('client', async (client: any) => {
      const clientId = client.id;
      const customerId = await resolveCustomer(clientId, client.username);
      if (!customerId) return;
      this.push({
        customerId,
        mqttTopic: mqttConnectTopic(clientId), // CONNECT has no topic; mqttTopic is required
        mqttQos: 0,
        mqttRetained: false,
        mqttEventType: 'CONNECT',
        mqttClientId: clientId,
        dataBytes: 0,
        metadata: options.resolveMetadata?.(clientId),
      });
    });

    broker.on('clientDisconnect', async (client: any) => {
      const clientId = client.id;
      const customerId = await resolveCustomer(clientId, client.username);
      if (!customerId) return;
      this.push({
        customerId,
        mqttTopic: mqttDisconnectTopic(clientId),
        mqttQos: 0,
        mqttRetained: false,
        mqttEventType: 'DISCONNECT',
        mqttClientId: clientId,
        dataBytes: 0,
        metadata: options.resolveMetadata?.(clientId),
      });
    });
  }

  // ── Client-side integration (mqtt.js) ───────────────────────────

  wrapMqttClient(client: MinimalMqttClient, options: MqttClientOptions): void {
    const clientId = options.clientId ?? client.options?.clientId ?? 'mqtt-client';

    client.on('connect', () => {
      this.push({
        customerId: options.customerId,
        mqttTopic: mqttConnectTopic(clientId),
        mqttQos: 0,
        mqttRetained: false,
        mqttEventType: 'CONNECT',
        mqttClientId: clientId,
        dataBytes: 0,
      });
    });

    client.on('close', () => {
      this.push({
        customerId: options.customerId,
        mqttTopic: mqttDisconnectTopic(clientId),
        mqttQos: 0,
        mqttRetained: false,
        mqttEventType: 'DISCONNECT',
        mqttClientId: clientId,
        dataBytes: 0,
      });
    });

    client.on('message', (topic, payload, packet) => {
      this.push({
        customerId: options.customerId,
        mqttTopic: topic,
        mqttQos: packet?.qos ?? 0,
        mqttRetained: !!packet?.retain,
        mqttEventType: 'DELIVER',
        mqttClientId: clientId,
        dataBytes: estimateBytes(payload),
      });
    });

    const origPublish = client.publish.bind(client);
    client.publish = (topic: string, message: any, opts?: any, cb?: any) => {
      this.push({
        customerId: options.customerId,
        mqttTopic: topic,
        mqttQos: opts?.qos ?? 0,
        mqttRetained: !!opts?.retain,
        mqttEventType: 'PUBLISH',
        mqttClientId: clientId,
        dataBytes: estimateBytes(message),
      });
      return origPublish(topic, message, opts, cb);
    };
  }

  // ── Event pipeline ──────────────────────────────────────────────

  private push(partial: Omit<MqttUsageEvent, 'metricName' | 'quantity' | 'occurredAt' | 'idempotencyKey' | 'productType'>): void {
    if (!this.emitDeliverEvents && partial.mqttEventType === 'DELIVER') return;
    if (!partial.customerId || !partial.customerId.trim()) return;
    if (partial.customerId.length > MAX_CUSTOMER_ID) {
      this.onError(new Error(`MQTT metering: customerId longer than ${MAX_CUSTOMER_ID} chars; event dropped`));
      return;
    }
    const mqttTopic = partial.mqttTopic;
    if (!mqttTopic) return; // mqttTopic is required on every MQTT_BROKER event

    const now = new Date();
    const mqttClientId = partial.mqttClientId.slice(0, 128);
    const event: MqttUsageEvent = {
      ...partial,
      mqttTopic: mqttTopic.slice(0, 500),
      mqttQos: partial.mqttQos === 1 || partial.mqttQos === 2 ? partial.mqttQos : 0,
      mqttClientId,
      metricName: `mqtt_broker.${partial.mqttEventType.toLowerCase()}`,
      quantity: 1,
      occurredAt: now.toISOString(),
      // Topic left out (it can be 500 chars); tail-trimmed to keep the unique millis:random suffix.
      idempotencyKey: `mqtt:${this.config.tenantId}:${mqttClientId}:${partial.mqttEventType}:${now.getTime()}:${randomSuffix()}`.slice(-MAX_IDEMPOTENCY_KEY),
      productType: 'MQTT_BROKER',
      metadata: {
        ...(partial.metadata ?? {}),
        sdkVersion: SDK_VERSION,
        productId: this.config.productId,
      },
    };
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
        if (res.ok) return;
      } catch (err) {
        if (attempt === maxRetries) {
          this.onError(err as Error);
          return;
        }
      }
      await sleep(Math.pow(2, attempt - 1) * 1000);
    }
    this.onError(new Error(`MQTT metering flush failed after ${maxRetries} attempts (dropped ${batch.length} events)`));
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

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
