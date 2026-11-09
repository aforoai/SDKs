package com.aforo.metering.spring;

import com.aforo.metering.AforoClient;
import com.aforo.metering.AforoOptions;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import jakarta.servlet.AsyncContext;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.apache.catalina.Context;
import org.apache.catalina.Wrapper;
import org.apache.catalina.startup.Tomcat;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.io.File;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/** Regression tests for the 2026-11-09 Java SDK review (findings 4-7, rules R6 and R7). */
class ReviewRegressionServletTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final List<JsonNode> received = new CopyOnWriteArrayList<>();
    private final List<String> drops = new CopyOnWriteArrayList<>();
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
                .registerShutdownHook(false).flushIntervalMs(60_000).maxRetries(0)
                .onDrop((ev, reason) -> drops.add(reason + "x" + ev.size())));
    }

    @AfterEach
    void tearDown() {
        client.close();
        server.stop(0);
    }

    private static MockHttpServletRequest get(String contextPath, String uri) {
        MockHttpServletRequest r = new MockHttpServletRequest("GET", uri);
        r.setContextPath(contextPath);
        return r;
    }

    @Test
    void excludedPathsMatchWholeSegmentsInsideTheContextPath() throws Exception {
        AforoServletFilter filter = AforoServletFilter.builder(client).customerIdResolver(r -> "cust_1")
                .closeClientOnDestroy(false).build();
        for (MockHttpServletRequest r : List.of(
                get("", "/healthcare/patients/42"), get("", "/readyset/items"), get("", "/metrics-api/usage"),
                get("", "/actuators/x"), get("/api", "/api/healthcare"),
                // excluded:
                get("", "/health"), get("", "/health/live"), get("", "/actuator/prometheus"),
                get("/api", "/api/actuator/health"), get("/api", "/api/favicon.ico"))) {
            filter.doFilter(r, new MockHttpServletResponse(), new MockFilterChain());
        }
        client.flush();
        assertThat(received).extracting(n -> n.get("endpointPath").asText()).containsExactly(
                "/healthcare/patients/:id", "/readyset/items", "/metrics-api/usage", "/actuators/x", "/api/healthcare");
    }

    @Test
    void aResolverThatThrowsDropsTheEventAsInvalidAndCountsIt() throws Exception {
        AforoServletFilter customerThrows = AforoServletFilter.builder(client)
                .customerIdResolver(r -> { throw new IllegalStateException("account service down"); })
                .closeClientOnDestroy(false).build();
        AforoServletFilter metricThrows = AforoServletFilter.builder(client).customerIdResolver(r -> "cust_1")
                .metricNameResolver((req, res) -> { throw new IllegalStateException("catalog down"); })
                .closeClientOnDestroy(false).build();
        MockHttpServletResponse res1 = new MockHttpServletResponse();
        customerThrows.doFilter(get("", "/v1/orders"), res1, new MockFilterChain());
        metricThrows.doFilter(get("", "/v1/orders"), new MockHttpServletResponse(), new MockFilterChain());
        client.flush();
        assertThat(received).isEmpty();
        assertThat(client.droppedCount()).isEqualTo(2);
        assertThat(drops).containsExactly("INVALIDx1", "INVALIDx1");
        assertThat(res1.getStatus()).isEqualTo(200); // the request itself was served
    }

    /** The auto-configuration's own registration in a real Tomcat, as Spring Boot installs it. */
    @Test
    void asyncRequestsAreMeteredAtCompletionAndFailingHandlersAreMetered() throws Exception {
        FilterRegistrationBean<AforoServletFilter> reg = AforoMeteringAutoConfiguration.ServletFilterConfiguration
                .filterRegistration(client, new AforoMeteringProperties(), null, r -> "cust_1");
        Tomcat tomcat = new Tomcat();
        tomcat.setBaseDir(Files.createTempDirectory("aforo-tc").toString());
        tomcat.setPort(0);
        tomcat.getConnector();
        Context ctx = tomcat.addContext("", null);
        Wrapper w = Tomcat.addServlet(ctx, "app", new HttpServlet() {
            @Override
            protected void service(HttpServletRequest req, HttpServletResponse resp) {
                switch (req.getRequestURI()) {
                    case "/boom" -> throw new IllegalStateException("handler bug");
                    case "/async" -> {
                        AsyncContext ac = req.startAsync();
                        ac.start(() -> {
                            try { Thread.sleep(300); } catch (InterruptedException ignored) { }
                            ((HttpServletResponse) ac.getResponse()).setStatus(503);
                            ac.complete();
                        });
                    }
                    default -> resp.setStatus(201);
                }
            }
        });
        w.setAsyncSupported(true);
        ctx.addServletMappingDecoded("/*", "app");
        ctx.addServletContainerInitializer((c, sc) -> reg.onStartup(sc), null);
        tomcat.start();
        try {
            int port = tomcat.getConnector().getLocalPort();
            HttpClient http = HttpClient.newHttpClient();
            List<Integer> seen = new ArrayList<>();
            for (String p : List.of("/ok", "/boom", "/async")) {
                seen.add(http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + p)).build(),
                        HttpResponse.BodyHandlers.discarding()).statusCode());
            }
            assertThat(seen).containsExactly(201, 500, 503);
            Thread.sleep(200); // onComplete runs after the response is sent
            client.flush();
        } finally {
            tomcat.stop();
            tomcat.destroy();
        }
        assertThat(received).hasSize(3);
        JsonNode ok = byPath("/ok"), boom = byPath("/boom"), async = byPath("/async");
        assertThat(ok.get("statusCode").asInt()).isEqualTo(201);
        assertThat(boom.get("statusCode").asInt()).isEqualTo(500);
        assertThat(async.get("statusCode").asInt()).isEqualTo(503);
        assertThat(async.get("responseTimeMs").asLong()).isGreaterThanOrEqualTo(250);
    }

    private JsonNode byPath(String path) {
        return received.stream().filter(n -> n.get("endpointPath").asText().equals(path)).findFirst().orElseThrow();
    }

    /** aforo.enabled=true in an app without the servlet API (WebFlux, a worker) must start. */
    @Test
    void autoConfigurationStartsWithoutTheServletApi() throws Exception {
        String full = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
        List<String> kept = new ArrayList<>();
        for (String entry : full.split(File.pathSeparator)) {
            String name = new File(entry).getName();
            if (name.startsWith("jakarta.servlet-api") || name.startsWith("tomcat-") || name.startsWith("spring-web-")) continue;
            kept.add(entry);
        }
        String java = System.getProperty("java.home") + File.separator + "bin" + File.separator + "java";
        Process p = new ProcessBuilder(java, "-cp", String.join(File.pathSeparator, kept),
                NonServletStartupMain.class.getName()).redirectErrorStream(true).start();
        assertThat(p.waitFor(60, TimeUnit.SECONDS)).isTrue();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(out).contains("STARTED").doesNotContain("FAILED");
    }
}
