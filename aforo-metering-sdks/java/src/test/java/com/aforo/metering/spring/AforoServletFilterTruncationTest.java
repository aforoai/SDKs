package com.aforo.metering.spring;

import com.aforo.metering.AforoClient;
import com.aforo.metering.AforoOptions;
import com.aforo.metering.DropReason;
import com.aforo.metering.RequestLabels;
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

import java.lang.reflect.Proxy;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("AforoServletFilter — over-long request labels are truncated, not dropped")
class AforoServletFilterTruncationTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final List<JsonNode> received = new CopyOnWriteArrayList<>();
    private final List<DropReason> dropReasons = new CopyOnWriteArrayList<>();
    private final List<String> warnings = new CopyOnWriteArrayList<>();
    private final Logger filterLog = Logger.getLogger(AforoServletFilter.class.getName());
    private final Handler capture = new Handler() {
        @Override public void publish(LogRecord r) {
            if (r.getLevel() == Level.WARNING) warnings.add(r.getMessage());
        }
        @Override public void flush() { }
        @Override public void close() { }
    };
    private HttpServer server;
    private AforoClient client;

    @BeforeEach
    void setUp() throws Exception {
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/", exchange -> {
            JsonNode body = mapper.readTree(exchange.getRequestBody().readAllBytes());
            body.get("events").forEach(received::add);
            exchange.sendResponseHeaders(202, -1);
            exchange.close();
        });
        server.start();
        client = new AforoClient(new AforoOptions("test-key")
                .baseUrl("http://localhost:" + server.getAddress().getPort())
                .flushCount(1000)
                .flushIntervalMs(60_000)
                .maxRetries(0)
                .onDrop((events, reason) -> dropReasons.add(reason)));
        filterLog.addHandler(capture);
    }

    @AfterEach
    void tearDown() {
        filterLog.removeHandler(capture);
        client.close();
        server.stop(0);
    }

    private static HttpServletRequest request(String method, String uri, String customerId) {
        return (HttpServletRequest) Proxy.newProxyInstance(
                AforoServletFilterTruncationTest.class.getClassLoader(),
                new Class<?>[]{HttpServletRequest.class},
                (proxy, m, args) -> switch (m.getName()) {
                    case "getMethod" -> method;
                    case "getRequestURI" -> uri;
                    case "getHeader" -> "x-customer-id".equalsIgnoreCase((String) args[0]) ? customerId : null;
                    default -> null;
                });
    }

    private static HttpServletResponse response() {
        return (HttpServletResponse) Proxy.newProxyInstance(
                AforoServletFilterTruncationTest.class.getClassLoader(),
                new Class<?>[]{HttpServletResponse.class},
                (proxy, m, args) -> m.getName().equals("getStatus") ? 200 : null);
    }

    private List<JsonNode> run(AforoServletFilter filter, HttpServletRequest... requests) throws Exception {
        FilterChain chain = (req, res) -> { };
        for (HttpServletRequest r : requests) filter.doFilter(r, response(), chain);
        client.flush();
        return new ArrayList<>(received);
    }

    private List<String> truncationWarnings(String label) {
        return warnings.stream().filter(w -> w.contains(label) && w.contains("truncated")).toList();
    }

    @Test
    void overLongPathIsTruncatedTo512AndStillSent_warnsOnce() throws Exception {
        String longA = "/" + "a".repeat(700);
        String longB = "/" + "a".repeat(600) + "b".repeat(100);
        List<JsonNode> events = run(new AforoServletFilter(client),
                request("GET", longA, "cust_1"), request("GET", longB, "cust_1"));

        assertThat(events).hasSize(2);
        assertThat(events.get(0).get("endpointPath").asText()).isEqualTo(longA.substring(0, 512));
        assertThat(events.get(1).get("endpointPath").asText()).hasSize(512);
        assertThat(client.droppedCount()).isZero();
        assertThat(truncationWarnings("endpointPath")).hasSize(1);
        assertThat(truncationWarnings("endpointPath").get(0)).contains("512");
        // Keys are random per track() call, never built from the path: both present and distinct
        // although the two paths share their first 512 characters.
        assertThat(events.get(0).get("idempotencyKey").asText())
                .isNotBlank().isNotEqualTo(events.get(1).get("idempotencyKey").asText());
    }

    @Test
    void truncationNeverSplitsASurrogatePair() throws Exception {
        // "/" + 510 x 'a' puts the emoji's two code units at index 511 and 512.
        String path = "/" + "a".repeat(510) + "😀" + "zzz";
        List<JsonNode> events = run(new AforoServletFilter(client), request("GET", path, "cust_1"));

        String sent = events.get(0).get("endpointPath").asText();
        assertThat(sent).hasSize(511).isEqualTo("/" + "a".repeat(510));
        assertThat(Character.isSurrogate(sent.charAt(sent.length() - 1))).isFalse();
    }

    @Test
    void overLongHttpMethodIsTruncatedTo16() throws Exception {
        List<JsonNode> events = run(new AforoServletFilter(client),
                request("X".repeat(40), "/users", "cust_1"), request("Y".repeat(40), "/users", "cust_1"));

        assertThat(events).hasSize(2);
        assertThat(events.get(0).get("httpMethod").asText()).isEqualTo("X".repeat(16));
        assertThat(events.get(1).get("httpMethod").asText()).isEqualTo("Y".repeat(16));
        assertThat(truncationWarnings("httpMethod")).hasSize(1);
    }

    @Test
    void labelsWithinTheLimitAreUntouchedAndNotWarned() throws Exception {
        String path = "/" + "a".repeat(511);
        List<JsonNode> events = run(new AforoServletFilter(client), request("DELETE", path, "cust_1"));

        assertThat(events.get(0).get("endpointPath").asText()).isEqualTo(path);
        assertThat(events.get(0).get("httpMethod").asText()).isEqualTo("DELETE");
        assertThat(warnings.stream().filter(w -> w.contains("truncated"))).isEmpty();
    }

    @Test
    void overLongCustomerIdIsStillDroppedAsInvalid() throws Exception {
        List<JsonNode> events = run(new AforoServletFilter(client),
                request("GET", "/users", "c".repeat(65)));

        assertThat(events).isEmpty();
        assertThat(client.droppedCount()).isEqualTo(1);
        assertThat(dropReasons).containsExactly(DropReason.INVALID);
    }

    @Test
    void overLongCallerMetricNameIsStillDroppedAsInvalid() throws Exception {
        List<JsonNode> events = run(new AforoServletFilter(client).metricNameResolver((q, s) -> "m".repeat(256)),
                request("GET", "/users", "cust_1"));

        assertThat(events).isEmpty();
        assertThat(dropReasons).containsExactly(DropReason.INVALID);
    }

    @Test
    void truncateHelperCountsUtf16UnitsAndKeepsPairsWhole() {
        assertThat(RequestLabels.truncate(null, 5)).isNull();
        assertThat(RequestLabels.truncate("abc", 5)).isEqualTo("abc");
        assertThat(RequestLabels.truncate("abcdef", 5)).isEqualTo("abcde");
        assertThat(RequestLabels.truncate("abcd😀", 5)).isEqualTo("abcd");
        assertThat(RequestLabels.truncate("abc😀x", 5)).isEqualTo("abc😀");
    }
}
