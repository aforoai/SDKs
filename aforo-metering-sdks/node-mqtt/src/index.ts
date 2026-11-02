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
 *     // Who is billed: map the client your broker authenticated to an Aforo customer.
 *     customerResolver: (clientId, username) => deviceRegistry.customerFor(clientId),
 *   });
 *
 *   // The SDK installs no signal handlers. Flush from your own:
 *   process.once('SIGTERM', async () => { await billing.shutdown(); process.exit(0); });
 */

import { createHash } from 'node:crypto';
import { TransportCore, CoreDropReason } from './transport-core/core';

/** What onError receives for delivery problems: branch on `kind`, read `events`. */
export { CoreTransportError, type CoreErrorKind } from './transport-core/core';

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
  /** Emit one event per fanout delivery in addition to the publish (default false — costly). */
  emitDeliverEvents?: boolean;
  /**
   * A connection that drops and comes back within this many ms is one
   * session: no new CONNECT/DISCONNECT pair is billed for the flap. A
   * connection that does not come back is billed as DISCONNECT (at the time
   * it dropped) once the window passes; a clean disconnect is billed at once.
   * Default 30 000. 0 turns the window off. Overridable per wrap call.
   */
  reconnectDebounceMs?: number;
  /**
   * Callback for delivery problems (rejected batches, outages, a wrong API
   * key, shutdown leftovers), resolver errors and bad executionStatus values.
   * Delivery reports are a `CoreTransportError`: branch on `err.kind`.
   */
  onError?: (error: Error) => void;
  /**
   * Opt-in hook receiving events that were permanently dropped (see
   * DropReason). Events keep their idempotency keys,
   * so persisting and re-submitting them after recovery is dedup-safe.
   * Exceptions thrown by the hook are swallowed. Default: none (drops are
   * still counted in droppedCount and WARN-logged).
   */
  onDrop?: (events: MqttUsageEvent[], reason: DropReason) => void;
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

/** Maps a broker client to the Aforo customer billed for it. */
export type MqttCustomerResolver = (
  clientId: string,
  username?: string,
) => string | undefined | null | Promise<string | undefined | null>;

export interface AedesBrokerOptions {
  /**
   * Who is billed for a client's traffic: map the client your broker
   * authenticated (its client id / username after your `authenticate` hook)
   * to an Aforo customer. Required unless `trustCustomerHeader` is true. May
   * be async. Returning nothing drops that event as 'invalid' (counted); a
   * throw or rejection is reported through onError and the event is dropped
   * as 'invalid'. MQTT traffic is never blocked.
   */
  customerResolver?: MqttCustomerResolver;
  /** @deprecated Use `customerResolver` (same signature). */
  resolveCustomerId?: MqttCustomerResolver;
  /**
   * Bill the MQTT username the client sent at CONNECT. A client picks its own
   * username, so only turn this on when your broker authenticates the
   * username (password / certificate check in `authenticate`). Default false.
   */
  trustCustomerHeader?: boolean;
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
  /**
   * Reconnect window per client id, in ms (default: the client-level
   * `reconnectDebounceMs`, 30 000). A client that disconnects without a
   * DISCONNECT packet and reconnects with the same client id inside the
   * window — or takes over its own session — is one session. 0 = off.
   */
  reconnectDebounceMs?: number;
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
   * Never derived by the SDK: a publish is metered only once mqtt.js
   * reports it succeeded, so there is no failure to derive a status from.
   * Pass a fixed string, or a function called for each event that returns
   * the status or undefined.
   */
  executionStatus?: string | ((event: MqttUsageEvent) => string | undefined);
  /** Product type for events from this client. Default: the client-level `productType`. */
  productType?: string;
  /**
   * Reconnect window in ms (default: the client-level `reconnectDebounceMs`,
   * 30 000). mqtt.js reconnects on its own after a drop; a reconnect inside
   * the window bills no new CONNECT and no DISCONNECT. 0 = off.
   */
  reconnectDebounceMs?: number;
}

/** A DISCONNECT waiting for the reconnect window to pass. */
interface PendingDisconnect {
  /** Bill it now (window passed, end(), or shutdown). Runs once. */
  fire(): Promise<void>;
  /** The connection came back: never bill it. */
  cancel(): void;
}

/** Default reconnect window, the same as python-mqtt's `reconnect_debounce_sec`. */
export const DEFAULT_RECONNECT_DEBOUNCE_MS = 30_000;

function checkDebounce(value: unknown, fallback: number, where: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`[aforo-mqtt] ${where}: reconnectDebounceMs must be a non-negative number of milliseconds (got ${String(value)})`);
  }
  return value;
}

type ExecutionStatusOption = string | ((event: MqttUsageEvent) => string | undefined);

const SDK_VERSION = '2.1.0';
/** Default top-level `productType` for this SDK. */
export const DEFAULT_PRODUCT_TYPE = 'MQTT_BROKER';
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
  on(event: 'end', fn: () => void): void;
  publish: (topic: string, message: any, opts?: any, cb?: any) => any;
  options?: { clientId?: string };
  /** mqtt.js sets this while end() runs, so a 'close' then is a clean disconnect. */
  disconnecting?: boolean;
}

export class AforoMqttBilling {
  private readonly config: Required<Pick<AforoMqttConfig, 'tenantId' | 'productId'>>;
  private readonly productType: string;
  private readonly emitDeliverEvents: boolean;
  private readonly onError: (error: Error) => void;
  private readonly core: TransportCore<MqttUsageEvent>;
  /** Request-derived labels already reported as truncated (one WARN per label). */
  private readonly truncationWarned = new Set<string>();
  private readonly reconnectDebounceMs: number;
  /** DISCONNECTs inside their reconnect window; billed at shutdown at the latest. */
  private readonly pendingDisconnects = new Set<PendingDisconnect>();

  constructor(config: AforoMqttConfig) {
    this.config = {
      tenantId: config.tenantId,
      productId: config.productId,
    };
    this.productType = normalizeProductType(config.productType) ?? DEFAULT_PRODUCT_TYPE;
    this.emitDeliverEvents = config.emitDeliverEvents ?? false;
    this.reconnectDebounceMs = checkDebounce(config.reconnectDebounceMs, DEFAULT_RECONNECT_DEBOUNCE_MS, 'AforoMqttBilling');
    this.onError = config.onError ?? ((err) => console.error('[aforo-mqtt]', err.message));
    const onDrop = config.onDrop;
    // The core is the only holder of the API key.
    this.core = new TransportCore<MqttUsageEvent>({
      baseUrl: config.ingestorUrl,
      apiKey: config.apiKey,
      allowInsecureHttp: config.allowInsecureHttp,
      compression: config.compression,
      headers: { 'X-Tenant-Id': config.tenantId },
      userAgent: `aforo-mqtt-metering/${SDK_VERSION}`,
      flushCount: config.flushCount,
      flushIntervalMs: config.flushIntervalMs,
      maxQueueSize: config.maxQueueSize,
      maxRetries: config.maxRetries,
      timeoutMs: config.timeoutMs,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      flushOnExit: config.flushOnExit,
      logPrefix: '[aforo-mqtt]',
      onError: (err) => this.reportError(err),
      onDrop: onDrop ? (events, reason: CoreDropReason) => onDrop(events, reason as DropReason) : undefined,
    });
  }

  // ── Broker-side integration (Aedes) ─────────────────────────────

  /**
   * Attach to an Aedes broker. Throws when neither `customerResolver` nor
   * `trustCustomerHeader: true` is given. Every listener catches its own
   * errors (a resolver rejection is reported through onError), so metering can
   * never produce an unhandled rejection in the broker process.
   */
  wrapAedesBroker(broker: MinimalAedes, options: AedesBrokerOptions): void {
    const resolver = options?.customerResolver ?? options?.resolveCustomerId;
    const trustUsername = options?.trustCustomerHeader === true;
    if (typeof resolver !== 'function' && !trustUsername) {
      throw new Error(
        '[aforo-mqtt] wrapAedesBroker needs a customerResolver: (clientId, username) => the Aforo customer id ' +
          'for the client your broker authenticated. To bill the MQTT username instead — only when your broker ' +
          'authenticates it — pass trustCustomerHeader: true.',
      );
    }
    const resolveCustomer = async (clientId: string, username?: string): Promise<string | undefined> => {
      const fromResolver = typeof resolver === 'function' ? textOrUndefined(await resolver(clientId, username)) : undefined;
      if (fromResolver) return fromResolver;
      return trustUsername ? textOrUndefined(username) : undefined;
    };
    const debounceMs = checkDebounce(options.reconnectDebounceMs, this.reconnectDebounceMs, 'wrapAedesBroker');
    /** Per client id: live connections and a DISCONNECT inside its reconnect window. */
    const sessions = new Map<string, { live: number; pending: PendingDisconnect | null }>();
    const status = options.executionStatus;
    const brokerStatus = (clientId: string): ExecutionStatusOption | undefined =>
      typeof status === 'function' ? (event) => status(event, clientId) : status;

    /**
     * Run a listener body. The returned promise always resolves: a throw or
     * rejection is reported through onError, never left unhandled.
     */
    const guarded = (hook: string, body: () => Promise<void>): Promise<void> =>
      body().catch((err) => {
        this.reportError(new Error(`[aforo-mqtt] ${hook} metering failed: ${(err as Error)?.message ?? err}`));
      });
    /** Resolve the customer; a resolver failure is reported and treated as "no customer". */
    const customerFor = async (hook: string, clientId: string, username?: string): Promise<string> => {
      try {
        return (await resolveCustomer(clientId, username)) ?? '';
      } catch (err) {
        this.reportError(new Error(`[aforo-mqtt] customerResolver failed on ${hook}: ${(err as Error)?.message ?? err}`));
        return '';
      }
    };

    broker.on('publish', (packet: any, client: any) => {
      if (!client) return; // broker-originated publishes skip billing
      return guarded('publish', async () => {
        const clientId = client.id;
        const customerId = await customerFor('publish', clientId, client.username);
        this.push({
          customerId,
          mqttTopic: this.topicLabel(packet?.topic),
          mqttQos: packet?.qos ?? 0,
          mqttRetained: !!packet?.retain,
          mqttEventType: 'PUBLISH',
          mqttClientId: this.clientIdLabel(clientId),
          productType: options.productType,
          dataBytes: estimateBytes(packet?.payload),
          metadata: options.resolveMetadata?.(clientId),
        }, brokerStatus(clientId), clientId);
      });
    });

    broker.on('subscribe', (subs: any[] | any, client: any) => {
      const clientId = client?.id;
      if (!clientId) return;
      return guarded('subscribe', async () => {
        const customerId = await customerFor('subscribe', clientId, client.username);
        const arr = Array.isArray(subs) ? subs : [subs];
        for (const s of arr) {
          this.push({
            customerId,
            mqttTopic: this.topicLabel(s?.topic),
            mqttQos: s?.qos ?? 0,
            mqttRetained: false,
            mqttEventType: 'SUBSCRIBE',
            mqttClientId: this.clientIdLabel(clientId),
            productType: options.productType,
            dataBytes: 0,
            metadata: options.resolveMetadata?.(clientId),
          }, brokerStatus(clientId), clientId);
        }
      });
    });

    broker.on('unsubscribe', (unsubs: any[] | any, client: any) => {
      const clientId = client?.id;
      if (!clientId) return;
      return guarded('unsubscribe', async () => {
        const customerId = await customerFor('unsubscribe', clientId, client.username);
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
    });

    broker.on('client', (client: any) => {
      if (debounceMs > 0) {
        const key = String(client?.id ?? '');
        let session = sessions.get(key);
        if (!session) {
          session = { live: 0, pending: null };
          sessions.set(key, session);
        }
        // Back inside the window, or a takeover of its own live session: same session, no CONNECT.
        const sameSession = session.pending !== null || session.live > 0;
        session.pending?.cancel();
        session.pending = null;
        session.live += 1;
        if (sameSession) return;
      }
      return guarded('client', async () => {
        const clientId = client?.id;
        const customerId = await customerFor('client', clientId, client?.username);
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
    });

    broker.on('clientDisconnect', (client: any) => {
      const at = new Date();
      const emit = () =>
        guarded('clientDisconnect', async () => {
          const clientId = client?.id;
          const customerId = await customerFor('clientDisconnect', clientId, client?.username);
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
          }, brokerStatus(clientId), clientId, at);
        });
      if (debounceMs === 0) return emit();
      const key = String(client?.id ?? '');
      const session = sessions.get(key) ?? { live: 1, pending: null };
      session.live = Math.max(0, session.live - 1);
      if (session.live > 0) return; // a takeover: the session lives on in the new connection
      // aedes sets _disconnected only for a DISCONNECT packet: a clean disconnect is billed at once.
      if (client?._disconnected === true) {
        sessions.delete(key);
        return emit();
      }
      sessions.set(key, session);
      session.pending = this.scheduleDisconnect(debounceMs, () => {
        session.pending = null;
        if (session.live === 0) sessions.delete(key);
        return emit();
      });
    });
  }

  // ── Client-side integration (mqtt.js) ───────────────────────────

  wrapMqttClient(client: MinimalMqttClient, options: MqttClientOptions): void {
    const clientId = options.clientId ?? client.options?.clientId ?? 'mqtt-client';
    const debounceMs = checkDebounce(options?.reconnectDebounceMs, this.reconnectDebounceMs, 'wrapMqttClient');
    let connected = false;
    let pendingDisconnect: PendingDisconnect | null = null;

    client.on('connect', () => {
      if (pendingDisconnect) {
        // Reconnected inside the window: the same session, nothing new to bill.
        pendingDisconnect.cancel();
        pendingDisconnect = null;
        connected = true;
        return;
      }
      if (connected && debounceMs > 0) return;
      connected = true;
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

    // mqtt.js emits 'close' for every lost connection and for every failed
    // reconnect attempt; only the end of a live connection can be a DISCONNECT.
    client.on('close', () => {
      if (!connected) return;
      connected = false;
      const at = new Date();
      const emit = () =>
        this.push({
          customerId: options.customerId,
          mqttTopic: mqttDisconnectTopic(this.clientIdLabel(clientId)),
          mqttQos: 0,
          mqttRetained: false,
          mqttEventType: 'DISCONNECT',
          mqttClientId: this.clientIdLabel(clientId),
          productType: options.productType,
          dataBytes: 0,
        }, options.executionStatus, clientId, at);
      if (debounceMs === 0 || client.disconnecting === true) {
        emit(); // the caller ended it: a clean disconnect
        return;
      }
      pendingDisconnect = this.scheduleDisconnect(debounceMs, () => {
        pendingDisconnect = null;
        emit();
      });
    });

    // end() while waiting for a reconnect: the session is over now.
    client.on('end', () => {
      const pending = pendingDisconnect;
      pendingDisconnect = null;
      if (pending) void pending.fire();
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

    // PUBLISH is billed when mqtt.js reports success: the broker's PUBACK /
    // PUBCOMP for QoS 1 / 2, the socket write for QoS 0. A publish that
    // throws or whose callback gets an error is not billed. publishAsync()
    // goes through publish(), so it is covered too.
    const origPublish = client.publish.bind(client);
    client.publish = (topic: string, message: any, opts?: any, cb?: any) => {
      const optsIsCallback = typeof opts === 'function';
      const userCallback = optsIsCallback ? opts : cb;
      const publishOpts = optsIsCallback ? undefined : opts;
      const at = new Date();
      const done = (err?: unknown, ...rest: unknown[]) => {
        if (!err) {
          try {
            this.push({
              customerId: options.customerId,
              mqttTopic: this.topicLabel(topic),
              mqttQos: publishOpts?.qos ?? 0,
              mqttRetained: !!publishOpts?.retain,
              mqttEventType: 'PUBLISH',
              mqttClientId: this.clientIdLabel(clientId),
              productType: options.productType,
              dataBytes: estimateBytes(message),
            }, options.executionStatus, clientId, at);
          } catch (meterErr) {
            this.reportError(new Error(`[aforo-mqtt] publish metering failed: ${(meterErr as Error)?.message ?? meterErr}`));
          }
        }
        if (typeof userCallback === 'function') return userCallback(err, ...rest);
      };
      return optsIsCallback ? origPublish(topic, message, done) : origPublish(topic, message, opts, done);
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
    keyClientId?: string,
    /** When it happened, if not now (a debounced DISCONNECT, a confirmed PUBLISH). */
    at?: Date,
  ): void {
    if (!this.emitDeliverEvents && partial.mqttEventType === 'DELIVER') return;

    const now = at ?? new Date();
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
      (typeof event.customerId !== 'string' || !event.customerId.trim()
        ? { field: 'customerId', problem: 'no customer: the customer resolver returned nothing (or customerId is blank); the event is not metered' }
        : undefined) ??
      tooLong('customerId', event.customerId, MAX_CUSTOMER_ID) ??
      requiredText('mqttTopic', event.mqttTopic) ??
      tooLong('mqttTopic', event.mqttTopic, MAX_MQTT_TOPIC) ??
      tooLong('mqttClientId', event.mqttClientId, MAX_MQTT_CLIENT_ID) ??
      tooLong('productType', event.productType, MAX_PRODUCT_TYPE);
    if (invalid) {
      this.core.reportDrop([event], 'invalid', invalid.problem);
      return;
    }

    // Queue only; the core's single background sender does the HTTP.
    this.core.enqueue(event);
  }

  /** Hold a DISCONNECT for `ms`; it is billed when the window passes unless cancelled. */
  private scheduleDisconnect(ms: number, emit: () => void | Promise<void>): PendingDisconnect {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending: PendingDisconnect = {
      fire: () => {
        if (done) return Promise.resolve();
        done = true;
        if (timer) clearTimeout(timer);
        this.pendingDisconnects.delete(pending);
        return Promise.resolve()
          .then(emit)
          .catch((err) => this.reportError(new Error(`[aforo-mqtt] DISCONNECT metering failed: ${(err as Error)?.message ?? err}`)));
      },
      cancel: () => {
        done = true;
        if (timer) clearTimeout(timer);
        this.pendingDisconnects.delete(pending);
      },
    };
    timer = setTimeout(() => void pending.fire(), ms);
    (timer as { unref?: () => void }).unref?.();
    this.pendingDisconnects.add(pending);
    return pending;
  }

  /** Invoke onError; a hook bug must never break metering or flushing. */
  private reportError(err: Error): void {
    try {
      this.onError(err);
    } catch (hookErr) {
      console.debug('[aforo-mqtt] onError hook threw', hookErr);
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
    // A DISCONNECT still inside its reconnect window is billed now, not lost.
    await Promise.all(Array.from(this.pendingDisconnects, (p) => p.fire()));
    await this.core.shutdown();
  }

  toJSON(): Record<string, unknown> {
    return { tenantId: this.config.tenantId, productId: this.config.productId, queued: this.queuedCount, dropped: this.droppedCount };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `AforoMqttBilling { tenantId: '${this.config.tenantId}', productId: '${this.config.productId}', queued: ${this.queuedCount}, dropped: ${this.droppedCount} }`;
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

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
