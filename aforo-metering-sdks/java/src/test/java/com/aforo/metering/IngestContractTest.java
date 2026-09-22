package com.aforo.metering;

import com.aforo.metering.spring.AforoMeteringProperties;
import com.aforo.metering.spring.AforoServletFilter;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Proxy;
import java.net.InetSocketAddress;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("Ingest contract — URL, productType, required fields")
class IngestContractTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final List<JsonNode> bodies = new CopyOnWriteArrayList<>();
    private final List<String> paths = new CopyOnWriteArrayList<>();
    private final List<String> authHeaders = new CopyOnWriteArrayList<>();
    private final List<String> apiKeyHeaders = new CopyOnWriteArrayList<>();
    private HttpServer server;
    private int port;

    @BeforeEach
    void start() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", ex -> {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            ex.getRequestBody().transferTo(buf);
            paths.add(ex.getRequestURI().getPath());
            authHeaders.add(String.valueOf(ex.getRequestHeaders().getFirst("Authorization")));
            apiKeyHeaders.add(ex.getRequestHeaders().getFirst("X-API-Key"));
            bodies.add(mapper.readTree(buf.toByteArray()));
            byte[] resp = "{\"accepted\":1,\"duplicates\":0,\"failed\":0,\"errors\":[]}".getBytes();
            ex.sendResponseHeaders(202, resp.length);
            ex.getResponseBody().write(resp);
            ex.close();
        });
        server.start();
        port = server.getAddress().getPort();
    }

    @AfterEach
    void stop() { server.stop(0); }

    private AforoOptions options() {
        return new AforoOptions("sk_test_abc")
                .baseUrl("http://127.0.0.1:" + port)
                .flushCount(100)
                .flushIntervalMs(60_000)
                .maxRetries(0);
    }

    private JsonNode onlyEvent() {
        assertThat(bodies).hasSize(1);
        JsonNode events = bodies.get(0).get("events");
        assertThat(events.size()).isEqualTo(1);
        return events.get(0);
    }

    @Test
    void defaultBaseUrlIsProductionGateway() {
        assertThat(new AforoOptions("k").getBaseUrl()).isEqualTo("https://api.aforo.ai");
        assertThat(new AforoMeteringProperties().getBaseUrl()).isEqualTo("https://api.aforo.ai");
        assertThat(new AforoMeteringProperties().getProductType()).isEqualTo("API");
    }

    @Test
    void defaultProductTypeIsApi() {
        assertThat(new AforoOptions("k").getProductType()).isEqualTo("API");
    }

    @Test
    void postsBatchWithRequiredCamelCaseFieldsAndDefaultProductType() {
        try (var client = new AforoClient(options())) {
            client.track(TrackEvent.builder("cust_1", "api_calls").quantity(2).build());
            FlushResult r = client.flush();
            assertThat(r.sent()).isEqualTo(1);
        }
        assertThat(paths.get(0)).isEqualTo("/v1/ingest/batch");
        assertThat(apiKeyHeaders.get(0)).isEqualTo("sk_test_abc");
        assertThat(authHeaders.get(0)).isEqualTo("null");
        JsonNode ev = onlyEvent();
        assertThat(ev.get("customerId").asText()).isEqualTo("cust_1");
        assertThat(ev.get("metricName").asText()).isEqualTo("api_calls");
        assertThat(ev.get("quantity").asDouble()).isEqualTo(2.0);
        assertThat(ev.get("idempotencyKey").asText()).isNotBlank();
        assertThat(ev.get("productType").asText()).isEqualTo("API");
        // ISO-8601 instant
        Instant parsed = Instant.parse(ev.get("occurredAt").asText());
        assertThat(parsed).isBeforeOrEqualTo(Instant.now());
    }

    @Test
    void clientProductTypeAndPerEventOverride() {
        try (var client = new AforoClient(options().productType("agentic_api"))) {
            client.track(TrackEvent.builder("cust_1", "calls").build());
            client.track(TrackEvent.builder("cust_1", "tokens").productType("AI_AGENT").build());
            client.flush();
        }
        JsonNode events = bodies.get(0).get("events");
        assertThat(events.get(0).get("productType").asText()).isEqualTo("AGENTIC_API");
        assertThat(events.get(1).get("productType").asText()).isEqualTo("AI_AGENT");
    }

    @Test
    void nonPositiveQuantityAndBlankCustomerAreDropped() {
        try (var client = new AforoClient(options())) {
            client.track(TrackEvent.builder("cust_1", "api_calls").quantity(0).build());
            client.track(TrackEvent.builder("cust_1", "api_calls").quantity(-1).build());
            client.track(TrackEvent.builder("", "api_calls").build());
            client.track(TrackEvent.builder(null, "api_calls").build());
            client.track(TrackEvent.builder("cust_1", "api_calls").quantity(Double.NaN).build());
            assertThat(client.bufferedCount()).isZero();
        }
        assertThat(bodies).isEmpty();
    }

    @Test
    void flushCountIsClampedToServerBatchLimit() {
        try (var client = new AforoClient(options().flushCount(5_000).maxQueueSize(5_000))) {
            for (int i = 0; i < 1_500; i++) {
                client.track(TrackEvent.builder("cust_" + i, "api_calls").build());
            }
            client.flush();
        }
        assertThat(bodies).isNotEmpty();
        int total = 0;
        for (JsonNode b : bodies) {
            assertThat(b.get("events").size()).isLessThanOrEqualTo(1000);
            total += b.get("events").size();
        }
        assertThat(total).isEqualTo(1_500);
    }

    // ── Servlet filter ────────────────────────────────────────────────

    private static HttpServletRequest request(String customerHeader) {
        return (HttpServletRequest) Proxy.newProxyInstance(
                IngestContractTest.class.getClassLoader(), new Class<?>[]{HttpServletRequest.class},
                (proxy, m, args) -> switch (m.getName()) {
                    case "getRequestURI" -> "/v1/users/42";
                    case "getMethod" -> "GET";
                    case "getHeader" -> "X-Customer-Id".equals(args[0]) ? customerHeader : null;
                    default -> null;
                });
    }

    private static HttpServletResponse response() {
        return (HttpServletResponse) Proxy.newProxyInstance(
                IngestContractTest.class.getClassLoader(), new Class<?>[]{HttpServletResponse.class},
                (proxy, m, args) -> "getStatus".equals(m.getName()) ? 200 : null);
    }

    @Test
    void servletFilterSendsTopLevelHttpFields() throws Exception {
        FilterChain chain = (req, res) -> {};
        try (var client = new AforoClient(options())) {
            new AforoServletFilter(client).doFilter(request("cust_9"), response(), chain);
            client.flush();
        }
        JsonNode ev = onlyEvent();
        assertThat(ev.get("customerId").asText()).isEqualTo("cust_9");
        assertThat(ev.get("productType").asText()).isEqualTo("API");
        assertThat(ev.get("endpointPath").asText()).isEqualTo("/v1/users/:id");
        assertThat(ev.get("httpMethod").asText()).isEqualTo("GET");
        assertThat(ev.get("statusCode").asInt()).isEqualTo(200);
        assertThat(ev.has("responseTimeMs")).isTrue();
        assertThat(ev.get("quantity").asDouble()).isEqualTo(1.0);
    }

    @Test
    void servletFilterProductTypeOptionOverridesClientDefault() throws Exception {
        FilterChain chain = (req, res) -> {};
        try (var client = new AforoClient(options().productType("agentic_api"))) {
            new AforoServletFilter(client).doFilter(request("cust_9"), response(), chain);
            new AforoServletFilter(client).productType(" ai_agent ").doFilter(request("cust_9"), response(), chain);
            client.flush();
        }
        JsonNode events = bodies.get(0).get("events");
        assertThat(events.get(0).get("productType").asText()).isEqualTo("AGENTIC_API");
        assertThat(events.get(1).get("productType").asText()).isEqualTo("AI_AGENT");
    }

    @Test
    void servletFilterEndpointPathIsCappedAt512() throws Exception {
        String longPath = "/" + "a".repeat(600);
        HttpServletRequest req = (HttpServletRequest) Proxy.newProxyInstance(
                IngestContractTest.class.getClassLoader(), new Class<?>[]{HttpServletRequest.class},
                (proxy, m, args) -> switch (m.getName()) {
                    case "getRequestURI" -> longPath;
                    case "getMethod" -> "POST";
                    case "getHeader" -> "X-Customer-Id".equals(args[0]) ? "cust_9" : null;
                    default -> null;
                });
        FilterChain chain = (rq, rs) -> {};
        try (var client = new AforoClient(options())) {
            new AforoServletFilter(client).doFilter(req, response(), chain);
            client.flush();
        }
        assertThat(onlyEvent().get("endpointPath").asText()).hasSize(512);
    }

    @Test
    void blankMetricNameIsDroppedAndInstantOccurredAtIsIso() {
        Instant at = Instant.parse("2026-09-22T10:00:00Z");
        try (var client = new AforoClient(options())) {
            client.track(TrackEvent.builder("cust_1", " ").build());
            client.track(TrackEvent.builder("cust_1", "api_calls").occurredAt(at).build());
            client.flush();
        }
        assertThat(onlyEvent().get("occurredAt").asText()).isEqualTo("2026-09-22T10:00:00Z");
    }

    @Test
    void resolvedEventMapAlwaysHasProductType() {
        Map<String, Object> map = new ResolvedEvent("c", "m", 1, "k", "2026-09-22T10:00:00Z", null).toMap();
        assertThat(map).containsEntry("productType", "API");
    }
}
