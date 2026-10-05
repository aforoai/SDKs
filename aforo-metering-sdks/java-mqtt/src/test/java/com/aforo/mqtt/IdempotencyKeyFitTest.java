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
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("AforoMqttBilling — over-long topic / client id are truncated, not dropped; key from the full values")
class IdempotencyKeyFitTest {

    private AforoMqttBilling.Builder builder() {
        return AforoMqttBilling.newBuilder().tenantId("tenant-001").productId("prod-mqtt")
                .apiKey("sk_test").ingestorUrl("http://127.0.0.1:" + port).flushIntervalMs(60_000);
    }

    @Test
    @DisplayName("two valid 400-char topics sharing a long prefix: both sent untouched, keys fit in 255 and differ")
    void longValidTopicsGetDistinctKeys() throws Exception {
        String topicA = "t/" + "x".repeat(397) + "A";
        String topicB = "t/" + "x".repeat(397) + "B";
        try (AforoMqttBilling b = builder().flushCount(2).build()) {
            b.recordPublish("cust_001", "sensor-1", topicA, 1, false, 10L);
            b.recordPublish("cust_001", "sensor-1", topicB, 1, false, 10L);
            assertThat(b.droppedCount()).isZero();
            waitFor(() -> received.size() == 2, 3000);
        }
        assertThat(received.get(0).get("mqttTopic").asText()).isEqualTo(topicA);
        assertThat(received.get(1).get("mqttTopic").asText()).isEqualTo(topicB);
        String keyA = received.get(0).get("idempotencyKey").asText();
        String keyB = received.get(1).get("idempotencyKey").asText();
        assertThat(keyA.length()).isLessThanOrEqualTo(255);
        String naturalA = "mqtt:tenant-001:sensor-1:PUBLISH:" + topicA;
        assertThat(naturalPart(keyA)).isEqualTo(AforoMqttBilling.fitKeyPart(naturalA, ROOM))
                .isEqualTo(AforoMqttBilling.fitKeyPart(naturalA, ROOM));
        assertThat(naturalPart(keyB)).isNotEqualTo(naturalPart(keyA));
    }

    @Test
    @DisplayName("a short topic keeps the plain key")
    void shortTopicKeyUnchanged() throws Exception {
        try (AforoMqttBilling b = builder().flushCount(1).build()) {
            b.recordPublish("cust_001", "sensor-1", "sensors/a/temp", 1, false, 10L);
            waitFor(() -> received.size() == 1, 3000);
        }
        assertThat(naturalPart(received.get(0).get("idempotencyKey").asText()))
                .isEqualTo("mqtt:tenant-001:sensor-1:PUBLISH:sensors/a/temp");
    }

    @Test
    @DisplayName("600-char topics: events sent, topic cut to 500, one warning for two events, keys from the full topic")
    void overLongTopicIsTruncatedAndSent() throws Exception {
        String topicA = "t/" + "x".repeat(597) + "A";
        String topicB = "t/" + "x".repeat(597) + "B"; // same first 500 characters
        List<AforoMqttBilling.DropReason> reasons = new CopyOnWriteArrayList<>();
        try (AforoMqttBilling b = builder().flushCount(2).onDrop((e, r) -> reasons.add(r)).build()) {
            b.recordPublish("cust_001", "sensor-1", topicA, 1, false, 10L);
            b.recordSubscribe("cust_001", "sensor-1", topicB, 1);
            assertThat(b.droppedCount()).isZero();
            waitFor(() -> received.size() == 2, 3000);
        }
        assertThat(reasons).isEmpty();
        assertThat(received.get(0).get("mqttTopic").asText()).isEqualTo(topicA.substring(0, 500));
        assertThat(received.get(1).get("mqttTopic").asText()).isEqualTo(topicB.substring(0, 500));
        assertThat(truncationWarnings()).hasSize(1);
        assertThat(truncationWarnings().get(0)).contains("mqttTopic").contains("500");
        String naturalA = "mqtt:tenant-001:sensor-1:PUBLISH:" + topicA;
        assertThat(naturalPart(received.get(0).get("idempotencyKey").asText()))
                .isEqualTo(AforoMqttBilling.fitKeyPart(naturalA, ROOM))
                .isEqualTo(AforoMqttBilling.fitKeyPart(naturalA, ROOM))
                .isNotEqualTo(AforoMqttBilling.fitKeyPart("mqtt:tenant-001:sensor-1:PUBLISH:" + topicB, ROOM));
    }

    @Test
    @DisplayName("over-long client id: cut to 128 without splitting a surrogate pair; CONNECT topic keeps its suffix")
    void overLongClientIdIsTruncatedAndSent() throws Exception {
        String clientId = "c".repeat(127) + "\uD83D\uDE00" + "z".repeat(50); // pair straddles index 127/128
        try (AforoMqttBilling b = builder().flushCount(3).build()) {
            b.recordPublish("cust_001", clientId, "sensors/a", 1, false, 10L);
            b.recordPublish("cust_001", "d".repeat(200), "sensors/a", 1, false, 10L);
            b.recordConnect("cust_001", "d".repeat(600));
            assertThat(b.droppedCount()).isZero();
            waitFor(() -> received.size() == 3, 3000);
        }
        assertThat(received.get(0).get("mqttClientId").asText()).isEqualTo("c".repeat(127));
        assertThat(received.get(1).get("mqttClientId").asText()).isEqualTo("d".repeat(128));
        assertThat(received.get(2).get("mqttTopic").asText())
                .isEqualTo("$SYS/clients/" + "d".repeat(128) + "/connected");
        assertThat(truncationWarnings()).hasSize(1);
        assertThat(truncationWarnings().get(0)).contains("mqttClientId").contains("128");
        assertThat(naturalPart(received.get(0).get("idempotencyKey").asText()))
                .isEqualTo(AforoMqttBilling.fitKeyPart("mqtt:tenant-001:" + clientId + ":PUBLISH:sensors/a", ROOM));
    }

    @Test
    @DisplayName("a customerId over 64 is still dropped as INVALID, even next to an over-long topic")
    void overLongCustomerIdStillDropped() throws Exception {
        List<AforoMqttBilling.DropReason> reasons = new CopyOnWriteArrayList<>();
        try (AforoMqttBilling b = builder().flushCount(1).onDrop((e, r) -> reasons.add(r)).build()) {
            b.recordPublish("c".repeat(65), "sensor-1", "t".repeat(600), 1, false, 10L);
            assertThat(b.droppedCount()).isEqualTo(1);
            Thread.sleep(100);
        }
        assertThat(received).isEmpty();
        assertThat(reasons).containsExactly(AforoMqttBilling.DropReason.INVALID);
    }

    private final ObjectMapper mapper = new ObjectMapper();
    private final List<JsonNode> received = new CopyOnWriteArrayList<>();
    private final List<String> warnings = new CopyOnWriteArrayList<>();
    private final Logger sdkLog = Logger.getLogger(AforoMqttBilling.class.getName());
    private final Handler capture = new Handler() {
        @Override public void publish(LogRecord r) {
            if (r.getLevel() == Level.WARNING) warnings.add(r.getMessage());
        }
        @Override public void flush() { }
        @Override public void close() { }
    };
    private HttpServer server;
    private int port;

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        port = server.getAddress().getPort();
        server.createContext("/", exchange -> {
            JsonNode body = mapper.readTree(exchange.getRequestBody().readAllBytes());
            body.get("events").forEach(received::add);
            exchange.sendResponseHeaders(202, -1);
            exchange.close();
        });
        server.start();
        sdkLog.addHandler(capture);
    }

    @AfterEach
    void stopServer() {
        sdkLog.removeHandler(capture);
        server.stop(0);
    }

    private List<String> truncationWarnings() {
        return warnings.stream().filter(w -> w.contains("truncated to")).toList();
    }

    /** The key without its {@code :<epochMillis>:<8 hex>} suffix. */
    private static String naturalPart(String key) {
        int last = key.lastIndexOf(':');
        return key.substring(0, key.lastIndexOf(':', last - 1));
    }

    /** Room left for the natural part: 255 minus {@code :<13-digit millis>:<8 hex>}. */
    private static final int ROOM = 255 - 1 - 13 - 1 - 8;

    @Test
    @DisplayName("fitKeyPart: short input unchanged; long input is head + SHA-256 of the whole value")
    void fitKeyPartIsDeterministicAndCollisionFree() {
        assertThat(AforoMqttBilling.fitKeyPart("abc:def", ROOM)).isEqualTo("abc:def");
        String exact = "k".repeat(ROOM);
        assertThat(AforoMqttBilling.fitKeyPart(exact, ROOM)).isEqualTo(exact);

        String a = "p".repeat(400) + "A";
        String b = "p".repeat(400) + "B";
        String fa = AforoMqttBilling.fitKeyPart(a, ROOM);
        assertThat(fa).hasSize(ROOM).isEqualTo(AforoMqttBilling.fitKeyPart(a, ROOM))
                .endsWith(":" + AforoMqttBilling.sha256Hex(a));
        assertThat(AforoMqttBilling.fitKeyPart(b, ROOM)).isNotEqualTo(fa);
    }

    @Test
    @DisplayName("truncateLabel counts UTF-16 units and never splits a surrogate pair")
    void truncateLabelKeepsPairsWhole() {
        assertThat(AforoMqttBilling.truncateLabel(null, 5)).isNull();
        assertThat(AforoMqttBilling.truncateLabel("abcdef", 5)).isEqualTo("abcde");
        assertThat(AforoMqttBilling.truncateLabel("abcd\uD83D\uDE00", 5)).isEqualTo("abcd");
        assertThat(AforoMqttBilling.truncateLabel("abc\uD83D\uDE00x", 5)).isEqualTo("abc\uD83D\uDE00");
    }

    private static void waitFor(java.util.function.BooleanSupplier cond, long timeoutMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (!cond.getAsBoolean() && System.currentTimeMillis() < deadline) Thread.sleep(20);
    }
}
