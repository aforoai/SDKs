package com.aforo.grpc;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.grpc.ForwardingServerCall;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;

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
import java.util.concurrent.atomic.AtomicLong;
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
 * batches with 3× exponential retry.</p>
 *
 * <p>Usage:</p>
 * <pre>
 *   AforoGrpcBilling billing = AforoGrpcBilling.newBuilder()
 *       .tenantId("tenant_acme")
 *       .productId("prod_grpc_user_svc")
 *       .apiKey(System.getenv("AFORO_API_KEY"))
 *       .ingestorUrl("https://api.aforo.ai")
 *       .serviceName("acme.v1.UserService")
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
    private static final String SDK_VERSION = "1.2.2";
    /** The ingestor rejects {@code /v1/ingest/batch} requests with more than 1000 events. */
    static final int MAX_EVENTS_PER_REQUEST = 1000;
    private static final int MAX_IDEMPOTENCY_KEY = 255;
    /** Ingestor limit on {@code grpcMethod}. */
    static final int MAX_GRPC_METHOD = 128;
    /** Default top-level {@code productType}; override with {@link Builder#productType(String)}. */
    public static final String DEFAULT_PRODUCT_TYPE = "GRPC_API";

    private final String tenantId;
    private final String productId;
    private final String apiKey;
    private final URI ingestorUri;
    private final String productType;
    private final String serviceName;
    private final int flushCount;
    private final long flushIntervalMs;
    private final Function<Metadata, String> customerIdExtractor;

    private final ConcurrentLinkedQueue<Map<String, Object>> buffer = new ConcurrentLinkedQueue<>();
    private final AtomicInteger bufferSize = new AtomicInteger();
    private final AtomicLong dropped = new AtomicLong();
    private final BiConsumer<java.util.List<Map<String, Object>>, DropReason> onDrop;
    /** Retry backoff base in ms — package-private so tests can skip real sleeps. */
    long retryBackoffBaseMs = 1000L;
    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "aforo-grpc-flush");
        t.setDaemon(true);
        return t;
    });

    private AforoGrpcBilling(Builder b) {
        this.tenantId = require(b.tenantId, "tenantId");
        this.productId = require(b.productId, "productId");
        this.apiKey = require(b.apiKey, "apiKey");
        this.serviceName = require(b.serviceName, "serviceName");
        this.ingestorUri = URI.create(stripTrailingSlash(require(b.ingestorUrl, "ingestorUrl")) + "/v1/ingest/batch");
        this.productType = normalizeProductType(b.productType, DEFAULT_PRODUCT_TYPE);
        this.flushCount = b.flushCount;
        this.flushIntervalMs = b.flushIntervalMs;
        this.onDrop = b.onDrop;
        this.customerIdExtractor = b.customerIdExtractor != null ? b.customerIdExtractor : DEFAULT_CUSTOMER_EXTRACTOR;
        scheduler.scheduleAtFixedRate(this::flushQuietly, flushIntervalMs, flushIntervalMs, TimeUnit.MILLISECONDS);
    }

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
                String customerId = customerIdExtractor.apply(headers);

                ForwardingServerCall.SimpleForwardingServerCall<ReqT, RespT> wrapped =
                        new ForwardingServerCall.SimpleForwardingServerCall<>(call) {
                            @Override
                            public void close(Status status, Metadata trailers) {
                                if (customerId != null && !customerId.isBlank()) {
                                    record(method, callType, customerId, status.getCode().name(),
                                            System.currentTimeMillis() - start,
                                            outcomeFromGrpcStatus(status.getCode()));
                                }
                                super.close(status, trailers);
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
     * <p>A blank {@code customerId} is not metered. A blank {@code method}, or an
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
        if (customerId == null || customerId.isBlank()) return;
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
        event.put("grpcCallType", mapCallType(callType == null ? "" : callType.toUpperCase()));
        event.put("messageCount", 1);
        event.put("executionDurationMs", (int) Math.max(0, Math.min(durationMs, Integer.MAX_VALUE)));
        if (outcome != null) event.put("executionStatus", outcome);

        Map<String, Object> meta = new HashMap<>();
        // grpcStatusCode is enum-validated server-side; anything outside the gRPC code set
        // would get the event rejected, so keep it in metadata instead.
        String statusCode = status == null ? null : status.toUpperCase();
        if (statusCode != null && GRPC_STATUS_CODES.contains(statusCode)) {
            event.put("grpcStatusCode", statusCode);
        } else if (status != null) {
            meta.put("grpcStatus", status);
        }
        meta.put("sdkVersion", SDK_VERSION);
        meta.put("productId", productId);
        event.put("metadata", meta);

        if (method == null || method.isBlank()) {
            recordInvalid(event, "grpcMethod is required (blank method)");
            return;
        }
        enqueue(event);
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
        LOG.warning("[aforo-grpc] Dropped " + events.size() + " event(s) — " + reason + " (" + total + " total dropped).");
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
     * An event the ingestor would refuse: not buffered, not sent, counted in
     * {@link #droppedCount()}, logged (first, then every 1000th, so a tight loop
     * can't storm the log) and handed to the onDrop hook with {@link DropReason#INVALID}.
     */
    private void recordInvalid(Map<String, Object> event, String violation) {
        long total = dropped.incrementAndGet();
        long invalids = invalidDrops.incrementAndGet();
        if (invalids == 1 || invalids % 1000 == 0) {
            LOG.warning("[aforo-grpc] Dropping invalid event: " + violation + " (" + invalids
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
        try {
            flush();
        } catch (Exception e) {
            LOG.log(Level.WARNING, "[aforo-grpc] flush failed", e);
        }
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
                    LOG.warning("[aforo-grpc] ingestor returned " + status + " — not retrying"
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
        LOG.warning("[aforo-grpc] flush exhausted retries — dropped " + events.size() + " events");
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
        LOG.warning("[aforo-grpc] ingestor rejected " + failed + " of " + events.size() + " event(s)"
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
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
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

    private static final Function<Metadata, String> DEFAULT_CUSTOMER_EXTRACTOR = headers -> {
        Metadata.Key<String> key = Metadata.Key.of("x-customer-id", Metadata.ASCII_STRING_MARSHALLER);
        return headers.get(key);
    };

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

    private static String stripTrailingSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    /** The client-level {@code productType} stamped on events without a per-call override. */
    public String getProductType() { return productType; }

    public static Builder newBuilder() { return new Builder(); }

    /** Fluent builder. */
    public static final class Builder {
        private String productType;
        private String tenantId, productId, apiKey, ingestorUrl, serviceName;
        private int flushCount = 50;
        private long flushIntervalMs = 5_000L;
        private BiConsumer<java.util.List<Map<String, Object>>, DropReason> onDrop;
        private Function<Metadata, String> customerIdExtractor;

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
        public Builder flushCount(int n)        { this.flushCount = n; return this; }
        public Builder flushIntervalMs(long n)  { this.flushIntervalMs = n; return this; }
        /**
         * Opt-in hook receiving events that were permanently dropped (retry
         * exhaustion, a terminal rejection, or an event that breaks an ingestor
         * field limit — {@code DropReason.INVALID}). Events keep their idempotency
         * keys, so persisting and re-submitting them after recovery is
         * dedup-safe. Exceptions thrown by the hook are swallowed. Default:
         * none (drops are still counted in droppedCount() and WARN-logged).
         */
        public Builder onDrop(BiConsumer<java.util.List<Map<String, Object>>, DropReason> fn) { this.onDrop = fn; return this; }
        public Builder customerIdExtractor(Function<Metadata, String> fn) { this.customerIdExtractor = fn; return this; }
        public AforoGrpcBilling build()         { return new AforoGrpcBilling(this); }
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
