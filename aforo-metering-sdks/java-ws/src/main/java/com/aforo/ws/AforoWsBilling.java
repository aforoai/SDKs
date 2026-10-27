package com.aforo.ws;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.aforo.ws.internal.transport.TransportConfig;
import com.aforo.ws.internal.transport.TransportCore;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BiConsumer;
import java.util.concurrent.atomic.AtomicLong;
import java.util.logging.Logger;

/**
 * Aforo WebSocket Metering SDK for Java.
 *
 * <p>Framework-agnostic — call {@code openConnection}, {@code recordFrame},
 * and {@code closeConnection} from your Jakarta WebSocket {@code @OnOpen} /
 * {@code @OnMessage} / {@code @OnClose} handlers (or Spring WebSocket
 * equivalents). The SDK aggregates per-connection counters in memory and
 * emits one CONNECTION_OPENED ({@code wsFrameType: OPEN}, metric
 * {@code websocket_api.connection_opened}) + one CONNECTION_CLOSED billing event
 * with the totals (or per-frame events when {@code perFrameEvents=true}).</p>
 *
 * <p>The open-connection map is bounded: a connection with no activity for
 * {@link Builder#connectionIdleTimeoutMs(long)} (default 1 h) is closed by a sweep
 * ({@code ABNORMAL_CLOSURE}, metadata {@code closedBy: sdk_idle_timeout}), and
 * {@link #close()} emits CONNECTION_CLOSED ({@code GOING_AWAY}, {@code closedBy:
 * sdk_shutdown}) for every connection still open.</p>
 */
public final class AforoWsBilling implements AutoCloseable {

    private static final Logger LOG = Logger.getLogger(AforoWsBilling.class.getName());
    private static final String SDK_VERSION = "2.0.0";
    private static final int MAX_IDEMPOTENCY_KEY = 255;
    /** Default top-level {@code productType}; override with {@link Builder#productType(String)}. */
    public static final String DEFAULT_PRODUCT_TYPE = "WEBSOCKET_API";
    /** Default for {@link Builder#connectionIdleTimeoutMs(long)}: one hour. */
    public static final long DEFAULT_CONNECTION_IDLE_TIMEOUT_MS = 3_600_000L;

    private final String tenantId, productId, apiKey;
    private final String productType;
    private final boolean perFrameEvents;

    private final ConcurrentHashMap<String, ConnectionState> active = new ConcurrentHashMap<>();
    private final BiConsumer<java.util.List<Map<String, Object>>, DropReason> onDrop;
    private final java.util.function.Consumer<MeteringError> onError;
    private final BiConsumer<Map<String, Object>, java.util.List<Map<String, Object>>> onAccepted;
    private final ObjectMapper mapper = new ObjectMapper();
    private final TransportCore<Map<String, Object>> core;
    private final long idleTimeoutMs;
    private final java.util.function.LongSupplier clock;
    private final java.util.concurrent.ScheduledExecutorService sweeper;
    /** Opens hold the read lock; close() takes the write lock, so no open slips past the shutdown CLOSE pass. */
    private final java.util.concurrent.locks.ReentrantReadWriteLock lifecycle =
            new java.util.concurrent.locks.ReentrantReadWriteLock();
    private volatile boolean closing;

    private AforoWsBilling(Builder b) {
        this.tenantId = require(b.tenantId, "tenantId");
        this.productId = require(b.productId, "productId");
        this.apiKey = require(b.apiKey, "apiKey");
        this.productType = normalizeProductType(b.productType, DEFAULT_PRODUCT_TYPE);
        this.perFrameEvents = b.perFrameEvents;
        this.onDrop = b.onDrop;
        this.onError = b.onError;
        this.onAccepted = b.onAccepted;
        if (b.connectionIdleTimeoutMs < 0) {
            throw new IllegalArgumentException("connectionIdleTimeoutMs must be > 0 (0 = default of 1 h); got "
                    + b.connectionIdleTimeoutMs + ". A sweep keeps the open-connection map bounded, so it cannot be disabled.");
        }
        this.idleTimeoutMs = b.connectionIdleTimeoutMs == 0 ? DEFAULT_CONNECTION_IDLE_TIMEOUT_MS : b.connectionIdleTimeoutMs;
        this.clock = b.clock == null ? System::currentTimeMillis : b.clock;
        this.core = new TransportCore<>(TransportConfig.builder()
                .baseUrl(require(b.ingestorUrl, "ingestorUrl"))
                .apiKey(apiKey)
                .allowInsecureHttp(b.allowInsecureHttp)
                .header("X-Tenant-Id", tenantId)
                .userAgent("aforo-java-ws/" + SDK_VERSION)
                .flushCount(b.flushCount)
                .flushIntervalMs(b.flushIntervalMs)
                .maxQueueSize(b.maxQueueSize)
                .maxRetries(b.maxRetries)
                .retryBaseMs(b.retryBaseMs)
                .timeoutMs(b.timeoutMs)
                .shutdownTimeoutMs(b.shutdownTimeoutMs)
                .breakerInitialMs(b.breakerCooldownMs)
                .threadName("aforo-ws-flush")
                .loggerName(AforoWsBilling.class.getName())
                .logPrefix("[aforo-ws]")
                .build(),
                mapper::writeValueAsString,
                TransportCore.Listeners.<Map<String, Object>>builder()
                        .onDrop((events, reason) -> { if (onDrop != null) onDrop.accept(events, map(reason)); })
                        .onError(onError == null ? null : e -> onError.accept(
                                new MeteringError(map(e.kind()), e.message(), e.events(), e.status())))
                        .onAccepted(onAccepted == null ? null : (body, events) -> onAccepted.accept(asMap(body), events))
                        .build());
        this.sweeper = startSweeper();
    }

    /** Runs the idle sweep every idleTimeout/4, between 1 s and 1 min. */
    private java.util.concurrent.ScheduledExecutorService startSweeper() {
        long every = Math.max(1_000, Math.min(60_000, idleTimeoutMs / 4));
        java.util.concurrent.ScheduledExecutorService s = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "aforo-ws-idle-sweep");
            t.setDaemon(true);
            return t;
        });
        s.scheduleWithFixedDelay(() -> {
            try {
                sweepIdle();
            } catch (RuntimeException e) {
                LOG.log(java.util.logging.Level.WARNING, "[aforo-ws] idle sweep failed; continuing", e);
            }
        }, every, every, java.util.concurrent.TimeUnit.MILLISECONDS);
        return s;
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
        String connectionId = UUID.randomUUID().toString();
        if (customerId == null || customerId.isBlank()) {
            // No customer: the connection is not metered. Counted and reported, never thrown.
            Map<String, Object> openMeta = new HashMap<>(metadata == null ? Map.of() : metadata);
            openMeta.put("event", "CONNECTION_OPENED");
            recordInvalid(connEvent(customerId, connectionId, "OPEN", "SERVER_TO_CLIENT", 0, 0, 0, null, openMeta,
                    canonicalExecutionStatus(executionStatus)), "customerId is required");
            return null;
        }
        // Merge caller metadata into the OPEN marker so per-connection tags (region,
        // userAgent, deviceClass...) are on both the OPEN event and the eventual CLOSE event.
        Map<String, Object> openMeta = new HashMap<>(metadata == null ? Map.of() : metadata);
        openMeta.put("event", "CONNECTION_OPENED");
        Map<String, Object> open = connEvent(customerId, connectionId, "OPEN", "SERVER_TO_CLIENT", 0, 0, 0, null,
                openMeta, canonicalExecutionStatus(executionStatus));
        String violation = limitViolation(open);
        if (violation != null) {
            // Over an ingestor limit (customerId > 64 ...): not metered and not tracked, like a blank customer.
            recordInvalid(open, violation + "; connection not metered");
            return null;
        }
        lifecycle.readLock().lock();
        try {
            if (closing) {
                // After close(): never tracked; the event is reported as CLOSED.
                push(open);
                return null;
            }
            active.put(connectionId, new ConnectionState(customerId, clock.getAsLong(), metadata));
            push(open);
        } finally {
            lifecycle.readLock().unlock();
        }
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
        long now = clock.getAsLong();
        s.lastActivity = now;
        if (perFrameEvents) {
            push(connEvent(s.customerId, connectionId, frameType, direction, 1, bytes,
                    now - s.startMs, null, s.metadata,
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
        closeTracked(connectionId, closeCode, null, executionStatus);
    }

    /** Emits CONNECTION_CLOSED once per connection; {@code closedBy} names an SDK-initiated close. */
    private void closeTracked(String connectionId, int closeCode, String closedBy, String executionStatus) {
        if (connectionId == null) return;
        ConnectionState s = active.remove(connectionId);
        if (s == null) return;
        long durationMs = clock.getAsLong() - s.startMs;
        String reason = mapCloseReason(closeCode);
        Map<String, Object> meta = new HashMap<>(s.metadata == null ? Map.of() : s.metadata);
        meta.put("event", "CONNECTION_CLOSED");
        meta.put("frames", s.frames.get());
        meta.put("bytes", s.bytes.get());
        meta.put("closeCode", closeCode);
        if (closedBy != null) meta.put("closedBy", closedBy);
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
        Instant now = Instant.ofEpochMilli(clock.getAsLong());
        Map<String, Object> e = new HashMap<>();
        e.put("customerId", customerId);
        e.put("metricName", switch (frameType == null ? "" : frameType) {
            case "OPEN" -> "websocket_api.connection_opened";
            case "CLOSE" -> "websocket_api.connection_closed";
            default -> "websocket_api.message";
        });
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
    private static final java.util.Set<String> WS_FRAME_TYPES = java.util.Set.of("OPEN", "TEXT", "BINARY", "PING", "PONG", "CLOSE");

    private static void putEnumOrMetadata(Map<String, Object> event, Map<String, Object> meta,
                                          String field, String value, java.util.Set<String> allowed) {
        if (value == null) return;
        String upper = value.toUpperCase(java.util.Locale.ROOT);
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

    /** Connections opened and not yet closed (by you, the idle sweep or {@link #close()}). */
    public int openConnections() { return active.size(); }

    /** Closes connections idle longer than the idle timeout; returns how many. Runs on the sweep thread. */
    int sweepIdle() {
        long cutoff = clock.getAsLong() - idleTimeoutMs;
        int n = 0;
        for (Map.Entry<String, ConnectionState> e : active.entrySet()) {
            if (e.getValue().lastActivity <= cutoff) {
                closeTracked(e.getKey(), 1006, "sdk_idle_timeout", null);
                n++;
            }
        }
        if (n > 0) LOG.info("[aforo-ws] closed " + n + " connection(s) idle for over " + idleTimeoutMs + " ms");
        return n;
    }


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
        lifecycle.writeLock().lock();
        try {
            if (closing) {
                // Second call: the first one did the CLOSE pass; just wait for the transport.
                core.close();
                return;
            }
            closing = true;
        } finally {
            lifecycle.writeLock().unlock();
        }
        sweeper.shutdownNow();
        for (String id : new java.util.ArrayList<>(active.keySet())) {
            closeTracked(id, 1001, "sdk_shutdown", null);
        }
        core.close();
    }

    private static class ConnectionState {
        final String customerId;
        final long startMs;
        final Map<String, Object> metadata;
        final AtomicLong frames = new AtomicLong();
        final AtomicLong bytes = new AtomicLong();
        volatile long lastActivity;

        ConnectionState(String customerId, long startMs, Map<String, Object> metadata) {
            this.customerId = customerId;
            this.startMs = startMs;
            this.lastActivity = startMs;
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


    /** The client-level {@code productType} stamped on events without a per-call override. */
    public String getProductType() { return productType; }

    public static Builder newBuilder() { return new Builder(); }

    public static final class Builder {
        private String productType;
        private String tenantId, productId, apiKey, ingestorUrl;
        private boolean perFrameEvents = false;
        private int flushCount = TransportConfig.DEFAULT_FLUSH_COUNT;
        private long flushIntervalMs = TransportConfig.DEFAULT_FLUSH_INTERVAL_MS;
        private int maxQueueSize = TransportConfig.DEFAULT_QUEUE_CAPACITY;
        private int maxRetries = TransportConfig.DEFAULT_MAX_RETRIES;
        private long retryBaseMs = TransportConfig.DEFAULT_RETRY_BASE_MS;
        private long timeoutMs = TransportConfig.DEFAULT_TIMEOUT_MS;
        private long shutdownTimeoutMs = TransportConfig.DEFAULT_SHUTDOWN_TIMEOUT_MS;
        private long breakerCooldownMs = TransportConfig.DEFAULT_BREAKER_INITIAL_MS;
        private boolean allowInsecureHttp;
        private long connectionIdleTimeoutMs;
        private java.util.function.LongSupplier clock;
        private BiConsumer<java.util.List<Map<String, Object>>, DropReason> onDrop;
        private java.util.function.Consumer<MeteringError> onError;
        private BiConsumer<Map<String, Object>, java.util.List<Map<String, Object>>> onAccepted;

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
        /**
         * Close a tracked connection that has had no frame for this long (default 1 h; 0 = default).
         * Negative values are refused: the sweep is what keeps the open-connection map bounded.
         */
        public Builder connectionIdleTimeoutMs(long n) { this.connectionIdleTimeoutMs = n; return this; }
        /** Test seam: epoch-millisecond clock for timestamps, durations and the idle sweep. */
        Builder clock(java.util.function.LongSupplier c) { this.clock = c; return this; }
        public AforoWsBilling build() { return new AforoWsBilling(this); }
    }
}
