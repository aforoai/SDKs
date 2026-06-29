package com.aforo.mqtt;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Tests for AforoMqttBilling. Unique bits:
 *   - 6 record methods (publish / deliver / subscribe / unsubscribe / connect / disconnect)
 *   - DELIVER opt-in via emitDeliverEvents
 *   - QoS + retained flags carried on every event
 *   - metricName formula: mqtt_broker.{eventType.lower()}
 */
@DisplayName("AforoMqttBilling")
class AforoMqttBillingTest {

    private HttpServer server;
    private int port;
    private final List<JsonNode> requestBodies = new CopyOnWriteArrayList<>();
    private final ObjectMapper mapper = new ObjectMapper();

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress(0), 0);
        port = server.getAddress().getPort();
        server.createContext("/", exchange -> {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            exchange.getRequestBody().transferTo(buf);
            requestBodies.add(buf.size() == 0 ? mapper.nullNode() : mapper.readTree(buf.toByteArray()));
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        server.start();
    }

    @AfterEach
    void stopServer() { server.stop(0); }

    private AforoMqttBilling.Builder baseBuilder() {
        return AforoMqttBilling.newBuilder()
                .tenantId("tenant-001")
                .productId("prod-mqtt-001")
                .apiKey("sk_mqtt_abc")
                .ingestorUrl("http://localhost:" + port)
                .flushCount(1)
                .flushIntervalMs(60_000);
    }

    private List<JsonNode> allEvents() {
        List<JsonNode> out = new ArrayList<>();
        for (JsonNode body : requestBodies) {
            JsonNode events = body.get("events");
            if (events != null && events.isArray()) events.forEach(out::add);
        }
        return out;
    }

    // ── PUBLISH event shape ────────────────────────────────────────────

    @Test
    @DisplayName("recordPublish emits correct event shape")
    void publishShape() throws Exception {
        try (AforoMqttBilling b = baseBuilder().build()) {
            b.recordPublish("cust_001", "device-001", "sensors/room-a/temperature", 1, false, 4L);
            waitFor(() -> !allEvents().isEmpty(), 2000);
        }
        JsonNode ev = allEvents().get(0);
        assertThat(ev.get("productType").asText()).isEqualTo("MQTT_BROKER");
        assertThat(ev.get("mqttEventType").asText()).isEqualTo("PUBLISH");
        assertThat(ev.get("mqttTopic").asText()).isEqualTo("sensors/room-a/temperature");
        assertThat(ev.get("mqttQos").asInt()).isEqualTo(1);
        assertThat(ev.get("mqttRetained").asBoolean()).isFalse();
        assertThat(ev.get("mqttClientId").asText()).isEqualTo("device-001");
        assertThat(ev.get("dataBytes").asLong()).isEqualTo(4L);
        assertThat(ev.get("customerId").asText()).isEqualTo("cust_001");
        assertThat(ev.get("metricName").asText()).isEqualTo("mqtt_broker.publish");
    }

    // ── DELIVER opt-in ─────────────────────────────────────────────────

    @Test
    @DisplayName("recordDeliver is skipped when emitDeliverEvents=false (default)")
    void deliverSkippedByDefault() throws Exception {
        try (AforoMqttBilling b = baseBuilder().flushCount(100).build()) {
            b.recordDeliver("cust_001", "device-001", "t", 0, false, 10L);
        }
        assertThat(allEvents()).isEmpty();
    }

    @Test
    @DisplayName("recordDeliver is emitted when emitDeliverEvents=true")
    void deliverEmittedWhenEnabled() throws Exception {
        try (AforoMqttBilling b = baseBuilder().emitDeliverEvents(true).build()) {
            b.recordDeliver("cust_001", "device-001", "sensors/a", 1, false, 7L);
            waitFor(() -> !allEvents().isEmpty(), 2000);
        }
        JsonNode ev = allEvents().get(0);
        assertThat(ev.get("mqttEventType").asText()).isEqualTo("DELIVER");
        assertThat(ev.get("metricName").asText()).isEqualTo("mqtt_broker.deliver");
    }

    // ── All 6 event types → metricName formula ──────────────────────────

    @ParameterizedTest(name = "{0} → mqtt_broker.{1}")
    @CsvSource({
            "PUBLISH, publish",
            "SUBSCRIBE, subscribe",
            "UNSUBSCRIBE, unsubscribe",
            "CONNECT, connect",
            "DISCONNECT, disconnect",
    })
    @DisplayName("metricName formula for each event type")
    void metricNameFormula(String eventType, String suffix) throws Exception {
        requestBodies.clear();
        try (AforoMqttBilling b = baseBuilder().build()) {
            switch (eventType) {
                case "PUBLISH" -> b.recordPublish("c", "client", "t", 0, false, 0L);
                case "SUBSCRIBE" -> b.recordSubscribe("c", "client", "t", 0);
                case "UNSUBSCRIBE" -> b.recordUnsubscribe("c", "client", "t");
                case "CONNECT" -> b.recordConnect("c", "client");
                case "DISCONNECT" -> b.recordDisconnect("c", "client");
            }
            waitFor(() -> !allEvents().isEmpty(), 2000);
        }
        JsonNode ev = allEvents().get(0);
        assertThat(ev.get("mqttEventType").asText()).isEqualTo(eventType);
        assertThat(ev.get("metricName").asText()).isEqualTo("mqtt_broker." + suffix);
    }

    // ── QoS + retained flags on every event (rate-plan filtering) ──────

    @Test
    @DisplayName("QoS and retained flags are carried verbatim")
    void qosRetainedCarried() throws Exception {
        try (AforoMqttBilling b = baseBuilder().flushCount(3).build()) {
            b.recordPublish("c", "client", "t", 0, false, 1L);
            b.recordPublish("c", "client", "t", 1, true, 1L);
            b.recordPublish("c", "client", "t", 2, false, 1L);
            waitFor(() -> !allEvents().isEmpty(), 2000);
        }
        List<JsonNode> events = allEvents();
        assertThat(events).hasSize(3);
        assertThat(events.stream().map(e -> e.get("mqttQos").asInt()).toList())
                .containsExactly(0, 1, 2);
        assertThat(events.stream().map(e -> e.get("mqttRetained").asBoolean()).toList())
                .containsExactly(false, true, false);
    }

    @Test
    @DisplayName("idempotencyKey format: mqtt:{tenant}:{clientId}:{type}:{topic}:{millis}:{8-hex}")
    void idempotencyKeyFormat() throws Exception {
        try (AforoMqttBilling b = baseBuilder().build()) {
            b.recordPublish("cust_001", "c1", "a/b", 0, false, 1L);
            waitFor(() -> !allEvents().isEmpty(), 2000);
        }
        String key = allEvents().get(0).get("idempotencyKey").asText();
        assertThat(key).matches("^mqtt:tenant-001:c1:PUBLISH:a/b:\\d+:[0-9a-f]{8}$");
    }

    @Test
    @DisplayName("close() flushes remaining buffered events")
    void closeFlushes() throws Exception {
        try (AforoMqttBilling b = baseBuilder().flushCount(100).build()) {
            for (int i = 0; i < 4; i++) {
                b.recordPublish("c", "c", "t" + i, 0, false, 0L);
            }
            Thread.sleep(50);
            assertThat(allEvents()).isEmpty();
        }
        waitFor(() -> !allEvents().isEmpty(), 2000);
        assertThat(allEvents()).hasSize(4);
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
