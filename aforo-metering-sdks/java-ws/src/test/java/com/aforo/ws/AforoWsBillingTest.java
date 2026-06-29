package com.aforo.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Predicate;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Tests for AforoWsBilling. Unique bits:
 *   - openConnection → N recordFrame → closeConnection lifecycle
 *   - perFrameEvents flag (off by default)
 *   - close-code → enum mapping (1000 NORMAL_CLOSURE, 4xxx IDLE_TIMEOUT, etc.)
 */
@DisplayName("AforoWsBilling")
class AforoWsBillingTest {

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

    private AforoWsBilling.Builder baseBuilder() {
        return AforoWsBilling.newBuilder()
                .tenantId("tenant-001")
                .productId("prod-ws-001")
                .apiKey("sk_ws_abc")
                .ingestorUrl("http://localhost:" + port)
                .flushCount(100)
                .flushIntervalMs(60_000);
    }

    private List<JsonNode> allEvents() {
        List<JsonNode> out = new java.util.ArrayList<>();
        for (JsonNode body : requestBodies) {
            JsonNode events = body.get("events");
            if (events != null && events.isArray()) {
                events.forEach(out::add);
            }
        }
        return out;
    }

    private List<JsonNode> eventsWhere(Predicate<JsonNode> p) {
        return allEvents().stream().filter(p).toList();
    }

    // ── Lifecycle: open → close ────────────────────────────────────────

    @Test
    @DisplayName("openConnection emits CONNECTION_OPENED event immediately (PING marker)")
    void openConnectionEmitsOpen() throws Exception {
        try (AforoWsBilling b = baseBuilder().flushCount(1).build()) {
            String connId = b.openConnection("cust_001", Map.of("region", "us-east-1"));
            assertThat(connId).isNotBlank();
            waitFor(() -> requestBodies.size() == 1, 2000);
        }
        JsonNode ev = requestBodies.get(0).get("events").get(0);
        assertThat(ev.get("productType").asText()).isEqualTo("WEBSOCKET_API");
        assertThat(ev.get("wsFrameType").asText()).isEqualTo("PING");
        assertThat(ev.get("messageCount").asInt()).isEqualTo(0);
        assertThat(ev.get("metadata").get("event").asText()).isEqualTo("CONNECTION_OPENED");
        assertThat(ev.get("metadata").get("region").asText()).isEqualTo("us-east-1");
    }

    @Test
    @DisplayName("closeConnection emits CONNECTION_CLOSED with aggregated counters")
    void closeConnectionAggregates() throws Exception {
        try (AforoWsBilling b = baseBuilder().build()) {
            String connId = b.openConnection("cust_001", null);
            b.recordFrame(connId, "CLIENT_TO_SERVER", "TEXT", 3);
            b.recordFrame(connId, "CLIENT_TO_SERVER", "TEXT", 4);
            b.recordFrame(connId, "SERVER_TO_CLIENT", "TEXT", 5);
            b.closeConnection(connId, 1000);
        }
        waitFor(() -> !allEvents().isEmpty(), 2000);

        List<JsonNode> closes = eventsWhere(ev ->
                ev.get("wsFrameType").asText().equals("CLOSE"));
        assertThat(closes).hasSize(1);
        JsonNode ev = closes.get(0);
        assertThat(ev.get("wsCloseReason").asText()).isEqualTo("NORMAL_CLOSURE");
        assertThat(ev.get("messageCount").asInt()).isEqualTo(3);
        assertThat(ev.get("dataBytes").asLong()).isEqualTo(12L);
        assertThat(ev.get("durationMs").asLong()).isGreaterThanOrEqualTo(0L);
        assertThat(ev.get("metricName").asText()).isEqualTo("websocket_api.connection_closed");
    }

    @Test
    @DisplayName("perFrameEvents=false: recordFrame does NOT emit events")
    void perFrameOff() throws Exception {
        try (AforoWsBilling b = baseBuilder().perFrameEvents(false).build()) {
            String connId = b.openConnection("cust_001", null);
            for (int i = 0; i < 5; i++) {
                b.recordFrame(connId, "CLIENT_TO_SERVER", "TEXT", 10);
            }
            b.closeConnection(connId, 1000);
        }
        waitFor(() -> !allEvents().isEmpty(), 2000);

        // Default: only OPEN + CLOSE events (2 total), no per-frame MESSAGE events
        List<JsonNode> frameMessages = eventsWhere(ev -> {
            String type = ev.get("wsFrameType").asText();
            JsonNode eventField = ev.get("metadata").get("event");
            boolean isLifecycle = eventField != null
                    && (eventField.asText().equals("CONNECTION_OPENED")
                        || eventField.asText().equals("CONNECTION_CLOSED"));
            return !isLifecycle && !type.equals("CLOSE") && !type.equals("PING");
        });
        assertThat(frameMessages).isEmpty();
    }

    @Test
    @DisplayName("perFrameEvents=true: each recordFrame emits a MESSAGE event")
    void perFrameOn() throws Exception {
        try (AforoWsBilling b = baseBuilder().perFrameEvents(true).build()) {
            String connId = b.openConnection("cust_001", null);
            b.recordFrame(connId, "CLIENT_TO_SERVER", "TEXT", 10);
            b.recordFrame(connId, "SERVER_TO_CLIENT", "BINARY", 20);
            b.closeConnection(connId, 1000);
        }
        waitFor(() -> !allEvents().isEmpty(), 2000);

        // OPEN + 2 frames + CLOSE = 4 events total
        List<JsonNode> messages = eventsWhere(ev -> {
            String frameType = ev.get("wsFrameType").asText();
            return frameType.equals("TEXT") || frameType.equals("BINARY");
        });
        assertThat(messages).hasSize(2);
        assertThat(messages.get(0).get("metricName").asText()).isEqualTo("websocket_api.message");
    }

    // ── Close-code mapping ─────────────────────────────────────────────

    @Test
    @DisplayName("Close-code mapping covers standard codes")
    void closeCodeMapping() throws Exception {
        int[][] cases = {
                {1000, 0}, {1001, 0}, {1002, 0}, {1003, 0},
                {1006, 0}, {1008, 0}, {1009, 0}, {1011, 0}, {4000, 0},
        };
        String[] expected = {
                "NORMAL_CLOSURE", "GOING_AWAY", "PROTOCOL_ERROR", "UNSUPPORTED_DATA",
                "ABNORMAL_CLOSURE", "POLICY_VIOLATION", "MESSAGE_TOO_BIG", "INTERNAL_ERROR",
                "IDLE_TIMEOUT"
        };

        for (int i = 0; i < cases.length; i++) {
            requestBodies.clear();
            try (AforoWsBilling b = baseBuilder().build()) {
                String connId = b.openConnection("cust_001", null);
                b.closeConnection(connId, cases[i][0]);
            }
            waitFor(() -> !allEvents().isEmpty(), 2000);

            List<JsonNode> closes = eventsWhere(ev ->
                    ev.get("wsFrameType").asText().equals("CLOSE"));
            assertThat(closes).hasSize(1);
            assertThat(closes.get(0).get("wsCloseReason").asText())
                    .as("code %d", cases[i][0])
                    .isEqualTo(expected[i]);
        }
    }

    @Test
    @DisplayName("recordFrame on unknown connectionId is a no-op")
    void unknownConnectionIsNoOp() throws Exception {
        try (AforoWsBilling b = baseBuilder().build()) {
            b.recordFrame("nonexistent-conn-id", "CLIENT_TO_SERVER", "TEXT", 5);
            b.closeConnection("nonexistent-conn-id", 1000);
        }
        // Neither call should produce any event
        assertThat(allEvents()).isEmpty();
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
