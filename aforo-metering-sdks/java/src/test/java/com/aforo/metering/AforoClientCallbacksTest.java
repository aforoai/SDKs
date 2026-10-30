package com.aforo.metering;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/** Typed onError, onAccepted and serialization at track() on the core client. */
@DisplayName("AforoClient — onError, onAccepted, unserializable events")
class AforoClientCallbacksTest {

    private HttpServer server;
    private final AtomicReference<String> answer = new AtomicReference<>();
    private final AtomicReference<Integer> status = new AtomicReference<>(202);

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/ingest/batch", ex -> {
            com.aforo.testsupport.RequestBodies.read(ex);
            byte[] body = (answer.get() == null ? "" : answer.get()).getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", "application/json");
            ex.sendResponseHeaders(status.get(), body.length == 0 ? -1 : body.length);
            if (body.length > 0) {
                try (OutputStream out = ex.getResponseBody()) {
                    out.write(body);
                }
            }
            ex.close();
        });
        server.start();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private AforoOptions options() {
        return new AforoOptions("sk_test_callbacks")
                .baseUrl("http://127.0.0.1:" + server.getAddress().getPort())
                .flushIntervalMs(60_000)
                .maxRetries(0)
                .registerShutdownHook(false);
    }

    @Test
    void onErrorGetsATypedRejection() {
        status.set(400);
        List<AforoError> errors = new CopyOnWriteArrayList<>();
        try (AforoClient client = new AforoClient(options().onError(errors::add))) {
            client.track(TrackEvent.builder("cust_1", "api_calls").idempotencyKey("k1").build());
            client.flush();
        }
        assertThat(errors).hasSize(1);
        assertThat(errors.get(0).kind()).isEqualTo(AforoError.Kind.REJECTED);
        assertThat(errors.get(0).status()).isEqualTo(400);
        assertThat(errors.get(0).willRetry()).isFalse();
        assertThat(errors.get(0).events()).extracting(e -> e.toMap().get("idempotencyKey")).containsExactly("k1");
    }

    @Test
    void onAcceptedGetsTheUnwrappedBody() {
        answer.set("{\"success\":true,\"data\":{\"accepted\":1,\"killedSessionIds\":[\"s9\"]},\"meta\":{}}");
        List<Map<String, Object>> bodies = new CopyOnWriteArrayList<>();
        try (AforoClient client = new AforoClient(options().onAccepted((body, events) -> bodies.add(body)))) {
            client.track(TrackEvent.builder("cust_1", "api_calls").build());
            client.flush();
        }
        assertThat(bodies).hasSize(1);
        assertThat(bodies.get(0).get("killedSessionIds")).isEqualTo(List.of("s9"));
    }

    @Test
    void anEventWithCyclicMetadataIsDroppedAsInvalidAtTrack() {
        List<DropReason> reasons = new CopyOnWriteArrayList<>();
        Map<String, Object> cyclic = new HashMap<>();
        cyclic.put("self", cyclic);
        try (AforoClient client = new AforoClient(options().onDrop((events, reason) -> reasons.add(reason)))) {
            client.track(TrackEvent.builder("cust_1", "api_calls").metadata(cyclic).build());
            assertThat(reasons).containsExactly(DropReason.INVALID);
            assertThat(client.bufferedCount()).isZero();
            assertThat(client.droppedCount()).isEqualTo(1);
        }
    }

    @Test
    void nanInMetadataStillProducesStrictJson() throws Exception {
        AtomicReference<String> sent = new AtomicReference<>();
        server.removeContext("/v1/ingest/batch");
        server.createContext("/v1/ingest/batch", ex -> {
            sent.set(new String(com.aforo.testsupport.RequestBodies.read(ex), StandardCharsets.UTF_8));
            ex.sendResponseHeaders(202, -1);
            ex.close();
        });
        try (AforoClient client = new AforoClient(options())) {
            client.track(TrackEvent.builder("cust_1", "api_calls").metadata(Map.of("ratio", Double.NaN)).build());
            client.flush();
        }
        assertThat(sent.get()).isNotNull();
        new com.fasterxml.jackson.databind.ObjectMapper()
                .enable(com.fasterxml.jackson.core.JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
                .readTree(sent.get()); // throws on an unquoted NaN
    }
}
