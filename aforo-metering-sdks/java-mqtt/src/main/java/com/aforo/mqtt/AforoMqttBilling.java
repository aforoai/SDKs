package com.aforo.mqtt;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.aforo.mqtt.internal.transport.TransportConfig;
import com.aforo.mqtt.internal.transport.TransportCore;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.BiConsumer;
import java.util.logging.Logger;

/**
 * Aforo MQTT Metering SDK for Java — client-mode integration.
 *
 * <p>For broker-side metering on EMQ X 5.x, see the Erlang plugin at
 * {@code aforo-nextgen-docker/emqx-plugin-aforo-metering/}. This Java
 * SDK is for client-side metering — call from your CONNECT, PUBLISH,
 * SUBSCRIBE, DISCONNECT code paths (Eclipse Paho integration is
 * documented in README).</p>
 *
 * <p>API is intentionally framework-agnostic: every method takes the
 * raw MQTT primitives (topic / qos / retained / clientId / payload size)
 * and produces one Aforo event. Plug into Paho's IMqttMessageListener
 * and IMqttToken handlers, or any other Java MQTT client.</p>
 */
public final class AforoMqttBilling implements AutoCloseable {

    private static final Logger LOG = Logger.getLogger(AforoMqttBilling.class.getName());
    private static final String SDK_VERSION = "2.1.0";
    private static final int MAX_IDEMPOTENCY_KEY = 255;
    /** Ingestor limits on the labels taken from the MQTT packet. */
    static final int MAX_MQTT_TOPIC = 500;
    static final int MAX_MQTT_CLIENT_ID = 128;
    /** Default top-level {@code productType}; override with {@link Builder#productType(String)}. */
    public static final String DEFAULT_PRODUCT_TYPE = "MQTT_BROKER";

    private final String tenantId, productId, apiKey;
    private final String productType;
    private final boolean emitDeliverEvents;

    private final BiConsumer<java.util.List<Map<String, Object>>, DropReason> onDrop;
    private final java.util.function.Consumer<MeteringError> onError;
    private final BiConsumer<Map<String, Object>, java.util.List<Map<String, Object>>> onAccepted;
    private final ObjectMapper mapper = new ObjectMapper();
    private final TransportCore<Map<String, Object>> core;

    private AforoMqttBilling(Builder b) {
        this.tenantId = require(b.tenantId, "tenantId");
        this.productId = require(b.productId, "productId");
        this.apiKey = require(b.apiKey, "apiKey");
        this.productType = normalizeProductType(b.productType, DEFAULT_PRODUCT_TYPE);
        this.emitDeliverEvents = b.emitDeliverEvents;
        this.onDrop = b.onDrop;
        this.onError = b.onError;
        this.onAccepted = b.onAccepted;
        this.core = new TransportCore<>(TransportConfig.builder()
                .baseUrl(require(b.ingestorUrl, "ingestorUrl"))
                .apiKey(apiKey)
                .allowInsecureHttp(b.allowInsecureHttp)
                .compression(b.compression)
                .header("X-Tenant-Id", tenantId)
                .userAgent("aforo-java-mqtt/" + SDK_VERSION)
                .flushCount(b.flushCount)
                .flushIntervalMs(b.flushIntervalMs)
                .maxQueueSize(b.maxQueueSize)
                .maxRetries(b.maxRetries)
                .retryBaseMs(b.retryBaseMs)
                .timeoutMs(b.timeoutMs)
                .shutdownTimeoutMs(b.shutdownTimeoutMs)
                .breakerInitialMs(b.breakerCooldownMs)
                .threadName("aforo-mqtt-flush")
                .loggerName(AforoMqttBilling.class.getName())
                .logPrefix("[aforo-mqtt]")
                .build(),
                mapper::writeValueAsString,
                TransportCore.Listeners.<Map<String, Object>>builder()
                        .onDrop((events, reason) -> { if (onDrop != null) onDrop.accept(events, map(reason)); })
                        .onError(onError == null ? null : e -> onError.accept(
                                new MeteringError(map(e.kind()), e.message(), e.events(), e.status())))
                        .onAccepted(onAccepted == null ? null : (body, events) -> onAccepted.accept(asMap(body), events))
                        .build());
    }

    /**
     * PUBLISH event — call from your client.publish() wrapper.
     *
     * <p>For every {@code record*} method: {@code topic} and {@code clientId} originate
     * from the MQTT packet. A topic over 500 characters or a client id over 128 is
     * truncated to the limit and the event is still sent (one warning per label per
     * instance); the idempotency key is built from the full values. A
     * {@code customerId} over 64 characters still drops the event as
     * {@link DropReason#INVALID}.</p>
     */
    public void recordPublish(String customerId, String clientId, String topic, int qos, boolean retained, long bytes) {
        recordPublish(customerId, clientId, topic, qos, retained, bytes, null);
    }

    /**
     * PUBLISH event with an outcome status for OUTCOME_BASED pricing (each event
     * bills at the weight set for its status; events without one bill at full
     * price). The SDK never derives one — only the value you pass is sent.
     * Trimmed and upper-cased; {@code null} or blank leaves it off the event.
     * Accepted values: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED,
     * FAILED, FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED — the server
     * is authoritative; any other value is logged and left off the event. Every {@code record*} method
     * has the same trailing {@code executionStatus} overload.
     */
    public void recordPublish(String customerId, String clientId, String topic, int qos, boolean retained, long bytes,
                              String executionStatus) {
        push(eventOf(customerId, clientId, "PUBLISH", topic, qos, retained, bytes, executionStatus));
    }

    /** DELIVER event — call from your message-arrived callback. Skipped unless emitDeliverEvents=true. */
    public void recordDeliver(String customerId, String clientId, String topic, int qos, boolean retained, long bytes) {
        recordDeliver(customerId, clientId, topic, qos, retained, bytes, null);
    }

    /** DELIVER event with an explicit outcome status (see {@link #recordPublish(String, String, String, int, boolean, long, String)}). */
    public void recordDeliver(String customerId, String clientId, String topic, int qos, boolean retained, long bytes,
                              String executionStatus) {
        if (!emitDeliverEvents) return;
        push(eventOf(customerId, clientId, "DELIVER", topic, qos, retained, bytes, executionStatus));
    }

    /** SUBSCRIBE / UNSUBSCRIBE event. */
    public void recordSubscribe(String customerId, String clientId, String topicFilter, int qos) {
        recordSubscribe(customerId, clientId, topicFilter, qos, null);
    }

    /** SUBSCRIBE event with an explicit outcome status (see {@link #recordPublish(String, String, String, int, boolean, long, String)}). */
    public void recordSubscribe(String customerId, String clientId, String topicFilter, int qos, String executionStatus) {
        push(eventOf(customerId, clientId, "SUBSCRIBE", topicFilter, qos, false, 0, executionStatus));
    }

    public void recordUnsubscribe(String customerId, String clientId, String topicFilter) {
        recordUnsubscribe(customerId, clientId, topicFilter, null);
    }

    /** UNSUBSCRIBE event with an explicit outcome status (see {@link #recordPublish(String, String, String, int, boolean, long, String)}). */
    public void recordUnsubscribe(String customerId, String clientId, String topicFilter, String executionStatus) {
        push(eventOf(customerId, clientId, "UNSUBSCRIBE", topicFilter, 0, false, 0, executionStatus));
    }

    /**
     * CONNECT / DISCONNECT lifecycle markers. The ingestor requires {@code mqttTopic} on every
     * MQTT_BROKER event, so these carry the broker-style {@code $SYS/clients/<clientId>/connected}
     * (or {@code /disconnected}) topic.
     */
    public void recordConnect(String customerId, String clientId) {
        recordConnect(customerId, clientId, null);
    }

    /** CONNECT event with an explicit outcome status (see {@link #recordPublish(String, String, String, int, boolean, long, String)}). */
    public void recordConnect(String customerId, String clientId, String executionStatus) {
        push(eventOf(customerId, clientId, "CONNECT", lifecycleTopic(clientId, "connected"), 0, false, 0, executionStatus));
    }

    public void recordDisconnect(String customerId, String clientId) {
        recordDisconnect(customerId, clientId, null);
    }

    /** DISCONNECT event with an explicit outcome status (see {@link #recordPublish(String, String, String, int, boolean, long, String)}). */
    public void recordDisconnect(String customerId, String clientId, String executionStatus) {
        push(eventOf(customerId, clientId, "DISCONNECT", lifecycleTopic(clientId, "disconnected"), 0, false, 0, executionStatus));
    }

    /**
     * Canonical outcome statuses the ingestor accepts (contract/ingest-contract.json,
     * max 20 chars). Anything else would make it reject the event.
     */
    static final java.util.Set<String> ALLOWED_EXECUTION_STATUSES = java.util.Set.of(
            "SUCCESS", "PARTIAL", "TIMEOUT", "ERROR", "VALIDATION_FAILED", "FAILED",
            "FAILURE", "CANCELLED", "PENDING", "BLOCKED", "HITL_REQUIRED");

    /** Trim + upper-case; blank or {@code null} becomes {@code null} (omitted from the wire body). */
    static String normalizeExecutionStatus(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed.toUpperCase(java.util.Locale.ROOT);
    }

    /**
     * {@link #normalizeExecutionStatus} plus an allowlist check. An unknown value is
     * logged and returned as {@code null} so the field is left off the event — sending
     * it would make the ingestor reject the event, losing its usage.
     */
    static String canonicalExecutionStatus(String value) {
        String normalized = normalizeExecutionStatus(value);
        if (normalized == null || ALLOWED_EXECUTION_STATUSES.contains(normalized)) return normalized;
        LOG.warning("[aforo-mqtt] Ignoring unknown executionStatus \"" + normalized + "\" — expected one of "
                + new java.util.TreeSet<>(ALLOWED_EXECUTION_STATUSES) + "; the event is sent without it.");
        return null;
    }

    /** Request-derived labels already reported as truncated — one warning per label per instance. */
    private final java.util.Set<String> truncationWarned = java.util.concurrent.ConcurrentHashMap.newKeySet();

    /**
     * A label taken from the incoming request, cut to the ingestor's limit so the
     * event is still sent. Warns once per label. Not for caller-set fields.
     */
    private String boundedLabel(String label, String value, int max) {
        if (value == null || value.length() <= max) return value;
        if (truncationWarned.add(label)) {
            LOG.warning("[aforo-mqtt] " + label + " from the message was longer than " + max
                    + " characters and was truncated to " + max + "; the event is still sent."
                    + " Later truncations of " + label + " are not logged.");
        }
        return truncateLabel(value, max);
    }

    private static String lifecycleTopic(String clientId, String state) {
        // Built from the bounded client id so the "/connected" suffix survives an over-long id.
        return "$SYS/clients/" + (clientId == null || clientId.isBlank()
                ? "unknown" : truncateLabel(clientId, MAX_MQTT_CLIENT_ID)) + "/" + state;
    }

    private Map<String, Object> eventOf(String customerId, String clientId, String eventType, String topic,
                                        int qos, boolean retained, long bytes, String executionStatus) {
        Instant now = Instant.now();
        Map<String, Object> e = new HashMap<>();
        e.put("customerId", customerId);
        e.put("metricName", "mqtt_broker." + eventType.toLowerCase(java.util.Locale.ROOT));
        e.put("quantity", 1);
        e.put("occurredAt", now.toString());
        e.put("idempotencyKey", idempotencyKey("mqtt:" + tenantId + ":" + clientId + ":" + eventType + ":" + topic, now));
        e.put("productType", productType);
        e.put("mqttTopic", boundedLabel("mqttTopic", topic, MAX_MQTT_TOPIC));
        if (qos >= 0 && qos <= 2) e.put("mqttQos", qos);
        e.put("mqttRetained", retained);
        e.put("mqttEventType", eventType);
        if (clientId != null && !clientId.isBlank()) e.put("mqttClientId", boundedLabel("mqttClientId", clientId, MAX_MQTT_CLIENT_ID));
        e.put("dataBytes", bytes);
        String outcome = canonicalExecutionStatus(executionStatus);
        if (outcome != null) e.put("executionStatus", outcome);

        Map<String, Object> meta = new HashMap<>();
        meta.put("sdkVersion", SDK_VERSION);
        meta.put("productId", productId);
        e.put("metadata", meta);
        return e;
    }

    /**
     * customerId and a non-blank topic are required by the ingestor; an event without
     * them is dropped with {@link DropReason#INVALID} rather than sent to be rejected.
     */
    private void push(Map<String, Object> e) {
        if (!(e.get("customerId") instanceof String c) || c.isBlank()) {
            recordInvalid(e, "customerId is required");
            return;
        }
        if (!(e.get("mqttTopic") instanceof String t) || t.isBlank()) {
            recordInvalid(e, "mqttTopic is required (blank topic)");
            return;
        }
        enqueue(e);
    }

    /**
     * Why events were permanently dropped. An ingest outage does not drop anything: the
     * batch goes back to the queue with its idempotency keys and is resent after a
     * cooldown.
     * <ul>
     *   <li>{@code OVERFLOW} — the queue was full ({@link Builder#maxQueueSize(int)}); the oldest event was evicted</li>
     *   <li>{@code REJECTED} — the ingestor refused the batch (non-retryable 4xx) or this event in a partial response</li>
     *   <li>{@code INVALID} — the event breaks an ingestor field limit, or has no customer; it was never sent</li>
     *   <li>{@code SHUTDOWN} — still queued when {@link #close()} reached its shutdown deadline</li>
     *   <li>{@code CLOSED} — recorded after {@link #close()}</li>
     *   <li>{@code RETRY_EXHAUSTED} — kept for compatibility; only reported when a requeue is impossible</li>
     * </ul>
     */
    public enum DropReason { RETRY_EXHAUSTED, REJECTED, INVALID, OVERFLOW, SHUTDOWN, CLOSED }

    /** What a {@link MeteringError} is about. Branch on this, never on the message. */
    public enum ErrorKind {
        /** Ingestor unreachable, 408/429/5xx or a redirect after every retry; the events stay queued and are resent. */
        OUTAGE,
        /** 401/403: the API key is wrong or revoked; the events stay queued and are resent. */
        AUTH,
        /** The ingestor refused the events; they are dropped. */
        REJECTED,
        /** Still queued at the shutdown deadline; dropped. */
        SHUTDOWN,
        /** Recorded after {@code close()}; dropped. */
        CLOSED
    }

    /** A delivery problem reported to {@code Builder.onError}. The message never contains the API key. */
    public static final class MeteringError {
        private final ErrorKind kind;
        private final String message;
        private final java.util.List<Map<String, Object>> events;
        private final int status;

        MeteringError(ErrorKind kind, String message, java.util.List<Map<String, Object>> events, int status) {
            this.kind = kind;
            this.message = message;
            this.events = java.util.List.copyOf(events);
            this.status = status;
        }

        public ErrorKind kind() { return kind; }
        public String message() { return message; }
        /** The events concerned: the queued ones for OUTAGE/AUTH, the dropped ones otherwise (may be empty). */
        public java.util.List<Map<String, Object>> events() { return events; }
        /** HTTP status of the answer that caused the report, or 0. */
        public int status() { return status; }
        /** True when the events are still queued and will be resent. */
        public boolean willRetry() { return kind == ErrorKind.OUTAGE || kind == ErrorKind.AUTH; }

        @Override
        public String toString() {
            return "MeteringError{kind=" + kind + ", status=" + status + ", events=" + events.size()
                    + ", message=" + message + "}";
        }
    }

    private static ErrorKind map(TransportCore.ErrorKind kind) {
        return switch (kind) {
            case OUTAGE -> ErrorKind.OUTAGE;
            case AUTH -> ErrorKind.AUTH;
            case REJECTED -> ErrorKind.REJECTED;
            case SHUTDOWN -> ErrorKind.SHUTDOWN;
            case CLOSED -> ErrorKind.CLOSED;
        };
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object body) {
        return body instanceof Map<?, ?> m ? java.util.Collections.unmodifiableMap((Map<String, Object>) m) : Map.of();
    }

    private static DropReason map(TransportCore.Reason reason) {
        return switch (reason) {
            case OVERFLOW -> DropReason.OVERFLOW;
            case REJECTED -> DropReason.REJECTED;
            case INVALID -> DropReason.INVALID;
            case SHUTDOWN -> DropReason.SHUTDOWN;
            case CLOSED -> DropReason.CLOSED;
            case RETRY_EXHAUSTED -> DropReason.RETRY_EXHAUSTED;
        };
    }

    /** Number of events permanently dropped (every {@link DropReason}) since this instance was created. */
    public long droppedCount() { return core.droppedCount(); }

    /** Events waiting to be sent. */
    public int bufferedCount() { return core.size(); }


    /**
     * Ingestor field limits ({@code IngestUsageEventRequest} {@code @Size} constraints).
     * An event over one of these would be rejected server-side, so it is dropped
     * here instead. Caller-set fields are never truncated, because a truncated id
     * bills the wrong thing; the topic and client id, which originate from the MQTT
     * packet, are bounded before they get here (see {@code boundedLabel}).
     */
    private static final Map<String, Integer> FIELD_LIMITS = Map.ofEntries(
            Map.entry("customerId", 64), Map.entry("metricName", 255),
            Map.entry("idempotencyKey", 255), Map.entry("productType", 20),
            Map.entry("grpcService", 255), Map.entry("grpcMethod", 128),
            Map.entry("gqlOperationName", 255), Map.entry("wsConnectionId", 64),
            Map.entry("mqttTopic", 500), Map.entry("mqttClientId", 128));

    /** The first field limit this event breaks, or {@code null} when it is within every limit. */
    static String limitViolation(Map<String, Object> event) {
        for (String field : new java.util.TreeSet<>(FIELD_LIMITS.keySet())) {
            Object v = event.get(field);
            int max = FIELD_LIMITS.get(field);
            if (v instanceof String s && s.length() > max) {
                return field + " is " + s.length() + " characters, exceeding the ingestor's " + max
                        + "-character limit (value: \"" + (s.length() <= 80 ? s : s.substring(0, 80) + "...") + "\")";
            }
        }
        return null;
    }

    /**
     * An event the ingestor would refuse: not queued, not sent, counted in
     * {@link #droppedCount()}, logged (first, then every 1000th) and handed to the
     * onDrop hook with {@link DropReason#INVALID}.
     */
    private void recordInvalid(Map<String, Object> event, String violation) {
        core.dropInvalid(event, violation);
    }

    /** Buffers an event, or drops it as {@link DropReason#INVALID} when it breaks a field limit. */
    private void enqueue(Map<String, Object> event) {
        String violation = limitViolation(event);
        if (violation != null) {
            recordInvalid(event, violation);
            return;
        }
        core.track(event);
    }

    /**
     * Sends what is queued until the shutdown deadline ({@link Builder#shutdownTimeoutMs(long)},
     * default 5 s), then stops the background thread and the HTTP client. Events left at the
     * deadline are reported as {@link DropReason#SHUTDOWN}. Idempotent.
     */
    @Override
    public void close() {
        core.close();
    }

    /**
     * Joins {@code natural:suffix}. The key is minted once per event, here, from the
     * untruncated inputs; a retry resends the serialized event and so the same key.
     */
    private static String idempotencyKey(String natural, Instant now) {
        String suffix = now.toEpochMilli() + ":" + UUID.randomUUID().toString().substring(0, 8);
        return fitKeyPart(natural, MAX_IDEMPOTENCY_KEY - suffix.length() - 1) + ":" + suffix;
    }

    /**
     * {@code natural} unchanged when it fits in {@code room} characters. Otherwise its
     * head followed by {@code ":"} and the SHA-256 hex digest of the whole value, exactly
     * {@code room} characters or one fewer: the same input always gives the same result,
     * and two inputs that share a long prefix give different ones. Nothing is cut off
     * without being covered by the digest.
     */
    static String fitKeyPart(String natural, int room) {
        if (natural.length() <= room) return natural;
        String digest = sha256Hex(natural);
        return truncateLabel(natural, Math.max(room - digest.length() - 1, 0)) + ":" + digest;
    }

    static String sha256Hex(String value) {
        try {
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required by every Java runtime", e);
        }
    }

    /**
     * {@code value} cut to at most {@code max} UTF-16 code units — the unit the
     * ingestor's {@code @Size} counts. A surrogate pair is never split: when the cut
     * would land inside one, the result is one unit shorter.
     */
    static String truncateLabel(String value, int max) {
        if (value == null || value.length() <= max) return value;
        int end = Math.max(max, 0);
        if (end > 0 && Character.isHighSurrogate(value.charAt(end - 1))
                && Character.isLowSurrogate(value.charAt(end))) {
            end--;
        }
        return value.substring(0, end);
    }

    /** Trim + uppercase; {@code fallback} for null/blank. Unknown values pass through. */
    private static String normalizeProductType(String s, String fallback) {
        return s == null || s.isBlank() ? fallback : s.trim().toUpperCase(java.util.Locale.ROOT);
    }

    private static String require(String s, String name) {
        if (s == null || s.isBlank()) throw new IllegalArgumentException(name + " is required");
        return s;
    }


    /** The client-level {@code productType} stamped on events without a per-call override. */
    public String getProductType() { return productType; }

    public static Builder newBuilder() { return new Builder(); }

    public static final class Builder {
        private String productType;
        private String tenantId, productId, apiKey, ingestorUrl;
        private boolean emitDeliverEvents = false;
        private int flushCount = TransportConfig.DEFAULT_FLUSH_COUNT;
        private long flushIntervalMs = TransportConfig.DEFAULT_FLUSH_INTERVAL_MS;
        private int maxQueueSize = TransportConfig.DEFAULT_QUEUE_CAPACITY;
        private int maxRetries = TransportConfig.DEFAULT_MAX_RETRIES;
        private long retryBaseMs = TransportConfig.DEFAULT_RETRY_BASE_MS;
        private long timeoutMs = TransportConfig.DEFAULT_TIMEOUT_MS;
        private long shutdownTimeoutMs = TransportConfig.DEFAULT_SHUTDOWN_TIMEOUT_MS;
        private long breakerCooldownMs = TransportConfig.DEFAULT_BREAKER_INITIAL_MS;
        private boolean allowInsecureHttp;
        private String compression = "gzip";
        private BiConsumer<java.util.List<Map<String, Object>>, DropReason> onDrop;
        private java.util.function.Consumer<MeteringError> onError;
        private BiConsumer<Map<String, Object>, java.util.List<Map<String, Object>>> onAccepted;

        public Builder tenantId(String s) { this.tenantId = s; return this; }
        public Builder productId(String s) { this.productId = s; return this; }
        public Builder apiKey(String s) { this.apiKey = s; return this; }
        /**
         * Top-level {@code productType} on every event (default {@code MQTT_BROKER}).
         * Trimmed and uppercased; unknown values are passed through.
         */
        public Builder productType(String s) { this.productType = s; return this; }
        public Builder ingestorUrl(String s) { this.ingestorUrl = s; return this; }
        public Builder emitDeliverEvents(boolean b) { this.emitDeliverEvents = b; return this; }
        /** Events per request (default 500, at most 1000). */
        public Builder flushCount(int n) { this.flushCount = n; return this; }
        /** How often queued events are sent when the batch is not full (default 5 s). */
        public Builder flushIntervalMs(long n) { this.flushIntervalMs = n; return this; }
        /** Queue capacity (default 10 000). When full, the oldest event is dropped as {@code OVERFLOW}. */
        public Builder maxQueueSize(int n) { this.maxQueueSize = n; return this; }
        /** Retries per request on a network error, timeout, 408, 429 or 5xx (default 3). */
        public Builder maxRetries(int n) { this.maxRetries = n; return this; }
        /** Base of the full-jitter retry backoff (default 500 ms). */
        public Builder retryBaseMs(long n) { this.retryBaseMs = n; return this; }
        /** Total deadline of one ingest request (default 10 s). */
        public Builder timeoutMs(long n) { this.timeoutMs = n; return this; }
        /** How long {@link #close()} keeps sending queued events (default 5 s). */
        public Builder shutdownTimeoutMs(long n) { this.shutdownTimeoutMs = n; return this; }
        /** First pause after the ingestor stays unreachable through every retry (default 5 s, doubling to 5 min). */
        public Builder breakerCooldownMs(long n) { this.breakerCooldownMs = n; return this; }
        /** Allow a plain http:// ingestor URL on a host other than localhost. Off by default: the API key is in every request. */
        public Builder allowInsecureHttp(boolean b) { this.allowInsecureHttp = b; return this; }
        /** "gzip" (default): batches of 1 KiB or more are sent with Content-Encoding: gzip (needs usage-ingestor wave 8 or later); "none": always plain JSON. */
        public Builder compression(String c) { this.compression = c; return this; }
        /**
         * Opt-in hook receiving events that were permanently dropped (retry
         * exhaustion, a terminal rejection, or an event that breaks an ingestor
         * field limit — {@code DropReason.INVALID}). Events keep their idempotency
         * keys, so persisting and re-submitting them after recovery is
         * dedup-safe. Exceptions thrown by the hook are swallowed. Default:
         * none (drops are still counted in droppedCount() and WARN-logged).
         */
        public Builder onDrop(BiConsumer<java.util.List<Map<String, Object>>, DropReason> fn) { this.onDrop = fn; return this; }
        /**
         * Opt-in hook for delivery problems, typed by {@link MeteringError#kind()}. Runs on the
         * background sender thread; it may call {@code close()}. Exceptions are caught and logged.
         */
        public Builder onError(java.util.function.Consumer<MeteringError> fn) { this.onError = fn; return this; }
        /**
         * Opt-in hook receiving the envelope-unwrapped body of every accepted (2xx) batch (empty
         * when the body was not a JSON object). Runs on the sender thread; exceptions are caught and logged.
         */
        public Builder onAccepted(BiConsumer<Map<String, Object>, java.util.List<Map<String, Object>>> fn) { this.onAccepted = fn; return this; }
        public AforoMqttBilling build() { return new AforoMqttBilling(this); }
    }
}
