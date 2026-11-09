package com.aforo.metering.spring;

import com.aforo.metering.AforoClient;
import com.aforo.metering.AforoOptions;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.net.InetSocketAddress;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Regression for the 2026-11-09 end-to-end test: under Spring Boot every unmatched URL (404) was
 * recorded with {@code endpointPath = "/**"}, the static-resource handler's catch-all pattern.
 */
class EndToEndRegressionServletTest {
    private static final String BEST_MATCHING_PATTERN = "org.springframework.web.servlet.HandlerMapping.bestMatchingPattern";

    private final ObjectMapper mapper = new ObjectMapper();
    private final List<JsonNode> received = new CopyOnWriteArrayList<>();
    private HttpServer server;
    private AforoClient client;

    @BeforeEach
    void setUp() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", ex -> {
            mapper.readTree(com.aforo.testsupport.RequestBodies.read(ex)).get("events").forEach(received::add);
            ex.sendResponseHeaders(202, -1);
            ex.close();
        });
        server.start();
        client = new AforoClient(new AforoOptions("k").baseUrl("http://127.0.0.1:" + server.getAddress().getPort())
                .registerShutdownHook(false).flushIntervalMs(60_000).maxRetries(0));
    }

    @AfterEach
    void tearDown() {
        client.close();
        server.stop(0);
    }

    private static MockHttpServletRequest get(String uri, String bestMatchingPattern) {
        MockHttpServletRequest r = new MockHttpServletRequest("GET", uri);
        if (bestMatchingPattern != null) r.setAttribute(BEST_MATCHING_PATTERN, bestMatchingPattern);
        return r;
    }

    @Test
    void theCatchAllPatternIsNotRecordedAsTheEndpoint() throws Exception {
        AforoServletFilter filter = AforoServletFilter.builder(client).customerIdResolver(r -> "cust_1")
                .closeClientOnDestroy(false).build();
        MockHttpServletResponse notFound = new MockHttpServletResponse();
        notFound.setStatus(404);
        filter.doFilter(get("/v1/missing/900", "/**"), notFound, new MockFilterChain());        // resource handler 404
        filter.doFilter(get("/v1/other/abc123def", " /** "), new MockHttpServletResponse(), new MockFilterChain());
        filter.doFilter(get("/v1/users/42", "/v1/users/{id}"), new MockHttpServletResponse(), new MockFilterChain());
        filter.doFilter(get("/static/app.js", "/static/**"), new MockHttpServletResponse(), new MockFilterChain());
        filter.doFilter(get("/v1/plain/7", null), new MockHttpServletResponse(), new MockFilterChain()); // no handler
        client.flush();

        assertThat(received).extracting(n -> n.get("endpointPath").asText()).containsExactly(
                "/v1/missing/:id", "/v1/other/:id", "/v1/users/{id}", "/static/**", "/v1/plain/:id");
        assertThat(received.get(0).get("statusCode").asInt()).isEqualTo(404);
    }
}
