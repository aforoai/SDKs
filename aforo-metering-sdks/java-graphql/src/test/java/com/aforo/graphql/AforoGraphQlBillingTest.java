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

    // ── executionStatus ────────────────────────────────────────────────

    private static graphql.ExecutionResult result(Object data, boolean withError) {
        graphql.ExecutionResultImpl.Builder rb = graphql.ExecutionResultImpl.newExecutionResult().data(data);
        if (withError) rb.addError(graphql.GraphqlErrorBuilder.newError().message("boom").build());
        return rb.build();
    }

    /** Result with no {@code data} key at all (request failed before execution). */
    private static graphql.ExecutionResult resultWithoutData(boolean withError) {
        graphql.ExecutionResultImpl.Builder rb = graphql.ExecutionResultImpl.newExecutionResult();
        if (withError) rb.addError(graphql.GraphqlErrorBuilder.newError().message("bad field").build());
        return rb.build();
    }

    @Test
    @DisplayName("outcomeFromGraphQlResult: errors + data key absent → VALIDATION_FAILED")
    void outcomeFromResultWithAbsentData() {
        graphql.ExecutionResult r = resultWithoutData(true);
        assertThat(r.isDataPresent()).isFalse();
        assertThat(AforoGraphQlBilling.outcomeFromGraphQlResult(r)).isEqualTo("VALIDATION_FAILED");
        assertThat(result(null, true).isDataPresent()).isTrue();
        assertThat(AforoGraphQlBilling.outcomeFromGraphQlResult(result(null, true))).isEqualTo("ERROR");
        // No errors → SUCCESS regardless of whether data is present
        assertThat(AforoGraphQlBilling.outcomeFromGraphQlResult(resultWithoutData(false))).isEqualTo("SUCCESS");
    }

    @Test
    @DisplayName("outcomeFromGraphQlResult: no errors→SUCCESS, errors+data→PARTIAL, errors+null data→ERROR")
    void outcomeFromResult() {
        assertThat(AforoGraphQlBilling.outcomeFromGraphQlResult(result(java.util.Map.of("a", 1), false))).isEqualTo("SUCCESS");
        assertThat(AforoGraphQlBilling.outcomeFromGraphQlResult(result(null, false))).isEqualTo("SUCCESS");
        assertThat(AforoGraphQlBilling.outcomeFromGraphQlResult(result(java.util.Map.of("a", 1), true))).isEqualTo("PARTIAL");
        assertThat(AforoGraphQlBilling.outcomeFromGraphQlResult(result(null, true))).isEqualTo("ERROR");
        assertThat(AforoGraphQlBilling.outcomeFromGraphQlResult(null)).isNull();
    }

    @Test
    @DisplayName("outcomeFromHttpStatus maps per the gateway table")
    void outcomeFromHttp() {
        assertThat(AforoGraphQlBilling.outcomeFromHttpStatus(200)).isEqualTo("SUCCESS");
        assertThat(AforoGraphQlBilling.outcomeFromHttpStatus(304)).isEqualTo("SUCCESS");
        assertThat(AforoGraphQlBilling.outcomeFromHttpStatus(408)).isEqualTo("TIMEOUT");
        assertThat(AforoGraphQlBilling.outcomeFromHttpStatus(504)).isEqualTo("TIMEOUT");
        assertThat(AforoGraphQlBilling.outcomeFromHttpStatus(499)).isEqualTo("CANCELLED");
        assertThat(AforoGraphQlBilling.outcomeFromHttpStatus(400)).isEqualTo("VALIDATION_FAILED");
        assertThat(AforoGraphQlBilling.outcomeFromHttpStatus(422)).isEqualTo("VALIDATION_FAILED");
        assertThat(AforoGraphQlBilling.outcomeFromHttpStatus(401)).isEqualTo("BLOCKED");
        assertThat(AforoGraphQlBilling.outcomeFromHttpStatus(403)).isEqualTo("BLOCKED");
        assertThat(AforoGraphQlBilling.outcomeFromHttpStatus(429)).isEqualTo("BLOCKED");
        assertThat(AforoGraphQlBilling.outcomeFromHttpStatus(404)).isEqualTo("ERROR");
        assertThat(AforoGraphQlBilling.outcomeFromHttpStatus(500)).isEqualTo("ERROR");
        assertThat(AforoGraphQlBilling.outcomeFromHttpStatus(100)).isNull();
        assertThat(AforoGraphQlBilling.outcomeFromHttpStatus(0)).isNull();
        assertThat(AforoGraphQlBilling.outcomeFromHttpStatus(600)).isNull();
    }

    @Test
    @DisplayName("record(): explicit executionStatus is normalized and sent; blank/unset/5-arg omit it")
    void recordExecutionStatusOnWire() throws Exception {
        try (AforoGraphQlBilling b = baseBuilder().flushCount(4).build()) {
            b.record("cust_001", "{ a }", null, 5L, true, "  partial ");
            b.record("cust_001", "{ a }", null, 5L, false, "   ");
            b.record("cust_001", "{ a }", null, 5L, false, null);
            b.record("cust_001", "{ a }", null, 5L, false);
            waitFor(() -> requestBodies.size() == 1, 2000);
        }
        JsonNode events = requestBodies.get(0).get("events");
        assertThat(events.size()).isEqualTo(4);
        assertThat(events.get(0).get("executionStatus").asText()).isEqualTo("PARTIAL");
        for (int i = 1; i < 4; i++) assertThat(events.get(i).has("executionStatus")).isFalse();
    }

    @Test
    @DisplayName("record(): unknown explicit executionStatus is omitted; the rest of the event (and batch) is sent")
    void recordOmitsUnknownExecutionStatus() throws Exception {
        try (AforoGraphQlBilling b = baseBuilder().flushCount(3).build()) {
            b.record("cust_001", "query Q { a }", null, 5L, true, "kinda_ok");
            b.record("cust_001", "{ a }", null, 5L, true, "PARTIAL_BUT_WAY_TOO_LONG_FOR_IT");
            b.record("cust_001", "{ a }", null, 5L, false, " success ");
            waitFor(() -> requestBodies.size() == 1, 2000);
        }
        JsonNode events = requestBodies.get(0).get("events");
        assertThat(events.size()).isEqualTo(3);
        assertThat(events.get(0).has("executionStatus")).isFalse();
        assertThat(events.get(0).get("gqlOperationName").asText()).isEqualTo("Q");
        assertThat(events.get(0).get("gqlHasErrors").asBoolean()).isTrue();
        assertThat(events.get(1).has("executionStatus")).isFalse();
        assertThat(events.get(2).get("executionStatus").asText()).isEqualTo("SUCCESS");
    }

    @Test
    @DisplayName("outcomeFromGraphQlResult: an empty errors list counts as no errors")
    void outcomeFromResultEmptyErrorsList() {
        graphql.ExecutionResult r = graphql.ExecutionResultImpl.newExecutionResult()
                .data(null).errors(java.util.List.of()).build();
        assertThat(AforoGraphQlBilling.outcomeFromGraphQlResult(r)).isEqualTo("SUCCESS");
        graphql.ExecutionResult noData = graphql.ExecutionResultImpl.newExecutionResult()
                .errors(java.util.List.of()).build();
        assertThat(AforoGraphQlBilling.outcomeFromGraphQlResult(noData)).isEqualTo("SUCCESS");
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
