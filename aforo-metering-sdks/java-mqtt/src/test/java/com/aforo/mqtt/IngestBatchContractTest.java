package com.aforo.mqtt;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Wire contract with the usage ingestor: POST /v1/ingest/batch, {"events":[...]} of at most
 * 1000 IngestUsageEventRequest objects, API key only in the X-API-Key header.
 */
@DisplayName("AforoMqttBilling ingest batch contract")
class IngestBatchContractTest {

    private record Captured(String path, String apiKey, String rawBody, JsonNode body) {}

    private static final String API_KEY = "sk_contract_key";
    private final ObjectMapper mapper = new ObjectMapper();
    private final List<Captured> captured = new CopyOnWriteArrayList<>();
    private final AtomicInteger failuresBeforeSuccess = new AtomicInteger();
    private final AtomicInteger failureStatus = new AtomicInteger(500);
    private HttpServer server;
    private int port;

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        port = server.getAddress().getPort();
        server.createContext("/", exchange -> {
            String raw = new String(exchange.getRequestBody().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            captured.add(new Captured(exchange.getRequestURI().getPath(),
                    exchange.getRequestHeaders().getFirst("X-API-Key"), raw, mapper.readTree(raw)));
            int status = failuresBeforeSuccess.getAndDecrement() > 0 ? failureStatus.get() : 202;
            if (status == 429) exchange.getResponseHeaders().add("Retry-After", "0");
            if (status == 400) {
                byte[] err = "{\"accepted\":0,\"failed\":1,\"errors\":[{\"index\":0,\"message\":\"bad event\"}]}"
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(status, err.length);
                exchange.getResponseBody().write(err);
                exchange.close();
                return;
            }
            exchange.sendResponseHeaders(status, -1);
            exchange.close();
        });
        server.start();
    }

    @AfterEach
    void stopServer() { server.stop(0); }

    private AforoMqttBilling.Builder builder() {
        return AforoMqttBilling.newBuilder().tenantId("tenant-001").productId("prod-mqtt")
                .apiKey(API_KEY).ingestorUrl("http://127.0.0.1:" + port).flushIntervalMs(60_000);
    }

    @Test
    @DisplayName("POSTs {events:[...]} to /v1/ingest/batch with X-API-Key and DTO field names")
    void batchShape() throws Exception {
        try (AforoMqttBilling b = builder().flushCount(1).build()) {
            b.recordPublish("cust_001", "sensor-1", "sensors/a/temp", 1, true, 64L);
            waitFor(() -> !captured.isEmpty(), 3000);
        }
        Captured req = captured.get(0);
        assertThat(req.path()).isEqualTo("/v1/ingest/batch");
        assertThat(req.apiKey()).isEqualTo(API_KEY);
        assertThat(req.rawBody()).doesNotContain(API_KEY);
        assertThat(req.body().findValue("apiKey")).isNull();
        assertThat(iterable(req.body().fieldNames())).containsExactly("events");
        assertThat(req.body().get("events").size()).isBetween(1, 1000);

        JsonNode ev = req.body().get("events").get(0);
        assertThat(ALLOWED_FIELDS).containsAll(iterable(ev.fieldNames()));
        assertThat(ev.get("customerId").asText()).isEqualTo("cust_001");
        assertThat(ev.get("metricName").asText()).isNotBlank();
        assertThat(ev.get("quantity").asDouble()).isGreaterThan(0);
        Instant.parse(ev.get("occurredAt").asText());
        assertThat(ev.get("idempotencyKey").asText()).isNotBlank().hasSizeLessThanOrEqualTo(255);
        assertThat(ev.get("productType").asText()).isEqualTo("MQTT_BROKER");
        assertThat(ev.get("mqttTopic").asText()).isEqualTo("sensors/a/temp");
        assertThat(ev.get("mqttQos").asInt()).isEqualTo(1);
        assertThat(ev.get("mqttRetained").asBoolean()).isTrue();
        assertThat(ev.get("mqttEventType").asText()).isEqualTo("PUBLISH");
        assertThat(ev.get("mqttClientId").asText()).isEqualTo("sensor-1");
        assertThat(ev.get("dataBytes").asLong()).isEqualTo(64L);
    }

    @Test
    @DisplayName("CONNECT / DISCONNECT carry a non-blank mqttTopic (required by the ingestor)")
    void lifecycleEventsHaveTopic() throws Exception {
        try (AforoMqttBilling b = builder().flushCount(2).build()) {
            b.recordConnect("cust_001", "sensor-1");
            b.recordDisconnect("cust_001", "sensor-1");
            waitFor(() -> !captured.isEmpty(), 3000);
        }
        JsonNode evs = captured.get(0).body().get("events");
        assertThat(evs.get(0).get("mqttTopic").asText()).isEqualTo("$SYS/clients/sensor-1/connected");
        assertThat(evs.get(1).get("mqttTopic").asText()).isEqualTo("$SYS/clients/sensor-1/disconnected");
    }

    @Test
    @DisplayName("a flush of 2500 events is sliced into requests of at most 1000")
    void slicesLargeFlushes() throws Exception {
        try (AforoMqttBilling b = builder().flushCount(10_000).build()) {
            for (int i = 0; i < 2500; i++) {
                b.recordPublish("cust_001", "sensor-1", "sensors/" + i, 0, false, 1L);
            }
        }
        waitFor(() -> captured.stream().mapToInt(c -> c.body().get("events").size()).sum() == 2500, 5000);
        assertThat(captured).hasSize(3);
        for (Captured c : captured) {
            assertThat(c.path()).isEqualTo("/v1/ingest/batch");
            assertThat(c.body().get("events").size()).isBetween(1, 1000);
        }
        Set<String> keys = new java.util.HashSet<>();
        captured.forEach(c -> c.body().get("events").forEach(e -> keys.add(e.get("idempotencyKey").asText())));
        assertThat(keys).hasSize(2500);
    }

    @Test
    @DisplayName("a retried request resends the same idempotency keys")
    void retryKeepsIdempotencyKey() throws Exception {
        failuresBeforeSuccess.set(1);
        try (AforoMqttBilling b = builder().flushCount(1).build()) {
            b.recordPublish("cust_001", "sensor-1", "sensors/a/temp", 1, true, 64L);
            waitFor(() -> captured.size() == 2, 5000);
        }
        assertThat(captured.get(1).body().get("events").get(0).get("idempotencyKey").asText())
                .isEqualTo(captured.get(0).body().get("events").get(0).get("idempotencyKey").asText());
    }

    @Test
    @DisplayName("customerId longer than 64 chars is not sent")
    void overlongCustomerDropped() throws Exception {
        try (AforoMqttBilling b = builder().flushCount(1).build()) {
            b.recordPublish("c".repeat(65), "sensor-1", "t", 0, false, 1L);
            Thread.sleep(100);
        }
        assertThat(captured).isEmpty();
    }

    @Test
    @DisplayName("productType defaults to MQTT_BROKER; client option is trimmed and uppercased")
    void clientProductType() throws Exception {
        try (AforoMqttBilling b = builder().build()) {
            assertThat(b.getProductType()).isEqualTo("MQTT_BROKER");
        }
        try (AforoMqttBilling b = builder().productType(" api ").flushCount(1).build()) {
            assertThat(b.getProductType()).isEqualTo("API");
            b.recordPublish("cust_001", "sensor-1", "sensors/a/temp", 1, false, 8L);
            waitFor(() -> !captured.isEmpty(), 3000);
        }
        assertThat(captured.get(0).body().get("events").get(0).get("productType").asText()).isEqualTo("API");
    }

    @Test
    @DisplayName("a 400 is not retried")
    void badRequestNotRetried() throws Exception {
        failuresBeforeSuccess.set(5);
        failureStatus.set(400);
        try (AforoMqttBilling b = builder().flushCount(1).build()) {
            b.recordPublish("cust_001", "sensor-1", "sensors/a/temp", 1, false, 8L);
            waitFor(() -> !captured.isEmpty(), 3000);
            Thread.sleep(1_500); // longer than the first backoff
        }
        assertThat(captured).hasSize(1);
    }

    @Test
    @DisplayName("a 429 is retried after Retry-After, with the same idempotency key")
    void tooManyRequestsHonoursRetryAfter() throws Exception {
        failuresBeforeSuccess.set(1);
        failureStatus.set(429);
        long start = System.currentTimeMillis();
        try (AforoMqttBilling b = builder().flushCount(1).build()) {
            b.recordPublish("cust_001", "sensor-1", "sensors/a/temp", 1, false, 8L);
            waitFor(() -> captured.size() == 2, 3000);
        }
        // Retry-After: 0 replaces the 1s exponential backoff.
        assertThat(System.currentTimeMillis() - start).isLessThan(900);
        assertThat(captured.get(1).body().get("events").get(0).get("idempotencyKey").asText())
                .isEqualTo(captured.get(0).body().get("events").get(0).get("idempotencyKey").asText());
    }

    /** Every top-level JSON name IngestUsageEventRequest binds; anything else is dropped server-side. */
    private static final Set<String> ALLOWED_FIELDS = Set.of(
            "customerId", "metricName", "quantity", "occurredAt", "idempotencyKey", "traceId", "spanId",
            "sessionId", "metadata", "productType", "executionDurationMs", "executionStatus", "dataBytes",
            "messageCount", "grpcService", "grpcMethod", "grpcStatusCode", "grpcCallType", "gqlOperationType",
            "gqlOperationName", "gqlComplexity", "gqlFieldCount", "gqlHasErrors", "wsConnectionId",
            "wsDirection", "wsFrameType", "wsCloseReason", "mqttTopic", "mqttQos", "mqttRetained",
            "mqttEventType", "mqttClientId");

    private static <T> List<T> iterable(java.util.Iterator<T> it) {
        List<T> out = new ArrayList<>();
        it.forEachRemaining(out::add);
        return out;
    }

    private static void waitFor(java.util.function.BooleanSupplier cond, long timeoutMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (cond.getAsBoolean()) return;
            Thread.sleep(10);
        }
        throw new AssertionError("condition not satisfied within " + timeoutMs + "ms");
    }
}
