package com.aforo.ws;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/** Regression test for review finding 9 / rule R8: an idle-swept connection is tracked again by its next frame. */
class ReviewRegressionWsTest {
    @Test
    void framesAfterTheIdleSweepAreMetered() throws Exception {
        ObjectMapper om = new ObjectMapper();
        List<JsonNode> events = new CopyOnWriteArrayList<>();
        HttpServer ingest = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        ingest.createContext("/", ex -> {
            om.readTree(com.aforo.testsupport.RequestBodies.read(ex)).get("events").forEach(events::add);
            ex.sendResponseHeaders(202, -1);
            ex.close();
        });
        ingest.start();
        AtomicLong clock = new AtomicLong(1_700_000_000_000L);
        AforoWsBilling ws = AforoWsBilling.newBuilder().tenantId("t").productId("p").apiKey("k")
                .ingestorUrl("http://127.0.0.1:" + ingest.getAddress().getPort())
                .perFrameEvents(true).flushIntervalMs(60_000).clock(clock::get).build();
        String id = ws.openConnection("cust_1", Map.of("region", "eu"));
        ws.recordFrame(id, "CLIENT_TO_SERVER", "TEXT", 100);
        clock.addAndGet(3_600_001L);
        assertThat(ws.sweepIdle()).isEqualTo(1);
        assertThat(ws.openConnections()).isZero();

        for (int i = 0; i < 5; i++) ws.recordFrame(id, "CLIENT_TO_SERVER", "TEXT", 1000);
        assertThat(ws.openConnections()).isEqualTo(1);
        clock.addAndGet(2_000);
        ws.closeConnection(id, 1000);
        ws.closeConnection(id, 1000); // a second close is a no-op
        ws.close();
        ingest.stop(0);

        List<String> metrics = events.stream().map(e -> e.get("metricName").asText()).toList();
        assertThat(metrics).containsExactly("websocket_api.connection_opened", "websocket_api.message",
                "websocket_api.connection_closed", "websocket_api.message", "websocket_api.message",
                "websocket_api.message", "websocket_api.message", "websocket_api.message",
                "websocket_api.connection_closed");
        JsonNode lastClose = events.get(events.size() - 1);
        assertThat(lastClose.get("messageCount").asInt()).isEqualTo(5);
        assertThat(lastClose.get("dataBytes").asLong()).isEqualTo(5000);
        assertThat(lastClose.get("customerId").asText()).isEqualTo("cust_1");
        assertThat(lastClose.get("metadata").get("resumedAfterIdleSweep").asBoolean()).isTrue();
        assertThat(lastClose.get("metadata").get("region").asText()).isEqualTo("eu");
        assertThat(ws.droppedCount()).isZero();
    }
}
