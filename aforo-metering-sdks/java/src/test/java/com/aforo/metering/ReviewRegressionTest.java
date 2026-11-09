package com.aforo.metering;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.IntPredicate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Regression tests for the 2026-11-09 Java SDK review (findings 1-3, rules R1 and R3-R5). */
class ReviewRegressionTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final List<List<JsonNode>> batches = new CopyOnWriteArrayList<>();
    private final List<String> apiKeys = new CopyOnWriteArrayList<>();
    private final List<String> drops = new CopyOnWriteArrayList<>();
    /** Batch sizes answered 429 with X-RateLimit-Limit: 2 (R5); everything else is accepted. */
    private volatile IntPredicate rateLimited = null;
    private final java.util.concurrent.atomic.AtomicInteger tooMany = new java.util.concurrent.atomic.AtomicInteger();
    private HttpServer server;

    @BeforeEach
    void start() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", ex -> {
            JsonNode body = mapper.readTree(com.aforo.testsupport.RequestBodies.read(ex));
            List<JsonNode> events = new ArrayList<>();
            body.get("events").forEach(events::add);
            apiKeys.add(ex.getRequestHeaders().getFirst("X-API-Key"));
            // Like IngestRateLimiter: a key with a limit gets X-RateLimit-Limit on every answer.
            if (rateLimited != null) ex.getResponseHeaders().set("X-RateLimit-Limit", "2");
            if (rateLimited != null && rateLimited.test(events.size())) {
                tooMany.incrementAndGet();
                ex.getResponseHeaders().set("Retry-After", "0");
                ex.sendResponseHeaders(429, -1);
            } else {
                batches.add(events);
                ex.sendResponseHeaders(202, -1);
            }
            ex.close();
        });
        server.start();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private AforoOptions options(String key) {
        return new AforoOptions(key).baseUrl("http://127.0.0.1:" + server.getAddress().getPort())
                .registerShutdownHook(false).flushIntervalMs(60_000).retryBaseMs(1)
                .onDrop((ev, reason) -> { for (ResolvedEvent e : ev) drops.add(reason + ":" + e.getCustomerId()); });
    }

    private List<JsonNode> received() {
        List<JsonNode> all = new ArrayList<>();
        batches.forEach(all::addAll);
        return all;
    }

    @Test
    void malformedOccurredAtIsDroppedAtTrackAndNeverSinksTheBatch() {
        try (AforoClient client = new AforoClient(options("k"))) {
            client.track(TrackEvent.builder("cust_A", "api_calls").build());
            for (String bad : List.of("2026-11-09T10:00:00", "2026-11-09 10:00:00Z", "2026-11-09T10:00Z",
                    "2026-11-09T10:00:00+0530", "2026-02-30T10:00:00Z", "yesterday")) {
                client.track(TrackEvent.builder("cust_bad", "api_calls").occurredAt(bad).build());
            }
            client.track(TrackEvent.builder("cust_B", "api_calls").occurredAt("2026-11-09T10:00:00+05:30").build());
            client.track(TrackEvent.builder("cust_C", "api_calls").occurredAt("2026-11-09T10:00:00.123456Z").build());
            assertThat(client.droppedCount()).isEqualTo(6);
            assertThat(drops).containsOnly("INVALID:cust_bad");
            assertThat(client.flush().sent()).isEqualTo(3);
        }
        assertThat(received()).extracting(n -> n.get("customerId").asText()).containsExactly("cust_A", "cust_B", "cust_C");
        assertThat(received().get(1).get("occurredAt").asText()).isEqualTo("2026-11-09T10:00:00+05:30");
    }

    @Test
    void numbersOutsideTheIngestorsTypesAreLeftOffAndTheEventIsSent() {
        try (AforoClient client = new AforoClient(options("k"))) {
            client.track(TrackEvent.builder("cust_A", "api_calls").statusCode(40_000).responseTimeMs(3_000_000_000L).build());
            client.track(TrackEvent.builder("cust_B", "api_calls").statusCode(503).responseTimeMs(12L).build());
            client.flush();
        }
        List<JsonNode> got = received();
        assertThat(got).hasSize(2);
        assertThat(got.get(0).has("statusCode")).isFalse();
        assertThat(got.get(0).has("responseTimeMs")).isFalse();
        assertThat(got.get(1).get("statusCode").asInt()).isEqualTo(503);
        assertThat(got.get(1).get("responseTimeMs").asLong()).isEqualTo(12L);
    }

    @Test
    void apiKeyIsTrimmedAndAKeyThatCannotBeAHeaderIsRefusedWithoutEchoingIt() {
        try (AforoClient client = new AforoClient(options("  sk_live_SECRET123\n"))) {
            client.track(TrackEvent.builder("cust_A", "api_calls").build());
            assertThat(client.flush().sent()).isEqualTo(1);
        }
        assertThat(apiKeys).containsExactly("sk_live_SECRET123");
        for (String bad : List.of("sk_live SECRET123", "sk_live_SECRET123\r\nX-Evil: 1", "sk_live_\u0007SECRET123")) {
            assertThatThrownBy(() -> new AforoClient(options(bad)))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("apiKey")
                    .satisfies(e -> assertThat(e.getMessage()).doesNotContain("SECRET"));
        }
    }

    @Test
    void closeFromAnInterruptedThreadStillDrainsAndKeepsTheInterrupt() {
        AforoClient client = new AforoClient(options("k"));
        for (int i = 0; i < 5; i++) client.track(TrackEvent.builder("cust_" + i, "api_calls").build());
        Thread.currentThread().interrupt();
        client.close();
        boolean stillInterrupted = Thread.interrupted();
        assertThat(stillInterrupted).isTrue();
        assertThat(received()).hasSize(5);
        assertThat(client.droppedCount()).isZero();
        assertThat(drops).isEmpty();
    }

    @Test
    void a429BelowTheBatchSizeSplitsTheBatchInOrderAndLosesNothing() throws Exception {
        rateLimited = n -> n > 2;
        List<String> keys = new ArrayList<>();
        try (AforoClient client = new AforoClient(options("k").flushCount(5))) {
            for (int i = 0; i < 5; i++) {
                String key = "key-" + i;
                keys.add(key);
                client.track(TrackEvent.builder("cust_" + i, "api_calls").idempotencyKey(key).build());
            }
            client.flush();
            long until = System.currentTimeMillis() + 5_000;
            while (received().size() < 5 && System.currentTimeMillis() < until) Thread.sleep(20);
            assertThat(client.droppedCount()).isZero();
        }
        assertThat(tooMany.get()).isEqualTo(1);
        assertThat(batches).extracting(List::size).containsExactly(2, 2, 1);
        assertThat(received()).extracting(n -> n.get("idempotencyKey").asText()).containsExactlyElementsOf(keys);
    }
}
