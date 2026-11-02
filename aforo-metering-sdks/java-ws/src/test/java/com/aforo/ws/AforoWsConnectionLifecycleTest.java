package com.aforo.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Connection lifecycle (G279, same behaviour as go-ws 2.0.0): OPEN has its own frame type
 * and metric, close() emits CONNECTION_CLOSED for every connection still open, and an idle
 * sweep keeps the open-connection map bounded.
 */
class AforoWsConnectionLifecycleTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private HttpServer server;
    private final List<JsonNode> events = new CopyOnWriteArrayList<>();
    private final AtomicLong clock = new AtomicLong(1_800_000_000_000L);

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", ex -> {
            JsonNode body = MAPPER.readTree(new String(com.aforo.testsupport.RequestBodies.read(ex), StandardCharsets.UTF_8));
            body.get("events").forEach(events::add);
            ex.sendResponseHeaders(204, -1);
            ex.close();
        });
        server.start();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private AforoWsBilling.Builder builder() {
        return AforoWsBilling.newBuilder()
                .tenantId("tenant-001")
                .productId("prod-ws-001")
                .apiKey("sk_test_abc")
                .ingestorUrl("http://127.0.0.1:" + server.getAddress().getPort())
                .flushIntervalMs(60_000L)
                .clock(clock::get);
    }

    private List<JsonNode> ofFrameType(String type) {
        List<JsonNode> out = new ArrayList<>();
        for (JsonNode e : events) if (type.equals(e.path("wsFrameType").asText())) out.add(e);
        return out;
    }

    @Test
    void openHasItsOwnFrameTypeAndMetric() {
        AforoWsBilling billing = builder().build();
        String id = billing.openConnection("cust_1", Map.of("region", "eu"));
        billing.closeConnection(id, 1000);
        billing.close();

        List<JsonNode> opens = ofFrameType("OPEN");
        assertThat(opens).hasSize(1);
        assertThat(opens.get(0).get("metricName").asText()).isEqualTo("websocket_api.connection_opened");
        assertThat(opens.get(0).at("/metadata/event").asText()).isEqualTo("CONNECTION_OPENED");
        assertThat(ofFrameType("PING")).isEmpty();
        assertThat(ofFrameType("CLOSE")).hasSize(1);
    }

    @Test
    void closeEmitsConnectionClosedForEveryConnectionStillOpen() {
        AforoWsBilling billing = builder().build();
        billing.openConnection("cust_1", Map.of());
        billing.openConnection("cust_2", Map.of());
        assertThat(billing.openConnections()).isEqualTo(2);

        billing.close();

        assertThat(billing.openConnections()).isZero();
        List<JsonNode> closes = ofFrameType("CLOSE");
        assertThat(closes).hasSize(2);
        assertThat(closes).allSatisfy(c -> {
            assertThat(c.get("metricName").asText()).isEqualTo("websocket_api.connection_closed");
            assertThat(c.get("wsCloseReason").asText()).isEqualTo("GOING_AWAY");
            assertThat(c.at("/metadata/closedBy").asText()).isEqualTo("sdk_shutdown");
            assertThat(c.at("/metadata/closeCode").asInt()).isEqualTo(1001);
        });
    }

    @Test
    void idleConnectionsAreSweptAndActiveOnesAreKept() {
        AforoWsBilling billing = builder().connectionIdleTimeoutMs(60_000).build();
        String idle = billing.openConnection("cust_idle", Map.of());
        String busy = billing.openConnection("cust_busy", Map.of());
        clock.addAndGet(50_000);
        billing.recordFrame(busy, "CLIENT_TO_SERVER", "TEXT", 10);
        clock.addAndGet(20_000); // idle: 70 s without activity; busy: 20 s

        assertThat(billing.sweepIdle()).isEqualTo(1);
        assertThat(billing.openConnections()).isEqualTo(1);
        billing.closeConnection(idle, 1000); // already closed by the sweep: no second event
        billing.closeConnection(busy, 1000);
        billing.close();

        List<JsonNode> closes = ofFrameType("CLOSE");
        assertThat(closes).hasSize(2);
        JsonNode swept = closes.stream().filter(c -> c.get("customerId").asText().equals("cust_idle")).findFirst()
                .orElseThrow();
        assertThat(swept.get("wsCloseReason").asText()).isEqualTo("ABNORMAL_CLOSURE");
        assertThat(swept.at("/metadata/closedBy").asText()).isEqualTo("sdk_idle_timeout");
    }

    @Test
    void aNegativeIdleTimeoutIsRefused() {
        assertThatThrownBy(() -> builder().connectionIdleTimeoutMs(-1).build())
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("connectionIdleTimeoutMs");
    }

    @Test
    void anOpenAfterCloseIsNotTrackedAndIsReportedAsClosed() {
        List<AforoWsBilling.DropReason> reasons = new CopyOnWriteArrayList<>();
        AforoWsBilling billing = builder().onDrop((e, r) -> reasons.add(r)).build();
        billing.close();
        assertThat(billing.openConnection("cust_1", Map.of())).isNull();
        assertThat(billing.openConnections()).isZero();
        assertThat(reasons).containsExactly(AforoWsBilling.DropReason.CLOSED);
    }
}
