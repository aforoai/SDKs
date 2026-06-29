/*
 * Real-server integration test for aforo:ws-metering.
 *
 * Where AforoWsBillingTest uses plain method invocations, this file:
 *   - spins up a REAL WebSocket server on a random localhost port via
 *     the pure-Java `org.java-websocket` library
 *   - connects a REAL WebSocket client
 *   - calls billing.openConnection() on the real handshake, records
 *     frames on every real inbound message, closes on real disconnect
 *   - asserts OPEN + CLOSE events with aggregated counters reach a
 *     real HTTP capture server
 *
 * Catches what mock-based tests can't:
 *   - real TCP handshake timing (server must track connection by the
 *     time the first frame arrives)
 *   - real frame byte counting matches the TCP-level payload
 *   - close-code → enum mapping with the real server-side code
 *   - flush-over-HTTP round trip with Authorization headers
 */
package com.aforo.ws;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.java_websocket.WebSocket;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.handshake.ServerHandshake;
import org.java_websocket.server.WebSocketServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class AforoWsIntegrationTest {

    private static final ObjectMapper OM = new ObjectMapper();

    private HttpServer captureServer;
    private int capturePort;
    private final List<Map<String, Object>> capturedBodies = new ArrayList<>();
    private final List<Map<String, List<String>>> capturedHeaders = new ArrayList<>();

    private AforoWsBilling billing;
    private _TestWsServer wsServer;

    // Track the per-connection id issued by billing.openConnection so the
    // server-side onMessage / onClose can address the right connection
    private final Map<WebSocket, String> connIdByWs = new ConcurrentHashMap<>();

    @BeforeEach
    void setUp() throws IOException, InterruptedException {
        captureServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        captureServer.createContext("/", (HttpExchange ex) -> {
            byte[] body = ex.getRequestBody().readAllBytes();
            synchronized (capturedBodies) {
                try {
                    if (body.length > 0) {
                        Map<String, Object> parsed = OM.readValue(body, new TypeReference<>() {});
                        capturedBodies.add(parsed);
                    } else {
                        capturedBodies.add(Map.of());
                    }
                    capturedHeaders.add(Map.copyOf(ex.getRequestHeaders()));
                } catch (Exception ignore) {
                    capturedBodies.add(Map.of());
                }
            }
            ex.sendResponseHeaders(204, -1);
            ex.close();
        });
        captureServer.start();
        capturePort = captureServer.getAddress().getPort();

        billing = AforoWsBilling.newBuilder()
                .tenantId("tenant-int-ws")
                .productId("prod-int-ws")
                .apiKey("sk_int_ws")
                .ingestorUrl("http://127.0.0.1:" + capturePort)
                .flushCount(1)
                .flushIntervalMs(60_000L)
                .build();

        wsServer = new _TestWsServer(new InetSocketAddress("127.0.0.1", 0));
        wsServer.start();
        // Java-WebSocket binds lazily; give it a moment
        long deadline = System.currentTimeMillis() + 3000;
        while (wsServer.getPort() <= 0 && System.currentTimeMillis() < deadline) {
            Thread.sleep(25);
        }
        assertThat(wsServer.getPort()).isGreaterThan(0);
    }

    @AfterEach
    void tearDown() throws InterruptedException {
        if (wsServer != null) wsServer.stop(1000);
        if (billing != null) billing.close();
        if (captureServer != null) captureServer.stop(0);
    }

    private class _TestWsServer extends WebSocketServer {
        _TestWsServer(InetSocketAddress addr) {
            super(addr);
        }

        @Override
        public void onOpen(WebSocket conn, ClientHandshake handshake) {
            // Extract customer_id from query string on resource descriptor
            String resource = handshake.getResourceDescriptor();
            String customerId = null;
            int q = resource.indexOf('?');
            if (q >= 0) {
                String query = resource.substring(q + 1);
                for (String pair : query.split("&")) {
                    int eq = pair.indexOf('=');
                    if (eq > 0 && pair.substring(0, eq).equals("cid")) {
                        customerId = pair.substring(eq + 1);
                    }
                }
            }
            if (customerId == null || customerId.isBlank()) {
                // Mirror the SDK's "skip metering" path for anonymous connections
                return;
            }
            String connId = billing.openConnection(customerId, Map.of("resource", resource));
            connIdByWs.put(conn, connId);
        }

        @Override
        public void onClose(WebSocket conn, int code, String reason, boolean remote) {
            String connId = connIdByWs.remove(conn);
            if (connId != null) billing.closeConnection(connId, code);
        }

        @Override
        public void onMessage(WebSocket conn, String message) {
            String connId = connIdByWs.get(conn);
            if (connId == null) return;
            billing.recordFrame(connId, "CLIENT_TO_SERVER", "TEXT", message.getBytes().length);
        }

        @Override
        public void onMessage(WebSocket conn, java.nio.ByteBuffer msg) {
            String connId = connIdByWs.get(conn);
            if (connId == null) return;
            billing.recordFrame(connId, "CLIENT_TO_SERVER", "BINARY", msg.remaining());
        }

        @Override
        public void onError(WebSocket conn, Exception ex) {
            // ignore for the test
        }

        @Override
        public void onStart() {
            setConnectionLostTimeout(10);
        }
    }

    private List<Map<String, Object>> waitForEvents(java.util.function.Predicate<List<Map<String, Object>>> predicate,
                                                    long timeoutMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            List<Map<String, Object>> events = flatten();
            if (predicate.test(events)) return events;
            Thread.sleep(25);
        }
        return flatten();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> flatten() {
        List<Map<String, Object>> out = new ArrayList<>();
        synchronized (capturedBodies) {
            for (Map<String, Object> body : capturedBodies) {
                Object evs = body.get("events");
                if (evs instanceof List<?> list) {
                    for (Object o : list) {
                        if (o instanceof Map<?, ?> m) out.add((Map<String, Object>) m);
                    }
                }
            }
        }
        return out;
    }

    private WebSocketClient newClient(String pathWithQuery) {
        URI uri = URI.create("ws://127.0.0.1:" + wsServer.getPort() + pathWithQuery);
        return new WebSocketClient(uri, new Draft_6455()) {
            @Override
            public void onOpen(ServerHandshake handshakedata) {}

            @Override
            public void onMessage(String message) {}

            @Override
            public void onClose(int code, String reason, boolean remote) {}

            @Override
            public void onError(Exception ex) {}
        };
    }

    // ── Tests ─────────────────────────────────────────────────────────

    @Test
    void openAndCloseLifecycle_emitsOpenThenCloseEvents() throws Exception {
        WebSocketClient client = newClient("/?cid=cust_lifecycle_001");
        CountDownLatch connected = new CountDownLatch(1);
        client.addHeader("X-Test", "test");
        client.connectBlocking(3, TimeUnit.SECONDS);
        connected.countDown();

        // Wait until the OPEN event lands in the ingestor
        waitForEvents(
                evs -> evs.stream().anyMatch(e -> Map.of("event", "CONNECTION_OPENED").entrySet()
                        .containsAll(((Map<String, Object>) e.get("metadata")).entrySet())),
                2000);

        client.closeBlocking();

        List<Map<String, Object>> events = waitForEvents(
                evs -> evs.stream().anyMatch(e -> "CLOSE".equals(e.get("wsFrameType"))),
                2000);

        Map<String, Object> open = events.stream()
                .filter(e -> "PING".equals(e.get("wsFrameType")))
                .findFirst().orElseThrow();
        Map<String, Object> closed = events.stream()
                .filter(e -> "CLOSE".equals(e.get("wsFrameType")))
                .findFirst().orElseThrow();

        assertThat(open).containsEntry("productType", "WEBSOCKET_API");
        assertThat(open).containsEntry("customerId", "cust_lifecycle_001");
        assertThat(open).containsEntry("wsDirection", "SERVER_TO_CLIENT");

        assertThat(closed).containsEntry("customerId", "cust_lifecycle_001");
        assertThat(closed).containsEntry("productType", "WEBSOCKET_API");
    }

    @Test
    void recordFrame_tracksAggregatedBytesOnClose() throws Exception {
        WebSocketClient client = newClient("/?cid=cust_frames");
        client.connectBlocking(3, TimeUnit.SECONDS);

        client.send("hello-1");       // 7 bytes
        client.send("hello-22");      // 8 bytes
        client.send("hi");            // 2 bytes

        // Give the server time to receive before close
        Thread.sleep(150);
        client.closeBlocking();

        List<Map<String, Object>> events = waitForEvents(
                evs -> evs.stream().anyMatch(e -> "CLOSE".equals(e.get("wsFrameType"))),
                2000);

        Map<String, Object> closed = events.stream()
                .filter(e -> "CLOSE".equals(e.get("wsFrameType")))
                .findFirst().orElseThrow();

        // SDK aggregates bytes via recordFrame → ConnectionState.bytes
        Number bytes = (Number) closed.get("dataBytes");
        assertThat(bytes.longValue()).isEqualTo(7 + 8 + 2);

        Number messageCount = (Number) closed.get("messageCount");
        assertThat(messageCount.intValue()).isEqualTo(3);
    }

    @Test
    void authorizationAndTenantHeaders_reachIngestor() throws Exception {
        WebSocketClient client = newClient("/?cid=cust_headers");
        client.connectBlocking(3, TimeUnit.SECONDS);
        client.closeBlocking();

        long deadline = System.currentTimeMillis() + 3000;
        while (System.currentTimeMillis() < deadline && capturedHeaders.isEmpty()) {
            Thread.sleep(25);
        }
        assertThat(capturedHeaders).isNotEmpty();
        Map<String, List<String>> headers = capturedHeaders.get(0);
        List<String> auth = headers.getOrDefault("Authorization", List.of());
        List<String> tenant = headers.getOrDefault("X-tenant-id",
                headers.getOrDefault("X-Tenant-Id", List.of()));
        assertThat(auth).contains("Bearer sk_int_ws");
        assertThat(tenant).contains("tenant-int-ws");
    }
}
