package com.aforo.grpc;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.aforo.grpc.internal.transport.TransportConfig;
import com.aforo.grpc.internal.transport.TransportCore;
import io.grpc.ForwardingServerCall;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.BiConsumer;
import java.util.function.Function;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Aforo gRPC Metering SDK for Java.
 *
 * <p>Install as a {@code ServerInterceptor} on your gRPC server — every RPC call
 * (unary and streaming) emits one billing event with timing, status code, and
 * call type. Events are buffered and flushed to Aforo's usage ingestor in
 * batches; an ingest outage keeps them queued and resends them with the same
 * idempotency keys (see contract/TRANSPORT-SPEC.md).</p>
 *
 * <p>Usage:</p>
 * <pre>
 *   AforoGrpcBilling billing = AforoGrpcBilling.newBuilder()
 *       .tenantId("tenant_acme")
 *       .productId("prod_grpc_user_svc")
 *       .apiKey(System.getenv("AFORO_API_KEY"))
 *       .ingestorUrl("https://api.aforo.ai")
 *       .serviceName("acme.v1.UserService")
 *       // Who is calling: read it from your authentication (mTLS peer, verified token).
 *       .customerResolver((call, headers) -> customerFromVerifiedToken(headers))
 *       .build();
 *
 *   Server server = ServerBuilder.forPort(50051)
 *       .addService(new UserServiceImpl())
 *       .intercept(billing.interceptor())
 *       .build();
 * </pre>
 */
public final class AforoGrpcBilling implements AutoCloseable {

    private static final Logger LOG = Logger.getLogger(AforoGrpcBilling.class.getName());
    private static final String SDK_VERSION = "2.0.0";
    private static final int MAX_IDEMPOTENCY_KEY = 255;
    /** Ingestor limit on {@code grpcMethod}. */
    static final int MAX_GRPC_METHOD = 128;
    /** Default top-level {@code productType}; override with {@link Builder#productType(String)}. */
    public static final String DEFAULT_PRODUCT_TYPE = "GRPC_API";

    private final String tenantId;
    private final String productId;
    private final String apiKey;
    private final String productType;
    private final String serviceName;
    private final CustomerResolver customerResolver;

    private final BiConsumer<java.util.List<Map<String, Object>>, DropReason> onDrop;
    private final java.util.function.Consumer<MeteringError> onError;
    private final BiConsumer<Map<String, Object>, java.util.List<Map<String, Object>>> onAccepted;
    private final ObjectMapper mapper = new ObjectMapper();
    private final TransportCore<Map<String, Object>> core;

    private AforoGrpcBilling(Builder b) {
        this.tenantId = require(b.tenantId, "tenantId");
        this.productId = require(b.productId, "productId");
        this.apiKey = require(b.apiKey, "apiKey");
        this.serviceName = require(b.serviceName, "serviceName");
        this.productType = normalizeProductType(b.productType, DEFAULT_PRODUCT_TYPE);
        this.onDrop = b.onDrop;
        this.onError = b.onError;
        this.onAccepted = b.onAccepted;
        this.core = new TransportCore<>(TransportConfig.builder()
                .baseUrl(require(b.ingestorUrl, "ingestorUrl"))
                .apiKey(apiKey)
                .allowInsecureHttp(b.allowInsecureHttp)
                .header("X-Tenant-Id", tenantId)
                .userAgent("aforo-java-grpc/" + SDK_VERSION)
                .flushCount(b.flushCount)
                .flushIntervalMs(b.flushIntervalMs)
                .maxQueueSize(b.maxQueueSize)
                .maxRetries(b.maxRetries)
                .retryBaseMs(b.retryBaseMs)
                .timeoutMs(b.timeoutMs)
                .shutdownTimeoutMs(b.shutdownTimeoutMs)
                .breakerInitialMs(b.breakerCooldownMs)
                .threadName("aforo-grpc-flush")
                .loggerName(AforoGrpcBilling.class.getName())
                .logPrefix("[aforo-grpc]")
                .build(),
                mapper::writeValueAsString,
                TransportCore.Listeners.<Map<String, Object>>builder()
                        .onDrop((events, reason) -> { if (onDrop != null) onDrop.accept(events, map(reason)); })
                        .onError(onError == null ? null : e -> onError.accept(
                                new MeteringError(map(e.kind()), e.message(), e.events(), e.status())))
                        .onAccepted(onAccepted == null ? null : (body, events) -> onAccepted.accept(asMap(body), events))
                        .build());
        this.customerResolver = b.customerResolver();
    }

    /**
     * Finds the Aforo customer id for an incoming call from an identity you have verified
     * (mTLS peer certificate in {@code call.getAttributes()}, a verified token in the
     * headers). Returning null/blank: the call is not metered and is counted as
     * {@code INVALID}; the call itself is never affected.
     */
    @FunctionalInterface
    public interface CustomerResolver {
        String resolve(ServerCall<?, ?> call, Metadata headers);
    }

    /** Message for a builder without a customer source. */
    static final String MISSING_CUSTOMER_SOURCE = "AforoGrpcBilling needs to know which customer each call"
            + " belongs to. Set customerResolver(...) to read it from your authentication (mTLS peer, verified"
            + " token), or trustCustomerHeader(true) to read the x-customer-id metadata; only do that when a"
            + " proxy in front of the server sets it, because callers can otherwise bill usage to any customer.";

    /** Returns a {@link ServerInterceptor} that meters every call. */
    public ServerInterceptor interceptor() {
        return new ServerInterceptor() {
            @Override
            public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
                    ServerCall<ReqT, RespT> call, Metadata headers, ServerCallHandler<ReqT, RespT> next) {
                long start = System.currentTimeMillis();
                String fullMethod = call.getMethodDescriptor().getFullMethodName(); // pkg.Service/Method
                String method = fullMethod.contains("/") ? fullMethod.substring(fullMethod.lastIndexOf('/') + 1) : fullMethod;
                String callType = mapCallType(call.getMethodDescriptor().getType().name());
                String customerId = resolveCustomer(call, headers);

                ForwardingServerCall.SimpleForwardingServerCall<ReqT, RespT> wrapped =
                        new ForwardingServerCall.SimpleForwardingServerCall<>(call) {
                            @Override
                            public void close(Status status, Metadata trailers) {
                                try {
                                    record(method, callType, customerId, status.getCode().name(),
                                            System.currentTimeMillis() - start,
                                            outcomeFromGrpcStatus(status.getCode()));
                                } catch (RuntimeException e) {
                                    // Metering must never keep the call from closing.
                                    LOG.log(Level.FINE, "[aforo-grpc] metering failed for " + method, e);
                                } finally {
                                    super.close(status, trailers);
                                }
                            }
                        };
                return next.startCall(wrapped, headers);
            }
        };
    }

    /**
     * Record a single RPC. Public so streaming handlers can call it directly.
     *
     * <p>{@code executionStatus} is derived from {@code status} when it is a
     * {@link Status.Code} name (see {@link #outcomeFromGrpcStatus(Status.Code)});
     * any other value leaves it off the event.</p>
     */
    public void record(String method, String callType, String customerId, String status, long durationMs) {
        record(method, callType, customerId, status, durationMs, outcomeFromGrpcStatus(status));
    }

    /**
     * Record a single RPC with an explicit outcome status for OUTCOME_BASED
     * pricing (each event bills at the weight set for its status; events
     * without one bill at full price). The value is trimmed and upper-cased;
     * {@code null} or blank falls back to the status derived from
     * {@code status} (see {@link #record(String, String, String, String, long)}).
     * Accepted values: SUCCESS, PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED,
     * FAILED, FAILURE, CANCELLED, PENDING, BLOCKED, HITL_REQUIRED — the server
     * is authoritative. Any other value is logged and ignored (the derived status is used instead).
     */
    public void record(String method, String callType, String customerId, String status, long durationMs,
                       String executionStatus) {
        record(method, callType, customerId, status, durationMs, executionStatus, null);
    }

    /**
     * Record a single RPC with an outcome status (see the overload above) and a
     * per-call {@code productType} override ({@code null}/blank → the client-level
     * {@link Builder#productType(String)}).
     *
     * <p>A blank {@code customerId} or {@code method}, or an
     * event that breaks an ingestor field limit on a caller-set field (customerId
     * over 64 characters, service over 255, productType over 20), is dropped with
     * {@link DropReason#INVALID}; this method never throws.</p>
     *
     * <p>The method name originates from the incoming call, also when the integration
     * passes it here: one over 128 characters is truncated to 128 on {@code grpcMethod}
     * and the event is still sent (one warning per instance). The idempotency key is
     * built from the full name.</p>
     */
    public void record(String method, String callType, String customerId, String status, long durationMs,
                       String executionStatus, String productTypeOverride) {
        String outcome = canonicalExecutionStatus(executionStatus);
        if (outcome == null) outcome = outcomeFromGrpcStatus(status);

        Instant now = Instant.now();
        Map<String, Object> event = new HashMap<>();
        event.put("customerId", customerId);
        event.put("metricName", "grpc_api.rpc_calls");
        event.put("quantity", 1);
        event.put("occurredAt", now.toString());
        event.put("idempotencyKey", idempotencyKey("grpc:" + tenantId + ":" + serviceName + ":" + method, now));
        event.put("productType", normalizeProductType(productTypeOverride, productType));
        event.put("grpcService", serviceName);
        event.put("grpcMethod", boundedLabel("grpcMethod", method, MAX_GRPC_METHOD));
        event.put("grpcCallType", mapCallType(callType == null ? "" : callType.toUpperCase(java.util.Locale.ROOT)));
        event.put("messageCount", 1);
        event.put("executionDurationMs", (int) Math.max(0, Math.min(durationMs, Integer.MAX_VALUE)));
        if (outcome != null) event.put("executionStatus", outcome);

        Map<String, Object> meta = new HashMap<>();
        // grpcStatusCode is enum-validated server-side; anything outside the gRPC code set
        // would get the event rejected, so keep it in metadata instead.
        String statusCode = status == null ? null : status.toUpperCase(java.util.Locale.ROOT);
        if (statusCode != null && GRPC_STATUS_CODES.contains(statusCode)) {
            event.put("grpcStatusCode", statusCode);
        } else if (status != null) {
            meta.put("grpcStatus", status);
        }
        meta.put("sdkVersion", SDK_VERSION);
        meta.put("productId", productId);
        event.put("metadata", meta);

        if (customerId == null || customerId.isBlank()) {
            recordInvalid(event, "customerId is required (the customer resolver found none for " + method + ")");
            return;
        }
        if (method == null || method.isBlank()) {
            recordInvalid(event, "grpcMethod is required (blank method)");
            return;
        }
        enqueue(event);
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
     * bills the wrong thing; the method name, which originates from the call, is
     * bounded before it gets here (see {@code boundedLabel}).
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
     * Maps a gRPC status code to an Aforo execution status (same table as the
     * gateway plugins): OK→SUCCESS; CANCELLED→CANCELLED; INVALID_ARGUMENT,
     * FAILED_PRECONDITION, OUT_OF_RANGE→VALIDATION_FAILED;
     * DEADLINE_EXCEEDED→TIMEOUT; PERMISSION_DENIED, RESOURCE_EXHAUSTED,
     * UNAUTHENTICATED→BLOCKED; every other code→ERROR. {@code null}→{@code null}.
     */
    public static String outcomeFromGrpcStatus(Status.Code code) {
        if (code == null) return null;
        return switch (code) {
            case OK -> "SUCCESS";
            case CANCELLED -> "CANCELLED";
            case INVALID_ARGUMENT, FAILED_PRECONDITION, OUT_OF_RANGE -> "VALIDATION_FAILED";
            case DEADLINE_EXCEEDED -> "TIMEOUT";
            case PERMISSION_DENIED, RESOURCE_EXHAUSTED, UNAUTHENTICATED -> "BLOCKED";
            default -> "ERROR";
        };
    }

    /**
     * String variant of {@link #outcomeFromGrpcStatus(Status.Code)} for the
     * status label passed to {@code record(...)}. Returns {@code null} when the
     * value is not a {@link Status.Code} name (case-insensitive, trimmed).
     */
    public static String outcomeFromGrpcStatus(String codeName) {
        String normalized = normalizeExecutionStatus(codeName);
        if (normalized == null) return null;
        try {
            return outcomeFromGrpcStatus(Status.Code.valueOf(normalized));
        } catch (IllegalArgumentException notACode) {
            return null;
        }
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
     * logged and returned as {@code null} so the caller falls back to the derived
     * status — sending it would make the ingestor reject the event, losing its usage.
     */
    static String canonicalExecutionStatus(String value) {
        String normalized = normalizeExecutionStatus(value);
        if (normalized == null || ALLOWED_EXECUTION_STATUSES.contains(normalized)) return normalized;
        LOG.warning("[aforo-grpc] Ignoring unknown executionStatus \"" + normalized + "\" — expected one of "
                + new java.util.TreeSet<>(ALLOWED_EXECUTION_STATUSES) + "; using the status derived from the gRPC code instead.");
        return null;
    }

    // ── Helpers ──

    private static final Metadata.Key<String> CUSTOMER_ID_KEY =
            Metadata.Key.of("x-customer-id", Metadata.ASCII_STRING_MARSHALLER);

    /** The resolver's answer; a resolver that throws counts as no customer and never fails the call. */
    private String resolveCustomer(ServerCall<?, ?> call, Metadata headers) {
        try {
            String id = customerResolver.resolve(call, headers);
            return id == null || id.isBlank() ? null : id.trim();
        } catch (RuntimeException e) {
            LOG.log(Level.FINE, "[aforo-grpc] customer resolver threw; the call is not metered", e);
            return null;
        }
    }

    private static final java.util.Set<String> GRPC_STATUS_CODES = java.util.Set.of(
            "OK", "CANCELLED", "UNKNOWN", "INVALID_ARGUMENT", "DEADLINE_EXCEEDED", "NOT_FOUND",
            "ALREADY_EXISTS", "PERMISSION_DENIED", "RESOURCE_EXHAUSTED", "FAILED_PRECONDITION", "ABORTED",
            "OUT_OF_RANGE", "UNIMPLEMENTED", "INTERNAL", "UNAVAILABLE", "DATA_LOSS", "UNAUTHENTICATED");

    /** Maps grpc-java MethodType names (and the ingestor's own values) onto grpcCallType. */
    private static String mapCallType(String grpcMethodType) {
        return switch (grpcMethodType) {
            case "UNARY" -> "UNARY";
            case "CLIENT_STREAMING", "CLIENT_STREAM" -> "CLIENT_STREAM";
            case "SERVER_STREAMING", "SERVER_STREAM" -> "SERVER_STREAM";
            case "BIDI_STREAMING", "BIDI_STREAM" -> "BIDI_STREAM";
            default -> "UNARY";
        };
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

    /** Request-derived labels already reported as truncated — one warning per label per instance. */
    private final java.util.Set<String> truncationWarned = java.util.concurrent.ConcurrentHashMap.newKeySet();

    /**
     * A label taken from the incoming request, cut to the ingestor's limit so the
     * event is still sent. Warns once per label. Not for caller-set fields.
     */
    private String boundedLabel(String label, String value, int max) {
        if (value == null || value.length() <= max) return value;
        if (truncationWarned.add(label)) {
            LOG.warning("[aforo-grpc] " + label + " from the request was longer than " + max
                    + " characters and was truncated to " + max + "; the event is still sent."
                    + " Later truncations of " + label + " are not logged.");
        }
        return truncateLabel(value, max);
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

    /** Fluent builder. */
    public static final class Builder {
        private String productType;
        private String tenantId, productId, apiKey, ingestorUrl, serviceName;
        private int flushCount = TransportConfig.DEFAULT_FLUSH_COUNT;
        private long flushIntervalMs = TransportConfig.DEFAULT_FLUSH_INTERVAL_MS;
        private int maxQueueSize = TransportConfig.DEFAULT_QUEUE_CAPACITY;
        private int maxRetries = TransportConfig.DEFAULT_MAX_RETRIES;
        private long retryBaseMs = TransportConfig.DEFAULT_RETRY_BASE_MS;
        private long timeoutMs = TransportConfig.DEFAULT_TIMEOUT_MS;
        private long shutdownTimeoutMs = TransportConfig.DEFAULT_SHUTDOWN_TIMEOUT_MS;
        private long breakerCooldownMs = TransportConfig.DEFAULT_BREAKER_INITIAL_MS;
        private boolean allowInsecureHttp;
        private BiConsumer<java.util.List<Map<String, Object>>, DropReason> onDrop;
        private java.util.function.Consumer<MeteringError> onError;
        private BiConsumer<Map<String, Object>, java.util.List<Map<String, Object>>> onAccepted;
        private CustomerResolver customerResolver;
        private boolean trustCustomerHeader;

        public Builder tenantId(String s)       { this.tenantId = s; return this; }
        public Builder productId(String s)      { this.productId = s; return this; }
        public Builder apiKey(String s)         { this.apiKey = s; return this; }
        /**
         * Top-level {@code productType} on every event (default {@code GRPC_API}).
         * Trimmed and uppercased; unknown values are passed through.
         */
        public Builder productType(String s) { this.productType = s; return this; }
        public Builder ingestorUrl(String s)    { this.ingestorUrl = s; return this; }
        public Builder serviceName(String s)    { this.serviceName = s; return this; }
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
        /** Reads the customer for each call from your authentication. Required unless {@link #trustCustomerHeader(boolean)}. */
        public Builder customerResolver(CustomerResolver resolver) { this.customerResolver = resolver; return this; }

        /**
         * A resolver that reads only the metadata. Kept for 1.x callers; prefer
         * {@link #customerResolver(CustomerResolver)}.
         */
        @Deprecated
        public Builder customerIdExtractor(Function<Metadata, String> fn) {
            this.customerResolver = fn == null ? null : (call, headers) -> fn.apply(headers);
            return this;
        }

        /**
         * Opt in to reading the {@code x-customer-id} metadata. Callers of your service control
         * it; turn this on only when a proxy in front of the server authenticates the caller,
         * sets it and strips any value the caller sent.
         */
        public Builder trustCustomerHeader(boolean trust) { this.trustCustomerHeader = trust; return this; }

        CustomerResolver customerResolver() {
            if (customerResolver != null) return customerResolver;
            if (trustCustomerHeader) return (call, headers) -> headers.get(CUSTOMER_ID_KEY);
            throw new IllegalStateException(MISSING_CUSTOMER_SOURCE);
        }

        /** @throws IllegalStateException without {@link #customerResolver} or {@link #trustCustomerHeader} */
        public AforoGrpcBilling build()         { customerResolver(); return new AforoGrpcBilling(this); }
    }
}
