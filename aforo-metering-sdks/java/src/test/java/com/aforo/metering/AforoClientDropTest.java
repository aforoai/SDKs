package com.aforo.metering;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("AforoClient — drop observability + onDrop hook")
class AforoClientDropTest {

    private AforoOptions options() {
        return new AforoOptions("test-key")
                .baseUrl("http://localhost:19999") // No real server — send fails fast
                .flushCount(100)
                .flushIntervalMs(60_000) // Long to avoid background flushes
                .maxRetries(0);
    }

    @Test
    void overflowEvictsOldestCountsAndFiresHook() {
        List<ResolvedEvent> droppedEvents = new CopyOnWriteArrayList<>();
        List<DropReason> reasons = new CopyOnWriteArrayList<>();

        try (var client = new AforoClient(options()
                .maxQueueSize(2)
                .onDrop((events, reason) -> { droppedEvents.addAll(events); reasons.add(reason); }))) {

            client.track(TrackEvent.builder("cust_1", "api_calls").idempotencyKey("k1").build());
            client.track(TrackEvent.builder("cust_2", "api_calls").idempotencyKey("k2").build());
            client.track(TrackEvent.builder("cust_3", "api_calls").idempotencyKey("k3").build());

            assertThat(client.droppedCount()).isEqualTo(1);
            assertThat(client.bufferedCount()).isEqualTo(2);
            assertThat(reasons).containsExactly(DropReason.OVERFLOW);
            assertThat(droppedEvents).hasSize(1);
            // Oldest evicted — keeps its idempotency key for dedup-safe replay
            assertThat(droppedEvents.get(0).toMap().get("idempotencyKey")).isEqualTo("k1");
        }
    }

    @Test
    void sendFailureDropsBatchCountsAndFiresHook() {
        List<ResolvedEvent> droppedEvents = new ArrayList<>();
        List<DropReason> reasons = new ArrayList<>();

        try (var client = new AforoClient(options()
                .onDrop((events, reason) -> { droppedEvents.addAll(events); reasons.add(reason); }))) {

            client.track(TrackEvent.builder("cust_1", "api_calls").idempotencyKey("k1").build());
            client.track(TrackEvent.builder("cust_2", "api_calls").idempotencyKey("k2").build());

            FlushResult result = client.flush(); // connection refused, maxRetries=0

            assertThat(result.failed()).isEqualTo(2);
            assertThat(client.droppedCount()).isEqualTo(2);
            assertThat(reasons).containsExactly(DropReason.RETRY_EXHAUSTED);
            assertThat(droppedEvents).hasSize(2);
            assertThat(droppedEvents.get(0).toMap().get("idempotencyKey")).isEqualTo("k1");
            assertThat(droppedEvents.get(1).toMap().get("idempotencyKey")).isEqualTo("k2");
        }
    }

    @Test
    void nonRetryable4xxFiresHookWithRejectedReason() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/v1/ingest/batch", exchange -> {
            exchange.sendResponseHeaders(400, -1);
            exchange.close();
        });
        server.start();

        try {
            List<DropReason> reasons = new ArrayList<>();
            try (var client = new AforoClient(options()
                    .baseUrl("http://localhost:" + server.getAddress().getPort())
                    .onDrop((events, reason) -> reasons.add(reason)))) {

                client.track(TrackEvent.builder("cust_1", "api_calls").build());
                FlushResult result = client.flush();

                assertThat(result.failed()).isEqualTo(1);
                assertThat(client.droppedCount()).isEqualTo(1);
                assertThat(reasons).containsExactly(DropReason.REJECTED);
            }
        } finally {
            server.stop(0);
        }
    }

    @Test
    void defaultNoHookCountsDropsAndResultUnchanged() {
        try (var client = new AforoClient(options())) {
            client.track(TrackEvent.builder("cust_1", "api_calls").build());
            FlushResult result = client.flush();

            // Same result values as before the hardening
            assertThat(result.sent()).isEqualTo(0);
            assertThat(result.failed()).isEqualTo(1);
            assertThat(client.droppedCount()).isEqualTo(1);
        }
    }

    @Test
    void throwingHookNeverBreaksFlush() {
        try (var client = new AforoClient(options()
                .onDrop((events, reason) -> { throw new RuntimeException("hook bug"); }))) {

            client.track(TrackEvent.builder("cust_1", "api_calls").build());
            FlushResult result = client.flush();

            assertThat(result.failed()).isEqualTo(1);
            assertThat(client.droppedCount()).isEqualTo(1);
        }
    }

    @Test
    void happyPathUnchangedNoDrops() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/v1/ingest/batch", exchange -> {
            exchange.sendResponseHeaders(202, -1);
            exchange.close();
        });
        server.start();

        try {
            List<DropReason> reasons = new ArrayList<>();
            try (var client = new AforoClient(options()
                    .baseUrl("http://localhost:" + server.getAddress().getPort())
                    .onDrop((events, reason) -> reasons.add(reason)))) {

                client.track(TrackEvent.builder("cust_1", "api_calls").build());
                FlushResult result = client.flush();

                assertThat(result.sent()).isEqualTo(1);
                assertThat(result.failed()).isEqualTo(0);
                assertThat(client.droppedCount()).isEqualTo(0);
                assertThat(reasons).isEmpty();
            }
        } finally {
            server.stop(0);
        }
    }
}
