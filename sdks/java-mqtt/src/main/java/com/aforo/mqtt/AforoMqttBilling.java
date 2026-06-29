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

    private final String tenantId, productId, apiKey;
    private final URI ingestorUri;
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
        this.ingestorUri = URI.create(stripTrailingSlash(require(b.ingestorUrl, "ingestorUrl")) + "/v1/ingest/events");
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

    /** CONNECT / DISCONNECT lifecycle markers. */
    public void recordConnect(String customerId, String clientId) {
        push(eventOf(customerId, clientId, "CONNECT", "", 0, false, 0));
    }

    public void recordDisconnect(String customerId, String clientId) {
        push(eventOf(customerId, clientId, "DISCONNECT", "", 0, false, 0));
    }

    private Map<String, Object> eventOf(String customerId, String clientId, String eventType, String topic,
                                        int qos, boolean retained, long bytes) {
        Instant now = Instant.now();
        Map<String, Object> e = new HashMap<>();
        e.put("customerId", customerId);
        e.put("metricName", "mqtt_broker." + eventType.toLowerCase());
        e.put("quantity", 1);
        e.put("occurredAt", now.toString());
        e.put("idempotencyKey", "mqtt:" + tenantId + ":" + clientId + ":" + eventType + ":" + topic + ":"
                + now.toEpochMilli() + ":" + UUID.randomUUID().toString().substring(0, 8));
        e.put("productType", "MQTT_BROKER");
        e.put("mqttTopic", topic);
        e.put("mqttQos", qos);
        e.put("mqttRetained", retained);
        e.put("mqttEventType", eventType);
        e.put("mqttClientId", clientId);
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

        String body = mapper.writeValueAsString(Map.of("events", batch));
        HttpRequest req = HttpRequest.newBuilder(ingestorUri)
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .header("X-Tenant-Id", tenantId)
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        for (int attempt = 1; attempt <= 3; attempt++) {
            try {
                HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
                if (resp.statusCode() >= 200 && resp.statusCode() < 300) return;
            } catch (Exception e) {
                if (attempt == 3) throw e;
            }
            Thread.sleep((long) Math.pow(2, attempt - 1) * 1000);
        }
        LOG.warning("[aforo-mqtt] flush exhausted retries — dropped " + batch.size() + " events");
    }

    @Override
    public void close() {
        scheduler.shutdown();
        try {
            flushQuietly();
            if (!scheduler.awaitTermination(5, TimeUnit.SECONDS)) scheduler.shutdownNow();
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    private static String require(String s, String name) {
        if (s == null || s.isBlank()) throw new IllegalArgumentException(name + " is required");
        return s;
    }

    private static String stripTrailingSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    public static Builder newBuilder() { return new Builder(); }

    public static final class Builder {
        private String tenantId, productId, apiKey, ingestorUrl;
        private boolean emitDeliverEvents = false;
        private int flushCount = 200;
        private long flushIntervalMs = 2_000L;

        public Builder tenantId(String s) { this.tenantId = s; return this; }
        public Builder productId(String s) { this.productId = s; return this; }
        public Builder apiKey(String s) { this.apiKey = s; return this; }
        public Builder ingestorUrl(String s) { this.ingestorUrl = s; return this; }
        public Builder emitDeliverEvents(boolean b) { this.emitDeliverEvents = b; return this; }
        public Builder flushCount(int n) { this.flushCount = n; return this; }
        public Builder flushIntervalMs(long n) { this.flushIntervalMs = n; return this; }
        public AforoMqttBilling build() { return new AforoMqttBilling(this); }
    }
}
