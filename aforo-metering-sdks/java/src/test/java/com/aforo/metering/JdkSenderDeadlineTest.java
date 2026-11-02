package com.aforo.metering;

import com.aforo.metering.internal.transport.HttpSender;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.URI;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The JDK sender against the mock ingestor: the request deadline covers reading the
 * body (a stalled or dripping 202 is cut off), and redirects are never followed.
 */
@DisplayName("HttpSender.jdk — total deadline and no redirects")
class JdkSenderDeadlineTest {

    private static MockIngestor mock;
    private static final String BODY = "{\"events\":[{\"customerId\":\"c\",\"metricName\":\"m\",\"quantity\":1,"
            + "\"idempotencyKey\":\"k1\",\"occurredAt\":\"2026-10-26T00:00:00Z\"}]}";
    private static final Map<String, String> HEADERS = Map.of("Content-Type", "application/json",
            "X-API-Key", "sk_test_mock");

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

    private URI ingest() {
        return URI.create(mock.url + "/v1/ingest/batch");
    }

    private static long elapsedMs(long t0) {
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0);
    }

    @Test
    void aStalledBodyIsCutOffAtTheDeadline() throws Exception {
        mock.faults("[{\"stallBody\":true}]");
        try (HttpSender s = HttpSender.jdk(1_000)) {
            long t0 = System.nanoTime();
            assertThatThrownBy(() -> s.post(ingest(), HEADERS, BODY, 700)).isInstanceOf(IOException.class);
            assertThat(elapsedMs(t0)).isLessThan(700 + 1_500);
        }
    }

    @Test
    void aDrippingBodyIsCutOffAtTheDeadline() throws Exception {
        mock.faults("[{\"dripMs\":100}]");
        try (HttpSender s = HttpSender.jdk(1_000)) {
            long t0 = System.nanoTime();
            assertThatThrownBy(() -> s.post(ingest(), HEADERS, BODY, 700)).isInstanceOf(IOException.class);
            assertThat(elapsedMs(t0)).isLessThan(700 + 1_500);
        }
    }

    @Test
    void aRedirectIsReturnedNotFollowed() throws Exception {
        mock.faults("[{\"status\":307,\"location\":\"" + mock.url + "/api/v1/ingest/batch\"}]");
        try (HttpSender s = HttpSender.jdk(1_000)) {
            HttpSender.Response r = s.post(ingest(), HEADERS, BODY, 2_000);
            assertThat(r.status()).isEqualTo(307);
            assertThat(r.location()).endsWith("/api/v1/ingest/batch");
        }
        assertThat(mock.state().get("requests")).hasSize(1);
    }
}
