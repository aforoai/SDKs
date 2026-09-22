package com.aforo.mqtt;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Level;
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
    private static final String SDK_VERSION = "1.0.0";
    /** The ingestor rejects {@code /v1/ingest/batch} requests with more than 1000 events. */
    static final int MAX_EVENTS_PER_REQUEST = 1000;
    private static final int MAX_CUSTOMER_ID = 64;
    private static final int MAX_IDEMPOTENCY_KEY = 255;
    /** Default top-level {@code productType}; override with {@link Builder#productType(String)}. */
    public static final String DEFAULT_PRODUCT_TYPE = "MQTT_BROKER";

    private final String tenantId, productId, apiKey;
    private final URI ingestorUri;
    private final String productType;
    private final boolean emitDeliverEvents;
    private final int flushCount;
    private final long flushIntervalMs;

    private final ConcurrentLinkedQueue<Map<String, Object>> buffer = new ConcurrentLinkedQueue<>();
    private final AtomicInteger bufferSize = new AtomicInteger();
    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "aforo-mqtt-flush");
        t.setDaemon(true);
        return t;
    });

    private AforoMqttBilling(Builder b) {
        this.tenantId = require(b.tenantId, "tenantId");
        this.productId = require(b.productId, "productId");
        this.apiKey = require(b.apiKey, "apiKey");
        this.ingestorUri = URI.create(stripTrailingSlash(require(b.ingestorUrl, "ingestorUrl")) + "/v1/ingest/batch");
        this.productType = normalizeProductType(b.productType, DEFAULT_PRODUCT_TYPE);
        this.emitDeliverEvents = b.emitDeliverEvents;
        this.flushCount = b.flushCount;
        this.flushIntervalMs = b.flushIntervalMs;
        scheduler.scheduleAtFixedRate(this::flushQuietly, flushIntervalMs, flushIntervalMs, TimeUnit.MILLISECONDS);
    }

    /** PUBLISH event — call from your client.publish() wrapper. */
    public void recordPublish(String customerId, String clientId, String topic, int qos, boolean retained, long bytes) {
        push(eventOf(customerId, clientId, "PUBLISH", topic, qos, retained, bytes));
    }

    /** DELIVER event — call from your message-arrived callback. Skipped unless emitDeliverEvents=true. */
    public void recordDeliver(String customerId, String clientId, String topic, int qos, boolean retained, long bytes) {
        if (!emitDeliverEvents) return;
        push(eventOf(customerId, clientId, "DELIVER", topic, qos, retained, bytes));
    }

    /** SUBSCRIBE / UNSUBSCRIBE event. */
    public void recordSubscribe(String customerId, String clientId, String topicFilter, int qos) {
        push(eventOf(customerId, clientId, "SUBSCRIBE", topicFilter, qos, false, 0));
    }

    public void recordUnsubscribe(String customerId, String clientId, String topicFilter) {
        push(eventOf(customerId, clientId, "UNSUBSCRIBE", topicFilter, 0, false, 0));
    }

    /**
     * CONNECT / DISCONNECT lifecycle markers. The ingestor requires {@code mqttTopic} on every
     * MQTT_BROKER event, so these carry the broker-style {@code $SYS/clients/<clientId>/connected}
     * (or {@code /disconnected}) topic.
     */
    public void recordConnect(String customerId, String clientId) {
        push(eventOf(customerId, clientId, "CONNECT", lifecycleTopic(clientId, "connected"), 0, false, 0));
    }

    public void recordDisconnect(String customerId, String clientId) {
        push(eventOf(customerId, clientId, "DISCONNECT", lifecycleTopic(clientId, "disconnected"), 0, false, 0));
    }

    private static String lifecycleTopic(String clientId, String state) {
        return "$SYS/clients/" + (clientId == null || clientId.isBlank() ? "unknown" : clientId) + "/" + state;
    }

    private Map<String, Object> eventOf(String customerId, String clientId, String eventType, String topic,
                                        int qos, boolean retained, long bytes) {
        // customerId and a non-blank topic are required by the ingestor; drop rather than
        // send an event that would be rejected.
        if (!validCustomerId(customerId) || topic == null || topic.isBlank()) return null;
        Instant now = Instant.now();
        Map<String, Object> e = new HashMap<>();
        e.put("customerId", customerId);
        e.put("metricName", "mqtt_broker." + eventType.toLowerCase());
        e.put("quantity", 1);
        e.put("occurredAt", now.toString());
        e.put("idempotencyKey", idempotencyKey("mqtt:" + tenantId + ":" + clientId + ":" + eventType + ":" + topic, now));
        e.put("productType", productType);
        e.put("mqttTopic", truncate(topic, 500));
        if (qos >= 0 && qos <= 2) e.put("mqttQos", qos);
        e.put("mqttRetained", retained);
        e.put("mqttEventType", eventType);
        if (clientId != null && !clientId.isBlank()) e.put("mqttClientId", truncate(clientId, 128));
        e.put("dataBytes", bytes);

        Map<String, Object> meta = new HashMap<>();
        meta.put("sdkVersion", SDK_VERSION);
        meta.put("productId", productId);
        e.put("metadata", meta);
        return e;
    }

    private void push(Map<String, Object> e) {
        if (e == null) return;
        buffer.offer(e);
        if (bufferSize.incrementAndGet() >= flushCount) {
            scheduler.execute(this::flushQuietly);
        }
    }

    private void flushQuietly() {
        try { flush(); } catch (Exception e) { LOG.log(Level.WARNING, "[aforo-mqtt] flush failed", e); }
    }

    private void flush() throws Exception {
        if (bufferSize.get() == 0) return;
        java.util.List<Map<String, Object>> batch = new java.util.ArrayList<>();
        Map<String, Object> ev;
        while ((ev = buffer.poll()) != null) { batch.add(ev); bufferSize.decrementAndGet(); }
        if (batch.isEmpty()) return;

        // Slice into requests of at most MAX_EVENTS_PER_REQUEST; a failed slice does
        // not stop the remaining slices from being delivered.
        Exception failure = null;
        for (int from = 0; from < batch.size(); from += MAX_EVENTS_PER_REQUEST) {
            try {
                send(batch.subList(from, Math.min(batch.size(), from + MAX_EVENTS_PER_REQUEST)));
            } catch (Exception e) {
                failure = e;
            }
        }
        if (failure != null) throw failure;
    }

    /** POSTs one slice. The body is serialized once, so every retry resends the same idempotency keys. */
    private void send(java.util.List<Map<String, Object>> events) throws Exception {
        String body = mapper.writeValueAsString(Map.of("events", events));
        HttpRequest req = HttpRequest.newBuilder(ingestorUri)
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .header("X-API-Key", apiKey)
                .header("X-Tenant-Id", tenantId)
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        for (int attempt = 1; attempt <= 3; attempt++) {
            long delayMs = (long) Math.pow(2, attempt - 1) * 1000;
            try {
                HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
                int status = resp.statusCode();
                if (status >= 200 && status < 300) {
                    String rejected = errorMessages(resp.body());
                    if (!rejected.isEmpty()) LOG.warning("[aforo-mqtt] ingestor rejected events:" + rejected);
                    return;
                }
                // 4xx other than 408/429 (bad key, invalid event, unknown metric) cannot succeed on retry.
                if (status >= 400 && status < 500 && status != 408 && status != 429) {
                    LOG.warning("[aforo-mqtt] ingestor returned " + status + " — not retrying, dropped "
                            + events.size() + " events" + errorMessages(resp.body()));
                    return;
                }
                if (status == 429) delayMs = retryAfterMs(resp, delayMs);
            } catch (Exception e) {
                if (attempt == 3) throw e;
            }
            if (attempt < 3) Thread.sleep(delayMs);
        }
        LOG.warning("[aforo-mqtt] flush exhausted retries — dropped " + events.size() + " events");
    }

    /** {@code errors[].message} from an ingestor batch response, formatted for a log line; "" if none. */
    private String errorMessages(String body) {
        if (body == null || body.isBlank()) return "";
        try {
            com.fasterxml.jackson.databind.JsonNode errors = mapper.readTree(body).path("errors");
            if (!errors.isArray() || errors.isEmpty()) return "";
            StringBuilder sb = new StringBuilder();
            for (com.fasterxml.jackson.databind.JsonNode err : errors) {
                sb.append(" [");
                if (err.has("index")) sb.append(err.get("index").asText()).append(": ");
                sb.append(err.path("message").asText("")).append(']');
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** Honours a delta-seconds {@code Retry-After} header on 429; otherwise keeps {@code fallbackMs}. */
    private static long retryAfterMs(HttpResponse<String> resp, long fallbackMs) {
        String retryAfter = resp.headers().firstValue("Retry-After").orElse(null);
        if (retryAfter == null) return fallbackMs;
        try {
            return Math.max(0, Long.parseLong(retryAfter.trim())) * 1000;
        } catch (NumberFormatException e) {
            return fallbackMs;
        }
    }

    @Override
    public void close() {
        scheduler.shutdown();
        try {
            flushQuietly();
            if (!scheduler.awaitTermination(5, TimeUnit.SECONDS)) scheduler.shutdownNow();
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    /** True when {@code customerId} satisfies the ingestor (non-blank, at most 64 chars). */
    private static boolean validCustomerId(String customerId) {
        return customerId != null && !customerId.isBlank() && customerId.length() <= MAX_CUSTOMER_ID;
    }

    /** Joins {@code natural:suffix}, trimming {@code natural} so the key stays within 255 chars. */
    private static String idempotencyKey(String natural, Instant now) {
        String suffix = now.toEpochMilli() + ":" + UUID.randomUUID().toString().substring(0, 8);
        int room = MAX_IDEMPOTENCY_KEY - suffix.length() - 1;
        return (natural.length() > room ? natural.substring(0, room) : natural) + ":" + suffix;
    }

    private static String truncate(String s, int max) {
        return s == null || s.length() <= max ? s : s.substring(0, max);
    }

    /** Trim + uppercase; {@code fallback} for null/blank. Unknown values pass through. */
    private static String normalizeProductType(String s, String fallback) {
        return s == null || s.isBlank() ? fallback : s.trim().toUpperCase(java.util.Locale.ROOT);
    }

    private static String require(String s, String name) {
        if (s == null || s.isBlank()) throw new IllegalArgumentException(name + " is required");
        return s;
    }

    private static String stripTrailingSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    /** The client-level {@code productType} stamped on events without a per-call override. */
    public String getProductType() { return productType; }

    public static Builder newBuilder() { return new Builder(); }

    public static final class Builder {
        private String productType;
        private String tenantId, productId, apiKey, ingestorUrl;
        private boolean emitDeliverEvents = false;
        private int flushCount = 200;
        private long flushIntervalMs = 2_000L;

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
        public Builder flushCount(int n) { this.flushCount = n; return this; }
        public Builder flushIntervalMs(long n) { this.flushIntervalMs = n; return this; }
        public AforoMqttBilling build() { return new AforoMqttBilling(this); }
    }
}
