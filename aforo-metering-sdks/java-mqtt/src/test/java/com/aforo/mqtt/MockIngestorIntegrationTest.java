package com.aforo.mqtt;

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
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * AforoMqttBilling on the wave 5 transport core against the shared fault-injecting mock
 * ingestor (G312): outage and recovery, retryable events keep their keys, 429 with both
 * Retry-After forms, a hung response, the shutdown deadline, one request in flight, and a
 * Turkish default locale (G311).
 */
@DisplayName("AforoMqttBilling — against the mock ingestor")
class MockIngestorIntegrationTest {

    private static MockIngestor mock;
    private final List<Map<String, Object>> dropped = new CopyOnWriteArrayList<>();
    private final List<AforoMqttBilling.DropReason> reasons = new CopyOnWriteArrayList<>();

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

    private AforoMqttBilling.Builder builder() {
        return AforoMqttBilling.newBuilder()
                .tenantId("tenant-mock")
                .productId("prod-mock")
                .apiKey("sk_test_mock")
                .ingestorUrl(mock.url)
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

    private static void record(AforoMqttBilling b, String customerId) {
        b.recordPublish(customerId, "client-1", "sensors/temp", 1, false, 42);
    }

    private static int accepted() {
        return mock.stateQuietly().get("acceptedCount").asInt();
    }

    private static List<Long> requestTimes(JsonNode state) {
        List<Long> out = new ArrayList<>();
        state.get("requests").forEach(r -> out.add(Instant.parse(r.get("at").asText()).toEpochMilli()));
        return out;
    }

    @Test
    void outageThenRecoveryLosesNothing() throws Exception {
        mock.faults("[{\"status\":503,\"times\":-1}]");
        try (AforoMqttBilling b = builder().flushCount(5).build()) {
            for (int i = 0; i < 5; i++) record(b, "cust_" + i);
            MockIngestor.await("failed attempts", 10_000, () -> mock.stateQuietly().get("requests").size() >= 4);
            assertThat(b.bufferedCount()).isEqualTo(5);
            mock.clearFaults();
            MockIngestor.await("all events accepted", 10_000, () -> accepted() == 5);
        }
        assertThat(mock.state().get("uniqueKeys").asInt()).isEqualTo(5);
        assertThat(reasons).isEmpty();
    }

    @Test
    void retryableEventsAreResentWithTheSameKey() throws Exception {
        mock.faults("[{\"perEvent\":[{\"index\":0,\"message\":\"busy\",\"retryable\":true}]}]");
        try (AforoMqttBilling b = builder().flushCount(2).build()) {
            record(b, "cust_a");
            record(b, "cust_b");
            MockIngestor.await("both accepted", 10_000, () -> accepted() == 2);
        }
        JsonNode requests = mock.state().get("requests");
        assertThat(requests.get(1).get("eventCount").asInt()).isEqualTo(1);
        assertThat(requests.get(1).get("idempotencyKeys").get(0).asText())
                .isEqualTo(requests.get(0).get("idempotencyKeys").get(0).asText());
        assertThat(reasons).isEmpty();
    }

    @Test
    void retryAfterDeltaSecondsIsHonoured() throws Exception {
        mock.faults("[{\"status\":429,\"retryAfter\":\"1\"}]");
        try (AforoMqttBilling b = builder().flushCount(1).build()) {
            record(b, "cust_1");
            MockIngestor.await("accepted after Retry-After", 10_000, () -> accepted() == 1);
        }
        List<Long> at = requestTimes(mock.state());
        assertThat(at.get(1) - at.get(0)).isGreaterThanOrEqualTo(900);
    }

    @Test
    void retryAfterHttpDateIsHonoured() throws Exception {
        String date = DateTimeFormatter.RFC_1123_DATE_TIME.format(ZonedDateTime.now(ZoneOffset.UTC).plusSeconds(2));
        mock.faults("[{\"status\":429,\"retryAfter\":\"" + date + "\"}]");
        try (AforoMqttBilling b = builder().flushCount(1).build()) {
            record(b, "cust_1");
            MockIngestor.await("accepted after Retry-After", 10_000, () -> accepted() == 1);
        }
        List<Long> at = requestTimes(mock.state());
        assertThat(at.get(1) - at.get(0)).isGreaterThanOrEqualTo(900);
    }

    @Test
    void aHungResponseTimesOutAndIsRetried() throws Exception {
        mock.faults("[{\"hang\":true}]");
        try (AforoMqttBilling b = builder().timeoutMs(300).flushCount(1).build()) {
            record(b, "cust_1");
            MockIngestor.await("accepted after the timeout", 10_000, () -> accepted() == 1);
        }
        assertThat(mock.state().get("requests").get(0).get("status").asInt()).isEqualTo(-2);
    }

    @Test
    void closeStopsAtTheShutdownDeadlineAndReportsLeftovers() throws Exception {
        mock.faults("[{\"hang\":true,\"times\":-1}]");
        AforoMqttBilling b = builder().timeoutMs(10_000).shutdownTimeoutMs(500).flushCount(100).build();
        record(b, "cust_1");
        record(b, "cust_2");
        record(b, "cust_3");
        long start = System.nanoTime();
        b.close();
        assertThat((System.nanoTime() - start) / 1_000_000).isLessThan(2_500);
        assertThat(reasons).hasSize(3).containsOnly(AforoMqttBilling.DropReason.SHUTDOWN);
        assertThat(dropped).allSatisfy(e -> assertThat(e.get("idempotencyKey")).isNotNull());
        mock.clearFaults();
    }

    @Test
    void onlyOneRequestIsEverInFlight() throws Exception {
        try (AforoMqttBilling b = builder().flushCount(50).maxQueueSize(50_000).build()) {
            List<Thread> threads = new ArrayList<>();
            for (int t = 0; t < 4; t++) {
                int n = t;
                Thread th = new Thread(() -> {
                    for (int i = 0; i < 300; i++) record(b, "cust_" + n + "_" + i);
                });
                threads.add(th);
                th.start();
            }
            for (Thread th : threads) th.join();
        }
        JsonNode state = mock.state();
        assertThat(state.get("acceptedCount").asInt()).isEqualTo(1_200);
        assertThat(state.get("maxInFlight").asInt()).isEqualTo(1);
        assertThat(reasons).isEmpty();
    }

    /** G311: wire values must not change under a Turkish default locale (dotless i). */
    @Test
    void turkishDefaultLocaleDoesNotChangeWireValues() throws Exception {
        Locale saved = Locale.getDefault();
        Locale.setDefault(Locale.forLanguageTag("tr-TR"));
        try {
        try (AforoMqttBilling b = builder().flushCount(1).build()) {
            b.recordPublish("cust_tr", "client-1", "sensors/temp", 1, false, 42);
            b.recordSubscribe("cust_tr", "client-1", "sensors/#", 1);
            MockIngestor.await("events", 10_000, () -> mock.stateQuietly().get("acceptedCount").asInt() == 2);
        }
        List<String> metrics = new ArrayList<>();
        mock.state().get("events").forEach(e -> metrics.add(e.get("metricName").asText()));
        assertThat(metrics).containsExactlyInAnyOrder("mqtt_broker.publish", "mqtt_broker.subscribe");
        } finally {
            Locale.setDefault(saved);
        }
    }
}
