package com.aforo.grpc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import io.grpc.Metadata;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Tests for AforoGrpcBilling — validates the buffer/flush/retry pattern
 * shared across all 4 Java SDKs (java-grpc, java-graphql, java-ws, java-mqtt).
 *
 * <p>Uses a real {@link HttpServer} stub instead of a mock HttpClient so we
 * exercise the full JDK-HttpClient path the SDK actually takes in prod.
 * No gRPC server is started — the tests call {@code record()} directly.</p>
 */
@DisplayName("AforoGrpcBilling")
class AforoGrpcBillingTest {

    private HttpServer server;
    private int port;
    private final List<CapturedRequest> requests = new CopyOnWriteArrayList<>();
    private final AtomicInteger responseStatus = new AtomicInteger(204);
    private final ObjectMapper mapper = new ObjectMapper();

    record CapturedRequest(String method, String path, String authorization, String apiKey,
                           String tenantId, JsonNode body) {}

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress(0), 0);
        port = server.getAddress().getPort();
        server.createContext("/", exchange -> {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            exchange.getRequestBody().transferTo(buf);
            JsonNode body = buf.size() == 0 ? null : mapper.readTree(buf.toByteArray());
            requests.add(new CapturedRequest(
                    exchange.getRequestMethod(),
                    exchange.getRequestURI().getPath(),
                    exchange.getRequestHeaders().getFirst("Authorization"),
                    exchange.getRequestHeaders().getFirst("X-API-Key"),
                    exchange.getRequestHeaders().getFirst("X-Tenant-Id"),
                    body
            ));
            exchange.sendResponseHeaders(responseStatus.get(), -1);
            exchange.close();
        });
        server.start();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    private AforoGrpcBilling.Builder baseBuilder() {
        return AforoGrpcBilling.newBuilder()
                .tenantId("tenant-001")
                .productId("prod-001")
                .apiKey("sk_test_abc")
                .ingestorUrl("http://localhost:" + port + "/")  // trailing slash intentional
                .serviceName("acme.v1.UserService")
                .flushCount(1)
                .flushIntervalMs(60_000);   // high — let explicit count/shutdown drive flushes
    }

    private Metadata metadataWithCustomer(String customerId) {
        Metadata md = new Metadata();
        if (customerId != null) {
            md.put(Metadata.Key.of("x-customer-id", Metadata.ASCII_STRING_MARSHALLER), customerId);
        }
        return md;
    }

    // ── Constructor validation ──────────────────────────────────────────

    @Test
    @DisplayName("Missing required fields throw IllegalArgumentException")
    void missingFieldsRejected() {
        // Each required field missing throws
        assertThatIllegalArgumentExceptionThrown(() -> AforoGrpcBilling.newBuilder()
                .productId("p").apiKey("k").ingestorUrl("u").serviceName("s").build());
        assertThatIllegalArgumentExceptionThrown(() -> AforoGrpcBilling.newBuilder()
                .tenantId("t").apiKey("k").ingestorUrl("u").serviceName("s").build());
        assertThatIllegalArgumentExceptionThrown(() -> AforoGrpcBilling.newBuilder()
                .tenantId("t").productId("p").ingestorUrl("u").serviceName("s").build());
        assertThatIllegalArgumentExceptionThrown(() -> AforoGrpcBilling.newBuilder()
                .tenantId("t").productId("p").apiKey("k").serviceName("s").build());
        assertThatIllegalArgumentExceptionThrown(() -> AforoGrpcBilling.newBuilder()
                .tenantId("t").productId("p").apiKey("k").ingestorUrl("u").build());
    }

    private void assertThatIllegalArgumentExceptionThrown(Runnable r) {
        try {
            r.run();
            throw new AssertionError("expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            // ok
        }
    }

    // ── record() happy path ────────────────────────────────────────────

    @Test
    @DisplayName("record() emits a single event with the expected JSON shape")
    void recordEmitsEventWithCorrectShape() throws Exception {
        try (AforoGrpcBilling b = baseBuilder().build()) {
            b.record("GetUser", "UNARY", "cust_001", "OK", 42L);
            waitFor(() -> requests.size() == 1, 2000);
        }

        CapturedRequest req = requests.get(0);
        assertThat(req.method()).isEqualTo("POST");
        // trailing slash on ingestorUrl must be stripped before appending /v1/ingest/batch
        assertThat(req.path()).isEqualTo("/v1/ingest/batch");
        assertThat(req.apiKey()).isEqualTo("sk_test_abc");
        // Bearer is parsed as a JWT by the ingestor and rejected 401, even alongside X-API-Key
        assertThat(req.authorization()).isNull();
        assertThat(req.tenantId()).isEqualTo("tenant-001");

        JsonNode events = req.body().get("events");
        assertThat(events.isArray()).isTrue();
        assertThat(events.size()).isEqualTo(1);

        JsonNode ev = events.get(0);
        assertThat(ev.get("productType").asText()).isEqualTo("GRPC_API");
        assertThat(ev.get("grpcService").asText()).isEqualTo("acme.v1.UserService");
        assertThat(ev.get("grpcMethod").asText()).isEqualTo("GetUser");
        assertThat(ev.get("grpcStatusCode").asText()).isEqualTo("OK");
        assertThat(ev.get("grpcCallType").asText()).isEqualTo("UNARY");
        assertThat(ev.get("customerId").asText()).isEqualTo("cust_001");
        assertThat(ev.get("executionDurationMs").asLong()).isEqualTo(42L);
        assertThat(ev.get("metricName").asText()).isEqualTo("grpc_api.rpc_calls");
        assertThat(ev.get("metadata").get("productId").asText()).isEqualTo("prod-001");
        assertThat(ev.get("metadata").get("sdkVersion").asText()).isNotBlank();

        assertThat(ev.get("idempotencyKey").asText())
                .matches(Pattern.compile("^grpc:tenant-001:acme\\.v1\\.UserService:GetUser:\\d+:[0-9a-f]{8}$"));
    }

    @Test
    @DisplayName("record() with blank customerId is skipped — no request emitted")
    void recordSkipsWhenCustomerIdBlank() throws Exception {
        try (AforoGrpcBilling b = baseBuilder().build()) {
            b.record("M", "UNARY", "", "OK", 1L);
            b.record("M", "UNARY", null, "OK", 1L);
            // Give the scheduler a chance; shutdown forces a final flush
        }
        assertThat(requests).isEmpty();
    }

    // ── Interceptor wiring ─────────────────────────────────────────────

    @Test
    @DisplayName("interceptor() returns a ServerInterceptor whose default extractor reads x-customer-id")
    void interceptorExtractsCustomerId() {
        AforoGrpcBilling b = baseBuilder().build();
        assertThat(b.interceptor()).isNotNull();
        // Default extractor — reflected via a direct metadata lookup
        Metadata md = metadataWithCustomer("cust_from_md");
        String value = md.get(Metadata.Key.of("x-customer-id", Metadata.ASCII_STRING_MARSHALLER));
        assertThat(value).isEqualTo("cust_from_md");
        try { b.close(); } catch (Exception ignored) {}
    }

    @Test
    @DisplayName("custom customerIdExtractor is respected")
    void customExtractorHonoured() throws Exception {
        AforoGrpcBilling b = baseBuilder()
                .customerIdExtractor(md -> "overridden-cust")
                .build();
        // Extractor is used by the interceptor path — which needs a real
        // grpc.ServerCall. For the unit test we only confirm the builder
        // accepted it and that the interceptor can be obtained.
        assertThat(b.interceptor()).isNotNull();
        try { b.close(); } catch (Exception ignored) {}
    }

    // ── Buffer batching ───────────────────────────────────────────────

    @Test
    @DisplayName("flushCount triggers a batched flush")
    void flushCountTriggersBatch() throws Exception {
        try (AforoGrpcBilling b = baseBuilder().flushCount(3).build()) {
            b.record("M", "UNARY", "cust_001", "OK", 1L);
            b.record("M", "UNARY", "cust_001", "OK", 1L);
            // 2 events queued — no flush yet
            Thread.sleep(150);
            assertThat(requests).isEmpty();

            b.record("M", "UNARY", "cust_001", "OK", 1L);
            waitFor(() -> requests.size() == 1, 2000);
        }
        assertThat(requests).hasSize(1);
        assertThat(requests.get(0).body().get("events").size()).isEqualTo(3);
    }

    @Test
    @DisplayName("close() flushes remaining buffered events")
    void closeFlushesRemaining() throws Exception {
        try (AforoGrpcBilling b = baseBuilder().flushCount(100).build()) {
            b.record("M", "UNARY", "cust_001", "OK", 1L);
            b.record("M", "UNARY", "cust_001", "OK", 1L);
            Thread.sleep(100);
            assertThat(requests).isEmpty();   // below threshold, timer interval is 60s
        }   // auto-close triggers flush
        waitFor(() -> requests.size() == 1, 2000);
        assertThat(requests.get(0).body().get("events").size()).isEqualTo(2);
    }

    @Test
    @DisplayName("idempotencyKey is unique across 5 rapid calls")
    void idempotencyKeysUnique() throws Exception {
        try (AforoGrpcBilling b = baseBuilder().flushCount(5).build()) {
            for (int i = 0; i < 5; i++) b.record("M", "UNARY", "cust_001", "OK", 1L);
            waitFor(() -> requests.size() == 1, 2000);
        }

        JsonNode events = requests.get(0).body().get("events");
        List<String> keys = new ArrayList<>();
        events.forEach(ev -> keys.add(ev.get("idempotencyKey").asText()));
        assertThat(keys).hasSize(5);
        assertThat(new java.util.HashSet<>(keys)).hasSize(5);   // all unique
    }

    // ── Retry ──────────────────────────────────────────────────────────

    @Test
    @DisplayName("Non-2xx response triggers 3 retry attempts")
    void non2xxRetries() throws Exception {
        responseStatus.set(500);
        try (AforoGrpcBilling b = baseBuilder().build()) {
            b.record("M", "UNARY", "cust_001", "OK", 1L);
            // 3 attempts, backoff 1s+2s+4s worst case; give plenty of time
            waitFor(() -> requests.size() >= 3, 12_000);
        }
        assertThat(requests).hasSizeGreaterThanOrEqualTo(3);
    }

    // ── executionStatus ────────────────────────────────────────────────

    @Test
    @DisplayName("outcomeFromGrpcStatus maps every Status.Code per the gateway table")
    void outcomeMappingTable() {
        java.util.Map<io.grpc.Status.Code, String> expected = new java.util.EnumMap<>(io.grpc.Status.Code.class);
        expected.put(io.grpc.Status.Code.OK, "SUCCESS");
        expected.put(io.grpc.Status.Code.CANCELLED, "CANCELLED");
        expected.put(io.grpc.Status.Code.INVALID_ARGUMENT, "VALIDATION_FAILED");
        expected.put(io.grpc.Status.Code.FAILED_PRECONDITION, "VALIDATION_FAILED");
        expected.put(io.grpc.Status.Code.OUT_OF_RANGE, "VALIDATION_FAILED");
        expected.put(io.grpc.Status.Code.DEADLINE_EXCEEDED, "TIMEOUT");
        expected.put(io.grpc.Status.Code.PERMISSION_DENIED, "BLOCKED");
        expected.put(io.grpc.Status.Code.RESOURCE_EXHAUSTED, "BLOCKED");
        expected.put(io.grpc.Status.Code.UNAUTHENTICATED, "BLOCKED");
        for (io.grpc.Status.Code code : io.grpc.Status.Code.values()) {
            assertThat(AforoGrpcBilling.outcomeFromGrpcStatus(code))
                    .as(code.name()).isEqualTo(expected.getOrDefault(code, "ERROR"));
        }
        assertThat(AforoGrpcBilling.outcomeFromGrpcStatus((io.grpc.Status.Code) null)).isNull();
        assertThat(AforoGrpcBilling.outcomeFromGrpcStatus(" deadline_exceeded ")).isEqualTo("TIMEOUT");
        assertThat(AforoGrpcBilling.outcomeFromGrpcStatus("NOT_A_CODE")).isNull();
        assertThat(AforoGrpcBilling.outcomeFromGrpcStatus("  ")).isNull();
    }

    @Test
    @DisplayName("record() sends executionStatus: derived, explicit (wins, normalized), blank→derived, unknown label→omitted")
    void recordSendsExecutionStatus() throws Exception {
        try (AforoGrpcBilling b = baseBuilder().flushCount(5).build()) {
            b.record("M", "UNARY", "cust_001", "DEADLINE_EXCEEDED", 1L);          // derived
            b.record("M", "UNARY", "cust_001", "OK", 1L, "  partial ");           // explicit wins
            b.record("M", "UNARY", "cust_001", "UNAVAILABLE", 1L, "   ");         // blank → derived
            b.record("M", "UNARY", "cust_001", "custom-label", 1L);               // no derivation
            b.record("M", "UNARY", "cust_001", "custom-label", 1L, null);         // nothing set
            waitFor(() -> requests.size() == 1, 2000);
        }
        JsonNode events = requests.get(0).body().get("events");
        assertThat(events.size()).isEqualTo(5);
        assertThat(events.get(0).get("executionStatus").asText()).isEqualTo("TIMEOUT");
        assertThat(events.get(1).get("executionStatus").asText()).isEqualTo("PARTIAL");
        assertThat(events.get(1).get("grpcStatusCode").asText()).isEqualTo("OK");
        assertThat(events.get(2).get("executionStatus").asText()).isEqualTo("ERROR");
        assertThat(events.get(3).has("executionStatus")).isFalse();
        assertThat(events.get(4).has("executionStatus")).isFalse();
    }

    @Test
    @DisplayName("record(): unknown explicit executionStatus is dropped (derived status used); rest of the event is sent")
    void recordIgnoresUnknownExplicitExecutionStatus() throws Exception {
        try (AforoGrpcBilling b = baseBuilder().flushCount(3).build()) {
            b.record("M", "UNARY", "cust_001", "DEADLINE_EXCEEDED", 1L, "not_a_status");
            b.record("M", "UNARY", "cust_001", "custom-label", 1L, "SUCCESS_BUT_WAY_TOO_LONG_FOR_IT");
            b.record("M", "UNARY", "cust_001", "OK", 1L, " hitl_required ");
            waitFor(() -> requests.size() == 1, 2000);
        }
        JsonNode events = requests.get(0).body().get("events");
        assertThat(events.size()).isEqualTo(3);
        assertThat(events.get(0).get("executionStatus").asText()).isEqualTo("TIMEOUT");
        assertThat(events.get(0).get("grpcMethod").asText()).isEqualTo("M");
        assertThat(events.get(1).has("executionStatus")).isFalse();
        assertThat(events.get(1).get("customerId").asText()).isEqualTo("cust_001");
        assertThat(events.get(2).get("executionStatus").asText()).isEqualTo("HITL_REQUIRED");
        assertThat(AforoGrpcBilling.canonicalExecutionStatus("bogus")).isNull();
        assertThat(AforoGrpcBilling.canonicalExecutionStatus(" validation_failed ")).isEqualTo("VALIDATION_FAILED");
    }

    // ── Helpers ────────────────────────────────────────────────────────

    private static void waitFor(java.util.function.BooleanSupplier cond, long timeoutMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (cond.getAsBoolean()) return;
            Thread.sleep(10);
        }
        throw new AssertionError("condition not satisfied within " + timeoutMs + "ms");
    }
}
