package com.aforo.mqtt;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Ingest-contract guard (A+ delivery-guarantee prompt 7).
 *
 * <p>Validates the OBSERVED wire request (endpoint path + body shape) against
 * the shared, checked-in contract fixture at contract/ingest-contract.json —
 * derived from the REAL usage-ingestor controllers/DTOs, never from this
 * SDK's own constants. The 2026-07-05 D1 incident shipped this very SDK
 * posting a batch body to a single-event endpoint; its own green suite hid
 * 100% event loss because it asserted the SDK's own (wrong) constant.</p>
 */
class IngestContractTest {

    private static final ObjectMapper OM = new ObjectMapper();
    private static final String MODULE_KEY = "java-mqtt";
    /** Surefire runs with the module dir as CWD — fixture lives at the repo root. */
    private static final File FIXTURE_FILE = new File("../contract/ingest-contract.json");

    private HttpServer captureServer;
    private int capturePort;
    private final List<String> capturedPaths = new ArrayList<>();
    private final List<Map<String, Object>> capturedBodies = new ArrayList<>();

    @BeforeEach
    void setUp() throws IOException {
        captureServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        captureServer.createContext("/", (HttpExchange ex) -> {
            byte[] body = ex.getRequestBody().readAllBytes();
            synchronized (capturedPaths) {
                capturedPaths.add(ex.getRequestURI().getPath());
                try {
                    capturedBodies.add(body.length > 0
                            ? OM.readValue(body, new TypeReference<Map<String, Object>>() {})
                            : Map.of());
                } catch (Exception parseFailure) {
                    capturedBodies.add(Map.of());
                }
            }
            ex.sendResponseHeaders(202, -1);
            ex.close();
        });
        captureServer.start();
        capturePort = captureServer.getAddress().getPort();
    }

    @AfterEach
    void tearDown() {
        if (captureServer != null) captureServer.stop(0);
    }

    @Test
    void postsToContractedEndpointWithContractedBodyShape() throws Exception {
        Map<String, Object> fixture = OM.readValue(FIXTURE_FILE, new TypeReference<>() {});
        Map<String, Object> sdks = cast(fixture.get("sdks"));
        Map<String, Object> sdkEntry = cast(sdks.get(MODULE_KEY));
        assertThat(sdkEntry).as("module must be registered in the fixture").isNotNull();
        String endpoint = (String) sdkEntry.get("endpoint");
        Map<String, Object> endpoints = cast(fixture.get("endpoints"));
        Map<String, Object> spec = cast(endpoints.get(endpoint));
        assertThat(spec).isNotNull();

        AforoMqttBilling billing = AforoMqttBilling.newBuilder()
                .tenantId("tenant-001")
                .productId("prod-mqtt-001")
                .apiKey("sk_mqtt_abc")
                .ingestorUrl("http://127.0.0.1:" + capturePort)
                .flushCount(1)
                .flushIntervalMs(60_000L)
                .build();
        try {
            billing.recordPublish("cust_contract", "client-1", "sensors/temp", 1, false, 4L);
        } finally {
            billing.close(); // flushes anything the async flush didn't take
        }
        awaitCapture();

        synchronized (capturedPaths) {
            assertThat(capturedPaths).as("no wire request observed").isNotEmpty();
            assertThat(capturedPaths.get(0)).isEqualTo(endpoint);
            assertBodyMatchesContract(spec, capturedBodies.get(0));
        }
    }

    @Test
    void executionStatusIsContractedOptionalFieldSentOnlyWhenSet() throws Exception {
        Map<String, Object> fixture = OM.readValue(FIXTURE_FILE, new TypeReference<>() {});
        Map<String, Object> sdks = cast(fixture.get("sdks"));
        String endpoint = (String) ((Map<String, Object>) cast(sdks.get(MODULE_KEY))).get("endpoint");
        Map<String, Object> spec = cast(((Map<String, Object>) cast(fixture.get("endpoints"))).get(endpoint));
        Map<String, Object> optional = cast(spec.get("eventOptionalFields"));
        Map<String, Object> statusSpec = cast(optional.get("executionStatus"));
        assertThat(statusSpec).as("executionStatus must be a contracted optional field").isNotNull();
        List<String> allowed = cast(statusSpec.get("values"));
        assertThat(AforoMqttBilling.ALLOWED_EXECUTION_STATUSES)
                .as("SDK executionStatus allowlist must match the contract").containsExactlyInAnyOrderElementsOf(allowed);
        // No derived values in this SDK (explicit only) — nothing else to check against the list.

        AforoMqttBilling billing = AforoMqttBilling.newBuilder()
                .tenantId("tenant-001")
                .productId("prod-mqtt-001")
                .apiKey("sk_mqtt_abc")
                .ingestorUrl("http://127.0.0.1:" + capturePort)
                .flushCount(2)
                .flushIntervalMs(60_000L)
                .build();
        try {
            billing.recordPublish("cust_contract", "client-1", "sensors/temp", 1, false, 4L, "timeout");
            billing.recordPublish("cust_contract", "client-1", "sensors/temp", 1, false, 4L);
        } finally {
            billing.close();
        }
        awaitCapture();

        synchronized (capturedPaths) {
            assertThat(capturedBodies).as("no wire request observed").isNotEmpty();
            Map<String, Object> body = capturedBodies.get(0);
            assertBodyMatchesContract(spec, body);
            List<Map<String, Object>> events = cast(body.get((String) spec.get("batchKey")));
            assertThat(events).hasSize(2);
            assertThat(events.get(0)).containsEntry("executionStatus", "TIMEOUT");
            assertThat(allowed).contains((String) events.get(0).get("executionStatus"));
            assertThat(((String) events.get(0).get("executionStatus")).length())
                    .isLessThanOrEqualTo(((Number) statusSpec.get("maxLength")).intValue());
            assertThat(events.get(1)).doesNotContainKey("executionStatus");
        }
    }

    private void awaitCapture() throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5_000;
        while (System.currentTimeMillis() < deadline) {
            synchronized (capturedPaths) {
                if (!capturedPaths.isEmpty()) return;
            }
            Thread.sleep(25);
        }
    }

    /** Same assertion shape in every SDK suite (all languages). */
    static void assertBodyMatchesContract(Map<String, Object> spec, Map<String, Object> body) {
        String cardinality = (String) spec.get("cardinality");
        if ("batch-wrapped".equals(cardinality)) {
            // (A bare-array body would have failed the Map parse above — the
            // /v1/ingest/async-batch shape is not this endpoint's contract.)
            Object eventsObj = body.get((String) spec.get("batchKey"));
            assertThat(eventsObj)
                    .as("batch body must carry '%s' array", spec.get("batchKey"))
                    .isInstanceOf(List.class);
            List<Map<String, Object>> events = cast(eventsObj);
            assertThat(events).isNotEmpty();
            assertThat(events.size()).isLessThanOrEqualTo(((Number) spec.get("maxEvents")).intValue());
            List<String> requiredFields = cast(spec.get("eventRequiredFields"));
            for (Map<String, Object> ev : events) {
                for (String field : requiredFields) assertRequired(ev, field);
            }
        } else if ("single".equals(cardinality)) {
            List<String> forbidden = spec.get("forbiddenTopLevelKeys") != null
                    ? cast(spec.get("forbiddenTopLevelKeys")) : List.of();
            for (String key : forbidden) {
                assertThat(body).as("single-event body must not carry '%s'", key).doesNotContainKey(key);
            }
            List<String> requiredFields = cast(spec.get("requiredFields"));
            for (String field : requiredFields) assertRequired(body, field);
        } else {
            throw new AssertionError("Unhandled cardinality in fixture: " + cardinality);
        }
    }

    static void assertRequired(Map<String, Object> obj, String field) {
        assertThat(obj).as("required field '%s' missing from wire body", field).containsKey(field);
        Object v = obj.get(field);
        assertThat(v).as("required field '%s' is null", field).isNotNull();
        if (v instanceof String s) {
            assertThat(s.trim()).as("required field '%s' is blank", field).isNotEmpty();
        }
    }

    @SuppressWarnings("unchecked")
    static <T> T cast(Object o) {
        return (T) o;
    }
}
