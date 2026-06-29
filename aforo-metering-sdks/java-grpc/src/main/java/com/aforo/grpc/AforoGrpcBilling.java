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
 *       .ingestorUrl("https://ingestor.aforo.ai")
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

    private final String tenantId;
    private final String productId;
    private final String apiKey;
    private final URI ingestorUri;
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
        this.ingestorUri = URI.create(stripTrailingSlash(require(b.ingestorUrl, "ingestorUrl")) + "/v1/ingest/events");
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
                                if (customerId != null && !customerId.isBlank()) {
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
        if (customerId == null || customerId.isBlank()) return;

        Instant now = Instant.now();
        Map<String, Object> event = new HashMap<>();
        event.put("customerId", customerId);
        event.put("metricName", "grpc_api.rpc_calls");
        event.put("quantity", 1);
        event.put("occurredAt", now.toString());
        event.put("idempotencyKey", "grpc:" + tenantId + ":" + serviceName + ":" + method + ":"
                + now.toEpochMilli() + ":" + UUID.randomUUID().toString().substring(0, 8));
        event.put("productType", "GRPC_API");
        event.put("grpcService", serviceName);
        event.put("grpcMethod", method);
        event.put("grpcStatusCode", status);
        event.put("grpcCallType", callType);
        event.put("messageCount", 1);
        event.put("executionDurationMs", durationMs);

        Map<String, Object> meta = new HashMap<>();
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
        LOG.warning("[aforo-grpc] flush exhausted retries — dropped " + batch.size() + " events");
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

    private static String mapCallType(String grpcMethodType) {
        return switch (grpcMethodType) {
            case "UNARY" -> "UNARY";
            case "CLIENT_STREAMING" -> "CLIENT_STREAM";
            case "SERVER_STREAMING" -> "SERVER_STREAM";
            case "BIDI_STREAMING" -> "BIDI_STREAM";
            default -> "UNARY";
        };
    }

    private static String require(String s, String name) {
        if (s == null || s.isBlank()) throw new IllegalArgumentException(name + " is required");
        return s;
    }

    private static String stripTrailingSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    public static Builder newBuilder() { return new Builder(); }

    /** Fluent builder. */
    public static final class Builder {
        private String tenantId, productId, apiKey, ingestorUrl, serviceName;
        private int flushCount = 50;
        private long flushIntervalMs = 5_000L;
        private Function<Metadata, String> customerIdExtractor;

        public Builder tenantId(String s)       { this.tenantId = s; return this; }
        public Builder productId(String s)      { this.productId = s; return this; }
        public Builder apiKey(String s)         { this.apiKey = s; return this; }
        public Builder ingestorUrl(String s)    { this.ingestorUrl = s; return this; }
        public Builder serviceName(String s)    { this.serviceName = s; return this; }
        public Builder flushCount(int n)        { this.flushCount = n; return this; }
        public Builder flushIntervalMs(long n)  { this.flushIntervalMs = n; return this; }
        public Builder customerIdExtractor(Function<Metadata, String> fn) { this.customerIdExtractor = fn; return this; }
        public AforoGrpcBilling build()         { return new AforoGrpcBilling(this); }
    }
}
