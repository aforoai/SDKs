package com.aforo.metering.spring;

import com.aforo.metering.AforoClient;
import com.aforo.metering.AforoOptions;
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
import java.security.Principal;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("AforoServletFilter — ingest contract")
class AforoServletFilterTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final List<JsonNode> received = new CopyOnWriteArrayList<>();
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
                .maxRetries(0));
    }

    @AfterEach
    void tearDown() {
        client.close();
        server.stop(0);
    }

    private static HttpServletRequest request(String method, String uri, Map<String, String> headers,
                                              String principal) {
        Map<String, String> lower = new HashMap<>();
        headers.forEach((k, v) -> lower.put(k.toLowerCase(), v));
        return (HttpServletRequest) Proxy.newProxyInstance(
                AforoServletFilterTest.class.getClassLoader(),
                new Class<?>[]{HttpServletRequest.class},
                (proxy, m, args) -> switch (m.getName()) {
                    case "getMethod" -> method;
                    case "getRequestURI" -> uri;
                    case "getHeader" -> lower.get(((String) args[0]).toLowerCase());
                    case "getUserPrincipal" -> principal == null ? null : (Principal) () -> principal;
                    case "getAttribute" -> null;
                    default -> null;
                });
    }

    private static HttpServletResponse response() {
        return (HttpServletResponse) Proxy.newProxyInstance(
                AforoServletFilterTest.class.getClassLoader(),
                new Class<?>[]{HttpServletResponse.class},
                (proxy, m, args) -> m.getName().equals("getStatus") ? 200 : null);
    }

    private List<JsonNode> run(AforoServletFilter filter, HttpServletRequest... requests) throws Exception {
        FilterChain chain = (req, res) -> { };
        for (HttpServletRequest r : requests) {
            filter.doFilter(r, response(), chain);
        }
        client.flush();
        return new ArrayList<>(received);
    }

    @Test
    void defaultMetricIsCatalogNameAndCustomerFromHeader() throws Exception {
        List<JsonNode> events = run(new AforoServletFilter(client),
                request("GET", "/users/42", Map.of("X-Customer-Id", "cust_1"), null));

        assertThat(events).hasSize(1);
        assertThat(events.get(0).get("metricName").asText()).isEqualTo("api_calls");
        assertThat(events.get(0).get("customerId").asText()).isEqualTo("cust_1");
    }

    @Test
    void neverUsesCallerApiKeyAsCustomer() throws Exception {
        List<JsonNode> events = run(new AforoServletFilter(client),
                request("GET", "/users/42", Map.of("X-Api-Key", "secret"), null));
        assertThat(events).isEmpty();
    }

    @Test
    void principalIsIgnoredUnlessOptedIn() throws Exception {
        List<JsonNode> events = run(new AforoServletFilter(client),
                request("GET", "/users/42", Map.of(), "alice@example.com"));
        assertThat(events).isEmpty();

        events = run(new AforoServletFilter(client).usePrincipalAsCustomerId(true),
                request("GET", "/users/42", Map.of("X-Customer-Id", "spoofed"), "cust_principal"));
        assertThat(events).hasSize(1);
        assertThat(events.get(0).get("customerId").asText()).isEqualTo("cust_principal");
    }

    @Test
    void skipsOptionsPreflight() throws Exception {
        List<JsonNode> events = run(new AforoServletFilter(client),
                request("OPTIONS", "/users/42",
                        Map.of("X-Customer-Id", "cust_1", "Access-Control-Request-Method", "POST"), null));
        assertThat(events).isEmpty();
    }

    @Test
    void metricAndCustomerAreConfigurable() throws Exception {
        AforoServletFilter filter = new AforoServletFilter(client)
                .metricName("sms_sent")
                .customerIdHeader("X-Account");
        List<JsonNode> events = run(filter, request("POST", "/send", Map.of("X-Account", "acct_1"), null));
        assertThat(events.get(0).get("metricName").asText()).isEqualTo("sms_sent");
        assertThat(events.get(0).get("customerId").asText()).isEqualTo("acct_1");

        received.clear();
        filter = new AforoServletFilter(client)
                .metricName("fallback_metric")
                .metricNameResolver((req, res) -> req.getRequestURI().startsWith("/otp") ? "otp_delivered" : null)
                .customerIdResolver(req -> "cust_resolved");
        events = run(filter,
                request("POST", "/otp/send", Map.of(), null),
                request("GET", "/other", Map.of(), null));
        assertThat(events).extracting(e -> e.get("metricName").asText())
                .containsExactly("otp_delivered", "fallback_metric");
        assertThat(events).extracting(e -> e.get("customerId").asText())
                .containsOnly("cust_resolved");
    }
}
