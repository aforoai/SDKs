package com.aforo.graphql;

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
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Tests for AforoGraphQlBilling. Unique bits:
 *   - AST-accurate complexity scoring via graphql-java NodeVisitorStub
 *   - Operation type detection (QUERY / MUTATION / SUBSCRIPTION)
 *   - Schema version in metadata (distinct from gRPC test's service_name)
 */
@DisplayName("AforoGraphQlBilling")
class AforoGraphQlBillingTest {

    private HttpServer server;
    private int port;
    private final List<JsonNode> requestBodies = new CopyOnWriteArrayList<>();
    private final AtomicInteger responseStatus = new AtomicInteger(204);
    private final ObjectMapper mapper = new ObjectMapper();

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress(0), 0);
        port = server.getAddress().getPort();
        server.createContext("/", exchange -> {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            exchange.getRequestBody().transferTo(buf);
            requestBodies.add(buf.size() == 0 ? mapper.nullNode() : mapper.readTree(buf.toByteArray()));
            exchange.sendResponseHeaders(responseStatus.get(), -1);
            exchange.close();
        });
        server.start();
    }

    @AfterEach
    void stopServer() { server.stop(0); }

    private AforoGraphQlBilling.Builder baseBuilder() {
        return AforoGraphQlBilling.newBuilder()
                .tenantId("tenant-001")
                .productId("prod-gql-001")
                .apiKey("sk_gql_abc")
                .ingestorUrl("http://localhost:" + port + "/")
                .schemaVersion("v2.1")
                .flushCount(1)
                .flushIntervalMs(60_000);
    }

    // ── Operation detection + complexity ───────────────────────────────

    @Test
    @DisplayName("QUERY: correct operation type + complexity > 0")
    void queryHappyPath() throws Exception {
        try (AforoGraphQlBilling b = baseBuilder().build()) {
            b.record("cust_001", "query GetUser { user { id name } }", "GetUser", 14L, false);
            waitFor(() -> requestBodies.size() == 1, 2000);
        }
        JsonNode ev = requestBodies.get(0).get("events").get(0);
        assertThat(ev.get("productType").asText()).isEqualTo("GRAPHQL_API");
        assertThat(ev.get("gqlOperationType").asText()).isEqualTo("QUERY");
        assertThat(ev.get("gqlOperationName").asText()).isEqualTo("GetUser");
        assertThat(ev.get("gqlComplexity").asInt()).isGreaterThan(0);
        assertThat(ev.get("gqlFieldCount").asInt()).isGreaterThan(0);
        assertThat(ev.get("gqlHasErrors").asBoolean()).isFalse();
        assertThat(ev.get("executionDurationMs").asLong()).isEqualTo(14L);
        assertThat(ev.get("customerId").asText()).isEqualTo("cust_001");
        assertThat(ev.get("metadata").get("schemaVersion").asText()).isEqualTo("v2.1");
        assertThat(ev.get("metricName").asText()).isEqualTo("graphql_api.operations");
    }

    @Test
    @DisplayName("MUTATION operation type is detected")
    void mutationDetected() throws Exception {
        try (AforoGraphQlBilling b = baseBuilder().build()) {
            b.record("cust_001", "mutation Create { createUser { id } }", "Create", 10L, false);
            waitFor(() -> requestBodies.size() == 1, 2000);
        }
        assertThat(requestBodies.get(0).get("events").get(0).get("gqlOperationType").asText())
                .isEqualTo("MUTATION");
    }

    @Test
    @DisplayName("SUBSCRIPTION operation type is detected")
    void subscriptionDetected() throws Exception {
        try (AforoGraphQlBilling b = baseBuilder().build()) {
            b.record("cust_001", "subscription OnNew { newUser { id } }", "OnNew", 10L, false);
            waitFor(() -> requestBodies.size() == 1, 2000);
        }
        assertThat(requestBodies.get(0).get("events").get(0).get("gqlOperationType").asText())
                .isEqualTo("SUBSCRIPTION");
    }

    @Test
    @DisplayName("Anonymous operation (no explicit name) → gqlOperationName=\"anonymous\"")
    void anonymousOperation() throws Exception {
        try (AforoGraphQlBilling b = baseBuilder().build()) {
            b.record("cust_001", "{ a b c }", null, 5L, false);
            waitFor(() -> requestBodies.size() == 1, 2000);
        }
        assertThat(requestBodies.get(0).get("events").get(0).get("gqlOperationName").asText())
                .isEqualTo("anonymous");
    }

    // ── Silent-drop paths ──────────────────────────────────────────────

    @Test
    @DisplayName("Invalid query → record drops silently (no fetch, no throw)")
    void invalidQueryDropped() throws Exception {
        try (AforoGraphQlBilling b = baseBuilder().build()) {
            b.record("cust_001", "{ this is not valid graphql", null, 5L, false);
            // No waitFor — give it 100ms to prove nothing gets sent
            Thread.sleep(100);
        }
        assertThat(requestBodies).isEmpty();
    }

    @Test
    @DisplayName("Blank/null customerId → record drops silently")
    void blankCustomerDropped() throws Exception {
        try (AforoGraphQlBilling b = baseBuilder().build()) {
            b.record("", "{ a }", null, 5L, false);
            b.record(null, "{ a }", null, 5L, false);
        }
        assertThat(requestBodies).isEmpty();
    }

    @Test
    @DisplayName("hasErrors=true forwarded onto gqlHasErrors")
    void hasErrorsForwarded() throws Exception {
        try (AforoGraphQlBilling b = baseBuilder().build()) {
            b.record("cust_001", "{ a }", null, 5L, true);
            waitFor(() -> requestBodies.size() == 1, 2000);
        }
        assertThat(requestBodies.get(0).get("events").get(0).get("gqlHasErrors").asBoolean())
                .isTrue();
    }

    @Test
    @DisplayName("idempotencyKey format: gql:{tenant}:{product}:{opName}:{millis}:{8-hex}")
    void idempotencyKeyFormat() throws Exception {
        try (AforoGraphQlBilling b = baseBuilder().build()) {
            b.record("cust_001", "query MyOp { a }", "MyOp", 5L, false);
            waitFor(() -> requestBodies.size() == 1, 2000);
        }
        String key = requestBodies.get(0).get("events").get(0).get("idempotencyKey").asText();
        assertThat(key).matches(Pattern.compile("^gql:tenant-001:prod-gql-001:MyOp:\\d+:[0-9a-f]{8}$"));
    }

    @Test
    @DisplayName("close() flushes pending events below flushCount")
    void closeFlushesPending() throws Exception {
        try (AforoGraphQlBilling b = baseBuilder().flushCount(100).build()) {
            for (int i = 0; i < 3; i++) {
                b.record("cust_001", "{ a" + i + " }", null, 5L, false);
            }
            Thread.sleep(50);
            assertThat(requestBodies).isEmpty();
        }
        waitFor(() -> requestBodies.size() == 1, 2000);
        assertThat(requestBodies.get(0).get("events").size()).isEqualTo(3);
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
