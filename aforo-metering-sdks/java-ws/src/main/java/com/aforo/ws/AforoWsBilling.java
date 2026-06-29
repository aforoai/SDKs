package com.aforo.ws;

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
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Aforo WebSocket Metering SDK for Java.
 *
 * <p>Framework-agnostic — call {@code openConnection}, {@code recordFrame},
 * and {@code closeConnection} from your Jakarta WebSocket {@code @OnOpen} /
 * {@code @OnMessage} / {@code @OnClose} handlers (or Spring WebSocket
 * equivalents). The SDK aggregates per-connection counters in memory and
 * emits one CONNECTION_OPENED + one CONNECTION_CLOSED billing event with
 * the totals (or per-frame events when {@code perFrameEvents=true}).</p>
 */
public final class AforoWsBilling implements AutoCloseable {

    private static final Logger LOG = Logger.getLogger(AforoWsBilling.class.getName());
    private static final String SDK_VERSION = "1.0.0";

    private final String tenantId, productId, apiKey;
    private final URI ingestorUri;
    private final boolean perFrameEvents;
    private final int flushCount;
    private final long flushIntervalMs;

    private final ConcurrentHashMap<String, ConnectionState> active = new ConcurrentHashMap<>();
    private final ConcurrentLinkedQueue<Map<String, Object>> buffer = new ConcurrentLinkedQueue<>();
    private final AtomicInteger bufferSize = new AtomicInteger();
    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "aforo-ws-flush");
        t.setDaemon(true);
        return t;
    });

    private AforoWsBilling(Builder b) {
        this.tenantId = require(b.tenantId, "tenantId");
        this.productId = require(b.productId, "productId");
        this.apiKey = require(b.apiKey, "apiKey");
        this.ingestorUri = URI.create(stripTrailingSlash(require(b.ingestorUrl, "ingestorUrl")) + "/v1/ingest/events");
        this.perFrameEvents = b.perFrameEvents;
        this.flushCount = b.flushCount;
        this.flushIntervalMs = b.flushIntervalMs;
        scheduler.scheduleAtFixedRate(this::flushQuietly, flushIntervalMs, flushIntervalMs, TimeUnit.MILLISECONDS);
    }

    /** Open a billing-tracked connection. Returns the synthetic connection ID. */
    public String openConnection(String customerId, Map<String, Object> metadata) {
        if (customerId == null || customerId.isBlank()) return null;
        String connectionId = UUID.randomUUID().toString();
        active.put(connectionId, new ConnectionState(customerId, System.currentTimeMillis(), metadata));
        // Merge caller metadata into the OPEN marker so per-connection tags (region,
        // userAgent, deviceClass...) are on both the OPEN event and the eventual CLOSE event.
        Map<String, Object> openMeta = new HashMap<>(metadata == null ? Map.of() : metadata);
        openMeta.put("event", "CONNECTION_OPENED");
        push(connEvent(customerId, connectionId, "PING", "SERVER_TO_CLIENT", 0, 0, 0, null, openMeta));
        return connectionId;
    }

    /** Record an outbound or inbound frame on an active connection. */
    public void recordFrame(String connectionId, String direction, String frameType, long bytes) {
        if (connectionId == null) return;
        ConnectionState s = active.get(connectionId);
        if (s == null) return;
        s.frames.incrementAndGet();
        s.bytes.addAndGet(bytes);
        if (perFrameEvents) {
            push(connEvent(s.customerId, connectionId, frameType, direction, 1, bytes,
                    System.currentTimeMillis() - s.startMs, null, s.metadata));
        }
    }

    /** Close a billing-tracked connection — emits the CONNECTION_CLOSED event with aggregated counters. */
    public void closeConnection(String connectionId, int closeCode) {
        if (connectionId == null) return;
        ConnectionState s = active.remove(connectionId);
        if (s == null) return;
        long durationMs = System.currentTimeMillis() - s.startMs;
        String reason = mapCloseReason(closeCode);
        Map<String, Object> meta = new HashMap<>(s.metadata == null ? Map.of() : s.metadata);
        meta.put("event", "CONNECTION_CLOSED");
        meta.put("frames", s.frames.get());
        meta.put("bytes", s.bytes.get());
        meta.put("closeCode", closeCode);
        push(connEvent(s.customerId, connectionId, "CLOSE", "SERVER_TO_CLIENT",
                (int) Math.min(s.frames.get(), Integer.MAX_VALUE), s.bytes.get(), durationMs, reason, meta));
    }

    private void push(Map<String, Object> event) {
        buffer.offer(event);
        if (bufferSize.incrementAndGet() >= flushCount) {
            scheduler.execute(this::flushQuietly);
        }
    }

    private Map<String, Object> connEvent(String customerId, String connectionId, String frameType,
                                          String direction, int frames, long bytes, long durationMs,
                                          String closeReason, Map<String, Object> metadata) {
        Instant now = Instant.now();
        Map<String, Object> e = new HashMap<>();
        e.put("customerId", customerId);
        e.put("metricName", "CLOSE".equals(frameType)
                ? "websocket_api.connection_closed" : "websocket_api.message");
        e.put("quantity", 1);
        e.put("occurredAt", now.toString());
        e.put("idempotencyKey", "ws:" + tenantId + ":" + connectionId + ":" + frameType + ":"
                + now.toEpochMilli() + ":" + UUID.randomUUID().toString().substring(0, 8));
        e.put("productType", "WEBSOCKET_API");
        e.put("wsConnectionId", connectionId);
        e.put("wsDirection", direction);
        e.put("wsFrameType", frameType);
        e.put("messageCount", frames);
        e.put("dataBytes", bytes);
        e.put("durationMs", durationMs);
        if (closeReason != null) e.put("wsCloseReason", closeReason);

        Map<String, Object> meta = new HashMap<>();
        if (metadata != null) meta.putAll(metadata);
        meta.put("sdkVersion", SDK_VERSION);
        meta.put("productId", productId);
        e.put("metadata", meta);
        return e;
    }

    private static String mapCloseReason(int code) {
        return switch (code) {
            case 1000 -> "NORMAL_CLOSURE";
            case 1001 -> "GOING_AWAY";
            case 1002, 1007 -> "PROTOCOL_ERROR";
            case 1003 -> "UNSUPPORTED_DATA";
            case 1006 -> "ABNORMAL_CLOSURE";
            case 1008 -> "POLICY_VIOLATION";
            case 1009 -> "MESSAGE_TOO_BIG";
            case 1011 -> "INTERNAL_ERROR";
            default -> code >= 4000 ? "IDLE_TIMEOUT" : "NORMAL_CLOSURE";
        };
    }

    private void flushQuietly() {
        try { flush(); } catch (Exception e) { LOG.log(Level.WARNING, "[aforo-ws] flush failed", e); }
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
        LOG.warning("[aforo-ws] flush exhausted retries — dropped " + batch.size() + " events");
    }

    @Override
    public void close() {
        scheduler.shutdown();
        try {
            flushQuietly();
            if (!scheduler.awaitTermination(5, TimeUnit.SECONDS)) scheduler.shutdownNow();
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    private static class ConnectionState {
        final String customerId;
        final long startMs;
        final Map<String, Object> metadata;
        final AtomicLong frames = new AtomicLong();
        final AtomicLong bytes = new AtomicLong();

        ConnectionState(String customerId, long startMs, Map<String, Object> metadata) {
            this.customerId = customerId;
            this.startMs = startMs;
            this.metadata = metadata;
        }
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
        private boolean perFrameEvents = false;
        private int flushCount = 100;
        private long flushIntervalMs = 3_000L;

        public Builder tenantId(String s) { this.tenantId = s; return this; }
        public Builder productId(String s) { this.productId = s; return this; }
        public Builder apiKey(String s) { this.apiKey = s; return this; }
        public Builder ingestorUrl(String s) { this.ingestorUrl = s; return this; }
        public Builder perFrameEvents(boolean b) { this.perFrameEvents = b; return this; }
        public Builder flushCount(int n) { this.flushCount = n; return this; }
        public Builder flushIntervalMs(long n) { this.flushIntervalMs = n; return this; }
        public AforoWsBilling build() { return new AforoWsBilling(this); }
    }
}
