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
    private static final String SDK_VERSION = "1.0.0";
    /** The ingestor rejects {@code /v1/ingest/batch} requests with more than 1000 events. */
    static final int MAX_EVENTS_PER_REQUEST = 1000;
    private static final int MAX_CUSTOMER_ID = 64;
    private static final int MAX_IDEMPOTENCY_KEY = 255;
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
                                if (validCustomerId(customerId)) {
                                    record(method, callType, customerId, status.getCode().name(),
                                            System.currentTimeMillis() - start);
                                }
                                super.close(status, trailers);
                            }
                        };
                return next.startCall(wrapped, headers);
            }
        };
    }

    /** Record a single RPC. Public so streaming handlers can call it directly. */
    public void record(String method, String callType, String customerId, String status, long durationMs) {
        record(method, callType, customerId, status, durationMs, null);
    }

    /**
     * Record a single RPC with a per-call {@code productType} override
     * ({@code null}/blank → the client-level {@link Builder#productType(String)}).
     */
    public void record(String method, String callType, String customerId, String status, long durationMs,
                       String productTypeOverride) {
        if (!validCustomerId(customerId) || method == null || method.isBlank()) return;

        Instant now = Instant.now();
        Map<String, Object> event = new HashMap<>();
        event.put("customerId", customerId);
        event.put("metricName", "grpc_api.rpc_calls");
        event.put("quantity", 1);
        event.put("occurredAt", now.toString());
        event.put("idempotencyKey", idempotencyKey("grpc:" + tenantId + ":" + serviceName + ":" + method, now));
        event.put("productType", normalizeProductType(productTypeOverride, productType));
        event.put("grpcService", truncate(serviceName, 255));
        event.put("grpcMethod", truncate(method, 128));
        event.put("grpcCallType", mapCallType(callType == null ? "" : callType.toUpperCase()));
        event.put("messageCount", 1);
        event.put("executionDurationMs", (int) Math.max(0, Math.min(durationMs, Integer.MAX_VALUE)));

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

        buffer.offer(event);
        if (bufferSize.incrementAndGet() >= flushCount) {
            scheduler.execute(this::flushQuietly);
        }
    }

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
        while ((ev = buffer.poll()) != null) {
            batch.add(ev);
            bufferSize.decrementAndGet();
        }
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
                    if (!rejected.isEmpty()) LOG.warning("[aforo-grpc] ingestor rejected events:" + rejected);
                    return;
                }
                // 4xx other than 408/429 (bad key, invalid event, unknown metric) cannot succeed on retry.
                if (status >= 400 && status < 500 && status != 408 && status != 429) {
                    LOG.warning("[aforo-grpc] ingestor returned " + status + " — not retrying, dropped "
                            + events.size() + " events" + errorMessages(resp.body()));
                    return;
                }
                if (status == 429) delayMs = retryAfterMs(resp, delayMs);
            } catch (Exception e) {
                if (attempt == 3) throw e;
            }
            if (attempt < 3) Thread.sleep(delayMs);
        }
        LOG.warning("[aforo-grpc] flush exhausted retries — dropped " + events.size() + " events");
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
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
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

    /** Fluent builder. */
    public static final class Builder {
        private String productType;
        private String tenantId, productId, apiKey, ingestorUrl, serviceName;
        private int flushCount = 50;
        private long flushIntervalMs = 5_000L;
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
        public Builder customerIdExtractor(Function<Metadata, String> fn) { this.customerIdExtractor = fn; return this; }
        public AforoGrpcBilling build()         { return new AforoGrpcBilling(this); }
    }
}
