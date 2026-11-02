package com.aforo.metering;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The core client against the shared fault-injecting mock ingestor (wave 5, G312):
 * outage and recovery, 429 with both Retry-After forms, a hung response, the shutdown
 * deadline, per-event retryable failures, overflow while the breaker is open, and a
 * single request in flight.
 */
@DisplayName("AforoClient — against the mock ingestor")
class MockIngestorIntegrationTest {

    private static MockIngestor mock;
    private final List<ResolvedEvent> dropped = new CopyOnWriteArrayList<>();
    private final List<DropReason> reasons = new CopyOnWriteArrayList<>();

    @BeforeAll
    static void startMock() throws Exception {
        mock = MockIngestor.start();
    }

    @AfterAll
    static void stopMock() throws Exception {
        if (mock != null) mock.close();
    }

    @BeforeEach
    void reset() throws Exception {
        mock.reset();
    }

    private AforoOptions options() {
        return new AforoOptions("sk_test_mock")
                .baseUrl(mock.url)
                .flushCount(10)
                .flushIntervalMs(60_000)
                .retryBaseMs(10)
                .maxRetries(1)
                .breakerCooldownMs(100)
                .timeoutMs(2_000)
                .shutdownTimeoutMs(2_000)
                .onDrop((events, reason) -> {
                    dropped.addAll(events);
                    events.forEach(e -> reasons.add(reason));
                });
    }

    private static TrackEvent event(String key) {
        return TrackEvent.builder("cust_1", "api_calls").idempotencyKey(key).build();
    }

    private static List<Long> requestTimes(JsonNode state) {
        List<Long> out = new ArrayList<>();
        state.get("requests").forEach(r -> out.add(Instant.parse(r.get("at").asText()).toEpochMilli()));
        return out;
    }

    @Test
    void outageThenRecoveryLosesNothingAndKeepsTheKeys() throws Exception {
        mock.faults("[{\"status\":503,\"times\":-1}]");
        try (var client = new AforoClient(options())) {
            for (int i = 0; i < 5; i++) client.track(event("k" + i));
            FlushResult during = client.flush();
            assertThat(during.failed()).isZero();
            assertThat(client.bufferedCount()).isEqualTo(5);

            mock.clearFaults();
            MockIngestor.await("all events accepted", 10_000,
                    () -> mock.stateQuietly().get("acceptedCount").asInt() == 5);
        }
        JsonNode state = mock.state();
        Set<String> expected = Set.of("k0", "k1", "k2", "k3", "k4");
        int failedAttempts = 0;
        for (JsonNode r : state.get("requests")) {
            if (r.get("status").asInt() == 503) {
                failedAttempts++;
                continue; // the mock answers an injected fault before reading the events
            }
            Set<String> keys = new HashSet<>();
            r.get("idempotencyKeys").forEach(k -> keys.add(k.asText()));
            assertThat(keys).isEqualTo(expected); // the recovered send carries the original keys
        }
        assertThat(failedAttempts).isGreaterThanOrEqualTo(2);
        assertThat(state.get("uniqueKeys").asInt()).isEqualTo(5);
        assertThat(reasons).isEmpty();
    }

    @Test
    void retryAfterDeltaSecondsIsHonoured() throws Exception {
        mock.faults("[{\"status\":429,\"retryAfter\":\"1\"}]");
        try (var client = new AforoClient(options())) {
            client.track(event("ra-delta"));
            client.flush();
        }
        List<Long> at = requestTimes(mock.state());
        assertThat(at).hasSize(2);
        assertThat(at.get(1) - at.get(0)).isGreaterThanOrEqualTo(900);
        assertThat(mock.state().get("acceptedCount").asInt()).isEqualTo(1);
    }

    @Test
    void retryAfterHttpDateIsHonoured() throws Exception {
        String date = DateTimeFormatter.RFC_1123_DATE_TIME.format(
                ZonedDateTime.now(ZoneOffset.UTC).plusSeconds(2));
        mock.faults("[{\"status\":429,\"retryAfter\":\"" + date + "\"}]");
        try (var client = new AforoClient(options())) {
            client.track(event("ra-date"));
            client.flush();
        }
        List<Long> at = requestTimes(mock.state());
        assertThat(at).hasSize(2);
        assertThat(at.get(1) - at.get(0)).isGreaterThanOrEqualTo(900);
        assertThat(mock.state().get("acceptedCount").asInt()).isEqualTo(1);
    }

    @Test
    void aHungResponseTimesOutAndIsRetried() throws Exception {
        mock.faults("[{\"hang\":true}]");
        long start = System.nanoTime();
        try (var client = new AforoClient(options().timeoutMs(300))) {
            client.track(event("hung"));
            FlushResult r = client.flush();
            assertThat(r.sent()).isEqualTo(1);
        }
        assertThat((System.nanoTime() - start) / 1_000_000).isLessThan(5_000);
        JsonNode state = mock.state();
        assertThat(state.get("requests").get(0).get("status").asInt()).isEqualTo(-2);
        assertThat(state.get("acceptedCount").asInt()).isEqualTo(1);
    }

    @Test
    void closeStopsAtTheShutdownDeadlineAndReportsLeftovers() throws Exception {
        mock.faults("[{\"hang\":true,\"times\":-1}]");
        var client = new AforoClient(options().timeoutMs(10_000).shutdownTimeoutMs(500));
        client.track(event("s1"));
        client.track(event("s2"));
        client.track(event("s3"));
        long start = System.nanoTime();
        client.close();
        long took = (System.nanoTime() - start) / 1_000_000;
        assertThat(took).isLessThan(2_500);
        assertThat(reasons).containsOnly(DropReason.SHUTDOWN).hasSize(3);
        assertThat(dropped).extracting(ResolvedEvent::getIdempotencyKey).containsExactly("s1", "s2", "s3");
        mock.clearFaults();
    }

    @Test
    void perEventRetryableFailuresAreResent() throws Exception {
        mock.faults("[{\"perEvent\":[{\"index\":0,\"message\":\"busy\",\"retryable\":true},"
                + "{\"index\":1,\"message\":\"bad\",\"retryable\":false}]}]");
        try (var client = new AforoClient(options())) {
            client.track(event("p0"));
            client.track(event("p1"));
            client.track(event("p2"));
            client.flush();
            MockIngestor.await("retryable event resent", 10_000,
                    () -> mock.stateQuietly().get("acceptedCount").asInt() == 2);
        }
        assertThat(reasons).containsExactly(DropReason.REJECTED);
        assertThat(dropped).extracting(ResolvedEvent::getIdempotencyKey).containsExactly("p1");
    }

    @Test
    void overflowWhileTheBreakerIsOpenDropsTheOldest() throws Exception {
        mock.faults("[{\"status\":503,\"times\":-1}]");
        var client = new AforoClient(options().maxQueueSize(3).maxRetries(0).breakerCooldownMs(60_000)
                .shutdownTimeoutMs(0));
        client.track(event("o1"));
        client.flush();
        client.track(event("o2"));
        client.track(event("o3"));
        client.track(event("o4"));
        assertThat(reasons).containsExactly(DropReason.OVERFLOW);
        assertThat(dropped).extracting(ResolvedEvent::getIdempotencyKey).containsExactly("o1");
        client.close();
        mock.clearFaults();
    }

    @Test
    void onlyOneRequestIsEverInFlight() throws Exception {
        try (var client = new AforoClient(options().flushCount(100).maxQueueSize(50_000))) {
            List<Thread> threads = new ArrayList<>();
            for (int t = 0; t < 4; t++) {
                int n = t;
                Thread th = new Thread(() -> {
                    for (int i = 0; i < 750; i++) client.track(event("t" + n + "-" + i));
                });
                threads.add(th);
                th.start();
            }
            for (Thread th : threads) th.join();
            client.flush();
        }
        JsonNode state = mock.state();
        assertThat(state.get("acceptedCount").asInt()).isEqualTo(3_000);
        assertThat(state.get("maxInFlight").asInt()).isEqualTo(1);
        assertThat(reasons).isEmpty();
    }
}
