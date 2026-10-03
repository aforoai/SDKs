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
import java.util.function.BiConsumer;
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
    private static final String SDK_VERSION = "1.2.1";
    /** The ingestor rejects {@code /v1/ingest/batch} requests with more than 1000 events. */
    static final int MAX_EVENTS_PER_REQUEST = 1000;
    private static final int MAX_IDEMPOTENCY_KEY = 255;
    /** Default top-level {@code productType}; override with {@link Builder#productType(String)}. */
    public static final String DEFAULT_PRODUCT_TYPE = "WEBSOCKET_API";

    private final String tenantId, productId, apiKey;
    private final URI ingestorUri;
    private final String productType;
    private final boolean perFrameEvents;
    private final int flushCount;
    private final long flushIntervalMs;

    private final ConcurrentHashMap<String, ConnectionState> active = new ConcurrentHashMap<>();
    private final ConcurrentLinkedQueue<Map<String, Object>> buffer = new ConcurrentLinkedQueue<>();
    private final AtomicInteger bufferSize = new AtomicInteger();
    private final AtomicLong dropped = new AtomicLong();
    private final BiConsumer<java.util.List<Map<String, Object>>, DropReason> onDrop;
    /** Retry backoff base in ms — package-private so tests can skip real sleeps. */
    long retryBackoffBaseMs = 1000L;
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
        this.ingestorUri = URI.create(stripTrailingSlash(require(b.ingestorUrl, "ingestorUrl")) + "/v1/ingest/batch");
        this.productType = normalizeProductType(b.productType, DEFAULT_PRODUCT_TYPE);
        this.perFrameEvents = b.perFrameEvents;
        this.flushCount = b.flushCount;
        this.flushIntervalMs = b.flushIntervalMs;
        this.onDrop = b.onDrop;
        scheduler.scheduleAtFixedRate(this::flushQuietly, flushIntervalMs, flushIntervalMs, TimeUnit.MILLISECONDS);
    }

    /** Open a billing-tracked connection. Returns the synthetic connection ID. */
    public String openConnection(String customerId, Map<String, Object> metadata) {
        return openConnection(customerId, metadata, null);
    }

    /**
     * Open a billing-tracked connection, tagging the CONNECTION_OPENED event with
     * an outcome status for OUTCOME_BASED pricing (see {@link #closeConnection(String, int, String)}).
     * Returns the synthetic connection ID.
     */
    public String openConnection(String customerId, Map<String, Object> metadata, String executionStatus) {
        if (customerId == null || customerId.isBlank()) return null;
        String connectionId = UUID.randomUUID().toString();
        active.put(connectionId, new ConnectionState(customerId, System.currentTimeMillis(), metadata));
        // Merge caller metadata into the OPEN marker so per-connection tags (region,
        // userAgent, deviceClass...) are on both the OPEN event and the eventual CLOSE event.
        Map<String, Object> openMeta = new HashMap<>(metadata == null ? Map.of() : metadata);
        openMeta.put("event", "CONNECTION_OPENED");
        push(connEvent(customerId, connectionId, "PING", "SERVER_TO_CLIENT", 0, 0, 0, null, openMeta,
                canonicalExecutionStatus(executionStatus)));
        return connectionId;
    }

    /** Record an outbound or inbound frame on an active connection. */
    public void recordFrame(String connectionId, String direction, String frameType, long bytes) {
        recordFrame(connectionId, direction, frameType, bytes, null);
    }

    /**
     * Record a frame, tagging its per-frame event (only emitted when
     * {@code perFrameEvents=true}) with an outcome status for OUTCOME_BASED
     * pricing (see {@link #closeConnection(String, int, String)}).
     */
    public void recordFrame(String connectionId, String direction, String frameType, long bytes,
                            String executionStatus) {
        if (connectionId == null) return;
        ConnectionState s = active.get(connectionId);
        if (s == null) return;
        s.frames.incrementAndGet();
        s.bytes.addAndGet(bytes);
        if (perFrameEvents) {
            push(connEvent(s.customerId, connectionId, frameType, direction, 1, bytes,
                    System.currentTimeMillis() - s.startMs, null, s.metadata,
                    canonicalExecutionStatus(executionStatus)));
        }
    }

    /** Close a billing-tracked connection — emits the CONNECTION_CLOSED event with aggregated counters. */
    public void closeConnection(String connectionId, int closeCode) {
        closeConnection(connectionId, closeCode, null);
    }

    /**
     * Close a billing-tracked connection with an outcome status for OUTCOME_BASED
     * pricing (each event bills at the weight set for its status; events without
     * one bill at full price). The SDK never derives one from the close code —
     * only the value you pass is sent. Trimmed and upper-cased; {@code null} or
     * blank leaves it off the event. Accepted values: SUCCESS, PARTIAL, TIMEOUT,
     * ERROR, VALIDATION_FAILED, FAILED, FAILURE, CANCELLED, PENDING, BLOCKED,
     * HITL_REQUIRED. Any other value is logged and left off the event.
     */
    public void closeConnection(String connectionId, int closeCode, String executionStatus) {
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
                (int) Math.min(s.frames.get(), Integer.MAX_VALUE), s.bytes.get(), durationMs, reason, meta,
                canonicalExecutionStatus(executionStatus)));
    }

    private void push(Map<String, Object> event) {
        enqueue(event);
    }

    private Map<String, Object> connEvent(String customerId, String connectionId, String frameType,
                                          String direction, int frames, long bytes, long durationMs,
                                          String closeReason, Map<String, Object> metadata,
                                          String executionStatus) {
        Instant now = Instant.now();
        Map<String, Object> e = new HashMap<>();
        e.put("customerId", customerId);
        e.put("metricName", "CLOSE".equals(frameType)
                ? "websocket_api.connection_closed" : "websocket_api.message");
        e.put("quantity", 1);
        e.put("occurredAt", now.toString());
        e.put("idempotencyKey", idempotencyKey("ws:" + tenantId + ":" + connectionId + ":" + frameType, now));
        e.put("productType", productType);
        e.put("wsConnectionId", connectionId);
        e.put("messageCount", frames);
        e.put("dataBytes", bytes);
        e.put("executionDurationMs", (int) Math.max(0, Math.min(durationMs, Integer.MAX_VALUE)));
        if (closeReason != null) e.put("wsCloseReason", closeReason);
        if (executionStatus != null) e.put("executionStatus", executionStatus);

        Map<String, Object> meta = new HashMap<>();
        if (metadata != null) meta.putAll(metadata);
        // wsDirection / wsFrameType are enum-validated server-side; an out-of-set value would
        // get the event rejected, so unrecognised values are kept in metadata instead.
        putEnumOrMetadata(e, meta, "wsDirection", direction, WS_DIRECTIONS);
        putEnumOrMetadata(e, meta, "wsFrameType", frameType, WS_FRAME_TYPES);
        meta.put("sdkVersion", SDK_VERSION);
        meta.put("productId", productId);
        e.put("metadata", meta);
        return e;
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
        LOG.warning("[aforo-ws] Ignoring unknown executionStatus \"" + normalized + "\" — expected one of "
                + new java.util.TreeSet<>(ALLOWED_EXECUTION_STATUSES) + "; the event is sent without it.");
        return null;
    }

    private static final java.util.Set<String> WS_DIRECTIONS = java.util.Set.of("CLIENT_TO_SERVER", "SERVER_TO_CLIENT");
    private static final java.util.Set<String> WS_FRAME_TYPES = java.util.Set.of("TEXT", "BINARY", "PING", "PONG", "CLOSE");

    private static void putEnumOrMetadata(Map<String, Object> event, Map<String, Object> meta,
                                          String field, String value, java.util.Set<String> allowed) {
        if (value == null) return;
        String upper = value.toUpperCase();
        if (allowed.contains(upper)) event.put(field, upper);
        else meta.put(field, value);
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

    /**
     * Why an event was permanently dropped. The buffer is unbounded (drained
     * at flush start), so unlike the core SDK there is no OVERFLOW reason.
     * <ul>
     *   <li>{@code RETRY_EXHAUSTED} — the batch failed after all transport attempts</li>
     *   <li>{@code REJECTED} — the ingestor refused the batch (non-retryable 4xx) or
     *       refused this event individually in a partial response</li>
     *   <li>{@code INVALID} — the event breaks an ingestor field limit; it was never
     *       buffered or sent</li>
     * </ul>
     */
    public enum DropReason { RETRY_EXHAUSTED, REJECTED, INVALID }

    /** Number of events permanently dropped since this instance was created. */
    public long droppedCount() { return dropped.get(); }

    /**
     * Account for a permanently lost batch: bump the counter, WARN-log, and
     * invoke the opt-in onDrop hook. The buffer is drained at flush start, so
     * drops here are bounded by flush cadence — no log throttle needed.
     */
    private void recordDrop(java.util.List<Map<String, Object>> events, DropReason reason) {
        long total = dropped.addAndGet(events.size());
        LOG.warning("[aforo-ws] Dropped " + events.size() + " event(s) — " + reason + " (" + total + " total dropped).");
        if (onDrop != null) {
            try {
                onDrop.accept(events, reason);
            } catch (Exception e) {
                // A hook bug must never break flushing.
                LOG.log(Level.FINE, "onDrop hook threw", e);
            }
        }
    }

    private final AtomicLong invalidDrops = new AtomicLong();

    /**
     * Ingestor field limits ({@code IngestUsageEventRequest} {@code @Size} constraints).
     * An event over one of these would be rejected server-side, so it is dropped
     * here instead — never truncated, because a truncated id bills the wrong thing.
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
     * An event the ingestor would refuse: not buffered, not sent, counted in
     * {@link #droppedCount()}, logged (first, then every 1000th, so a tight loop
     * can't storm the log) and handed to the onDrop hook with {@link DropReason#INVALID}.
     */
    private void recordInvalid(Map<String, Object> event, String violation) {
        long total = dropped.incrementAndGet();
        long invalids = invalidDrops.incrementAndGet();
        if (invalids == 1 || invalids % 1000 == 0) {
            LOG.warning("[aforo-ws] Dropping invalid event: " + violation + " (" + invalids
                    + " invalid, " + total + " total dropped).");
        }
        if (onDrop != null) {
            try {
                onDrop.accept(java.util.List.of(event), DropReason.INVALID);
            } catch (Exception e) {
                LOG.log(Level.FINE, "onDrop hook threw", e);
            }
        }
    }

    /** Buffers an event, or drops it as {@link DropReason#INVALID} when it breaks a field limit. */
    private void enqueue(Map<String, Object> event) {
        String violation = limitViolation(event);
        if (violation != null) {
            recordInvalid(event, violation);
            return;
        }
        buffer.offer(event);
        if (bufferSize.incrementAndGet() >= flushCount) {
            scheduler.execute(this::flushQuietly);
        }
    }

    private final Object drainLock = new Object();

    private void flushQuietly() {
        try { flush(); } catch (Exception e) { LOG.log(Level.WARNING, "[aforo-ws] flush failed", e); }
    }

    private void flush() throws Exception {
        if (bufferSize.get() == 0) return;
        java.util.List<Map<String, Object>> batch = new java.util.ArrayList<>();
        Map<String, Object> ev;
        // One drain at a time: a size-triggered flush on the scheduler thread and
        // close()'s flush on the caller thread would otherwise split one batch into
        // two interleaved requests.
        synchronized (drainLock) {
            while ((ev = buffer.poll()) != null) { batch.add(ev); bufferSize.decrementAndGet(); }
        }
        if (batch.isEmpty()) return;

        // Slice into requests of at most MAX_EVENTS_PER_REQUEST; a failed slice does
        // not stop the remaining slices from being delivered.
        Exception failure = null;
        for (int from = 0; from < batch.size(); from += MAX_EVENTS_PER_REQUEST) {
            try {
                send(java.util.List.copyOf(batch.subList(from, Math.min(batch.size(), from + MAX_EVENTS_PER_REQUEST))));
            } catch (Exception e) {
                failure = e;
            }
        }
        if (failure != null) throw failure;
    }

    /**
     * POSTs one slice. The body is serialized once, so every retry resends the same
     * idempotency keys. Every way the slice can be lost goes through recordDrop.
     */
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
            long delayMs = (long) Math.pow(2, attempt - 1) * retryBackoffBaseMs;
            try {
                HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
                int status = resp.statusCode();
                if (status >= 200 && status < 300) {
                    recordPartialRejections(events, resp.body());
                    return;
                }
                // 4xx other than 408/429 (bad key, invalid event, unknown metric) cannot succeed on retry.
                if (status >= 400 && status < 500 && status != 408 && status != 429) {
                    LOG.warning("[aforo-ws] ingestor returned " + status + " — not retrying"
                            + errorMessages(resp.body()));
                    recordDrop(events, DropReason.REJECTED);
                    return;
                }
                if (status == 429) delayMs = retryAfterMs(resp, delayMs);
            } catch (Exception e) {
                if (attempt == 3) {
                    recordDrop(events, DropReason.RETRY_EXHAUSTED);
                    throw e;
                }
            }
            if (attempt == 3) break;
            try {
                Thread.sleep(delayMs);
            } catch (InterruptedException ie) {
                // Interrupted mid-backoff (e.g. close() racing shutdownNow) — the
                // batch is already drained and will never be retried; account for
                // it before propagating, and restore the interrupt flag for the
                // caller's subsequent blocking calls.
                recordDrop(events, DropReason.RETRY_EXHAUSTED);
                Thread.currentThread().interrupt();
                throw ie;
            }
        }
        recordDrop(events, DropReason.RETRY_EXHAUSTED);
        LOG.warning("[aforo-ws] flush exhausted retries — dropped " + events.size() + " events");
    }

    /**
     * A 2xx batch response can still report events the ingestor refused individually
     * ({@code failed} / {@code errors[{index,message}]}). Those events are dropped with
     * {@link DropReason#REJECTED}; only events the response identifies by index are
     * handed to the hook — any others are counted but not guessed at.
     */
    private void recordPartialRejections(java.util.List<Map<String, Object>> events, String body) {
        if (body == null || body.isBlank()) return;
        java.util.List<Map<String, Object>> rejected = new java.util.ArrayList<>();
        int failed;
        try {
            com.fasterxml.jackson.databind.JsonNode root = unwrapEnvelope(mapper.readTree(body));
            com.fasterxml.jackson.databind.JsonNode errors = root.path("errors");
            java.util.Set<Integer> seen = new java.util.HashSet<>();
            if (errors.isArray()) {
                for (com.fasterxml.jackson.databind.JsonNode err : errors) {
                    com.fasterxml.jackson.databind.JsonNode idx = err.get("index");
                    if (idx != null && idx.isInt() && idx.asInt() >= 0 && idx.asInt() < events.size()
                            && seen.add(idx.asInt())) {
                        rejected.add(events.get(idx.asInt()));
                    }
                }
            }
            failed = Math.min(events.size(), Math.max(root.path("failed").asInt(0), rejected.size()));
        } catch (Exception e) {
            return; // not a batch-response body — treat as accepted
        }
        if (failed == 0) return;
        LOG.warning("[aforo-ws] ingestor rejected " + failed + " of " + events.size() + " event(s)"
                + errorMessages(body));
        if (!rejected.isEmpty()) recordDrop(rejected, DropReason.REJECTED);
        int unidentified = failed - rejected.size();
        if (unidentified > 0) dropped.addAndGet(unidentified);
    }

    /** {@code errors[].message} from an ingestor batch response, formatted for a log line; "" if none. */
    private String errorMessages(String body) {
        if (body == null || body.isBlank()) return "";
        try {
            com.fasterxml.jackson.databind.JsonNode errors = unwrapEnvelope(mapper.readTree(body)).path("errors");
            if (!errors.isArray() || errors.isEmpty()) return "";
            StringBuilder sb = new StringBuilder(":");
            int shown = 0;
            for (com.fasterxml.jackson.databind.JsonNode err : errors) {
                if (shown++ == 10) { sb.append(" ..."); break; }
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

    /** Joins {@code natural:suffix}, trimming {@code natural} so the key stays within 255 chars. */
    private static String idempotencyKey(String natural, Instant now) {
        String suffix = now.toEpochMilli() + ":" + UUID.randomUUID().toString().substring(0, 8);
        int room = MAX_IDEMPOTENCY_KEY - suffix.length() - 1;
        return (natural.length() > room ? natural.substring(0, room) : natural) + ":" + suffix;
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
        private boolean perFrameEvents = false;
        private int flushCount = 100;
        private long flushIntervalMs = 3_000L;
        private BiConsumer<java.util.List<Map<String, Object>>, DropReason> onDrop;

        public Builder tenantId(String s) { this.tenantId = s; return this; }
        public Builder productId(String s) { this.productId = s; return this; }
        public Builder apiKey(String s) { this.apiKey = s; return this; }
        /**
         * Top-level {@code productType} on every event (default {@code WEBSOCKET_API}).
         * Trimmed and uppercased; unknown values are passed through.
         */
        public Builder productType(String s) { this.productType = s; return this; }
        public Builder ingestorUrl(String s) { this.ingestorUrl = s; return this; }
        public Builder perFrameEvents(boolean b) { this.perFrameEvents = b; return this; }
        public Builder flushCount(int n) { this.flushCount = n; return this; }
        public Builder flushIntervalMs(long n) { this.flushIntervalMs = n; return this; }
        /**
         * Opt-in hook receiving events that were permanently dropped (retry
         * exhaustion, a terminal rejection, or an event that breaks an ingestor
         * field limit — {@code DropReason.INVALID}). Events keep their idempotency
         * keys, so persisting and re-submitting them after recovery is
         * dedup-safe. Exceptions thrown by the hook are swallowed. Default:
         * none (drops are still counted in droppedCount() and WARN-logged).
         */
        public Builder onDrop(BiConsumer<java.util.List<Map<String, Object>>, DropReason> fn) { this.onDrop = fn; return this; }
        public AforoWsBilling build() { return new AforoWsBilling(this); }
    }

    /**
     * The ingestor wraps every 2xx JSON body in {@code {success, data, meta}}.
     * Returns the inner {@code data} object when present, else the node itself
     * (bare shape).
     */
    static com.fasterxml.jackson.databind.JsonNode unwrapEnvelope(com.fasterxml.jackson.databind.JsonNode root) {
        if (root != null && root.isObject() && root.path("data").isObject()) {
            return root.get("data");
        }
        return root;
    }
}
