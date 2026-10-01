package com.aforo.graphql;

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

@DisplayName("AforoGraphQlBilling — over-long operation name is truncated, not dropped")
class RequestLabelTruncationTest {

    private AforoGraphQlBilling.Builder builder() {
        return AforoGraphQlBilling.newBuilder().tenantId("tenant-001").productId("prod-gql")
                .apiKey("sk_test").ingestorUrl("http://127.0.0.1:" + port).flushIntervalMs(60_000);
    }

    @Test
    @DisplayName("300-char operation name: event sent, label cut to 255, one warning for two events, keys from the full name")
    void overLongOperationNameIsTruncatedAndSent() throws Exception {
        String nameA = "Op" + "x".repeat(260) + "A";
        String nameB = "Op" + "x".repeat(260) + "B"; // same first 255 characters
        List<AforoGraphQlBilling.DropReason> reasons = new CopyOnWriteArrayList<>();
        try (AforoGraphQlBilling b = builder().flushCount(2).onDrop((e, r) -> reasons.add(r)).build()) {
            b.record("cust_001", "query " + nameA + " { user { id } }", nameA, 5L, false);
            b.record("cust_001", "query " + nameB + " { user { id } }", nameB, 5L, false);
            assertThat(b.droppedCount()).isZero();
            waitFor(() -> received.size() == 2, 3000);
        }
        assertThat(reasons).isEmpty();
        assertThat(received).hasSize(2);
        assertThat(received.get(0).get("gqlOperationName").asText()).isEqualTo(nameA.substring(0, 255));
        assertThat(received.get(1).get("gqlOperationName").asText()).isEqualTo(nameB.substring(0, 255));
        assertThat(truncationWarnings()).hasSize(1);
        assertThat(truncationWarnings().get(0)).contains("gqlOperationName").contains("255");

        String keyA = received.get(0).get("idempotencyKey").asText();
        String keyB = received.get(1).get("idempotencyKey").asText();
        assertThat(keyA.length()).isLessThanOrEqualTo(255);
        // Built from the untruncated name: same value on every evaluation, different for the two names.
        assertThat(naturalPart(keyA))
                .isEqualTo(AforoGraphQlBilling.fitKeyPart("gql:tenant-001:prod-gql:" + nameA, ROOM))
                .isEqualTo(AforoGraphQlBilling.fitKeyPart("gql:tenant-001:prod-gql:" + nameA, ROOM));
        assertThat(naturalPart(keyB))
                .isEqualTo(AforoGraphQlBilling.fitKeyPart("gql:tenant-001:prod-gql:" + nameB, ROOM))
                .isNotEqualTo(naturalPart(keyA));
    }

    @Test
    @DisplayName("an operation name within the limit is sent as-is, key keeps its plain form, nothing is logged")
    void nameWithinLimitIsUntouched() throws Exception {
        String name = "N" + "y".repeat(100);
        try (AforoGraphQlBilling b = builder().flushCount(1).build()) {
            b.record("cust_001", "query " + name + " { a }", name, 5L, false);
            waitFor(() -> received.size() == 1, 3000);
        }
        assertThat(received.get(0).get("gqlOperationName").asText()).isEqualTo(name);
        assertThat(naturalPart(received.get(0).get("idempotencyKey").asText()))
                .isEqualTo("gql:tenant-001:prod-gql:" + name);
        assertThat(truncationWarnings()).isEmpty();
    }

    @Test
    @DisplayName("an over-long customerId is still dropped as INVALID, even next to an over-long operation name")
    void overLongCustomerIdStillDropped() throws Exception {
        String name = "Op" + "x".repeat(300);
        List<AforoGraphQlBilling.DropReason> reasons = new CopyOnWriteArrayList<>();
        try (AforoGraphQlBilling b = builder().flushCount(1).onDrop((e, r) -> reasons.add(r)).build()) {
            b.record("c".repeat(65), "query " + name + " { a }", name, 5L, false);
            assertThat(b.droppedCount()).isEqualTo(1);
            Thread.sleep(100);
        }
        assertThat(received).isEmpty();
        assertThat(reasons).containsExactly(AforoGraphQlBilling.DropReason.INVALID);
    }

    private final ObjectMapper mapper = new ObjectMapper();
    private final List<JsonNode> received = new CopyOnWriteArrayList<>();
    private final List<String> warnings = new CopyOnWriteArrayList<>();
    private final Logger sdkLog = Logger.getLogger(AforoGraphQlBilling.class.getName());
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
        assertThat(AforoGraphQlBilling.fitKeyPart("abc:def", ROOM)).isEqualTo("abc:def");
        String exact = "k".repeat(ROOM);
        assertThat(AforoGraphQlBilling.fitKeyPart(exact, ROOM)).isEqualTo(exact);

        String a = "p".repeat(400) + "A";
        String b = "p".repeat(400) + "B";
        String fa = AforoGraphQlBilling.fitKeyPart(a, ROOM);
        assertThat(fa).hasSize(ROOM).isEqualTo(AforoGraphQlBilling.fitKeyPart(a, ROOM))
                .endsWith(":" + AforoGraphQlBilling.sha256Hex(a));
        assertThat(AforoGraphQlBilling.fitKeyPart(b, ROOM)).isNotEqualTo(fa);
    }

    @Test
    @DisplayName("truncateLabel counts UTF-16 units and never splits a surrogate pair")
    void truncateLabelKeepsPairsWhole() {
        assertThat(AforoGraphQlBilling.truncateLabel(null, 5)).isNull();
        assertThat(AforoGraphQlBilling.truncateLabel("abcdef", 5)).isEqualTo("abcde");
        assertThat(AforoGraphQlBilling.truncateLabel("abcd\uD83D\uDE00", 5)).isEqualTo("abcd");
        assertThat(AforoGraphQlBilling.truncateLabel("abc\uD83D\uDE00x", 5)).isEqualTo("abc\uD83D\uDE00");
    }

    private static void waitFor(java.util.function.BooleanSupplier cond, long timeoutMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (!cond.getAsBoolean() && System.currentTimeMillis() < deadline) Thread.sleep(20);
    }
}
