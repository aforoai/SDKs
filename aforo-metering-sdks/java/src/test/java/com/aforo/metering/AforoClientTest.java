package com.aforo.metering;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@DisplayName("AforoClient — core client")
class AforoClientTest {

    private AforoOptions options() {
        return new AforoOptions("test-key")
                .baseUrl("http://localhost:19999") // No real server
                .flushCount(100)
                .flushIntervalMs(60_000) // Long to avoid background flushes
                .shutdownTimeoutMs(200)  // close() gives up quickly on the absent server
                .maxRetries(0);
    }

    @Test
    void requiresApiKey() {
        assertThatThrownBy(() -> new AforoOptions(""))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("apiKey is required");
    }

    @Test
    void trackBuffersEvent() {
        try (var client = new AforoClient(options())) {
            client.track(TrackEvent.builder("cust_1", "api_calls").build());
            assertThat(client.bufferedCount()).isEqualTo(1);
        }
    }

    @Test
    void trackWithMetadata() {
        try (var client = new AforoClient(options())) {
            client.track(TrackEvent.builder("cust_1", "ai_tokens")
                    .quantity(1500)
                    .metadata(Map.of("model", "gpt-4o"))
                    .build());
            assertThat(client.bufferedCount()).isEqualTo(1);
        }
    }

    @Test
    void trackWithCustomIdempotencyKey() {
        try (var client = new AforoClient(options())) {
            client.track(TrackEvent.builder("cust_1", "api_calls")
                    .idempotencyKey("my-key")
                    .build());
            assertThat(client.bufferedCount()).isEqualTo(1);
        }
    }

    @Test
    void autoKeysAreUniquePerTrackCall() {
        // No caller key = dedup opt-out. Two same-instant identical events must
        // get DISTINCT random keys (the old content-hash fallback collapsed
        // them — the H4 bug Aforo ingest fixed server-side in April 2026).
        String occurredAt = "2026-07-05T00:00:00Z";
        TrackEvent same1 = TrackEvent.builder("cust_1", "api_calls").occurredAt(occurredAt).build();
        TrackEvent same2 = TrackEvent.builder("cust_1", "api_calls").occurredAt(occurredAt).build();
        try (var client = new AforoClient(options())) {
            client.track(same1);
            client.track(same2);
            assertThat(client.bufferedCount()).isEqualTo(2);
        }
        // Random UUID fallback: unique even for identical fields + timestamps.
        assertThat(IdempotencyKeyGenerator.generateRandom())
                .isNotEqualTo(IdempotencyKeyGenerator.generateRandom());
    }

    /** G307: track() after close no longer throws; the event is counted and reported as CLOSED. */
    @Test
    void trackAfterCloseIsReportedAsClosedAndDoesNotThrow() {
        java.util.List<DropReason> reasons = new java.util.concurrent.CopyOnWriteArrayList<>();
        var client = new AforoClient(options().onDrop((events, reason) -> reasons.add(reason)));
        client.close();
        assertThat(client.isClosed()).isTrue();
        client.track(TrackEvent.builder("cust_1", "api_calls").build());
        assertThat(reasons).containsExactly(DropReason.CLOSED);
        assertThat(client.droppedCount()).isEqualTo(1);
    }

    /** G307: close() is bounded by shutdownTimeoutMs, and leftovers are reported as SHUTDOWN. */
    @Test
    void closeHonoursShutdownTimeoutAndReportsLeftovers() {
        java.util.List<DropReason> reasons = new java.util.concurrent.CopyOnWriteArrayList<>();
        var client = new AforoClient(options().shutdownTimeoutMs(300)
                .onDrop((events, reason) -> events.forEach(e -> reasons.add(reason))));
        client.track(TrackEvent.builder("cust_1", "api_calls").build());
        client.track(TrackEvent.builder("cust_2", "api_calls").build());
        long start = System.nanoTime();
        client.close();
        long tookMs = (System.nanoTime() - start) / 1_000_000;
        assertThat(tookMs).isLessThan(2_000);
        assertThat(reasons).containsExactly(DropReason.SHUTDOWN, DropReason.SHUTDOWN);
    }

    @Test
    void apiKeyIsNotInToString() {
        AforoOptions o = new AforoOptions("sk_live_do_not_print").baseUrl("http://localhost:19999").shutdownTimeoutMs(0);
        assertThat(o.toString()).doesNotContain("sk_live_do_not_print").contains("[redacted]");
        try (var client = new AforoClient(o)) {
            assertThat(client.toString()).doesNotContain("sk_live_do_not_print");
        }
    }

    /** G270: https is required except on loopback or with the explicit opt-in. */
    @Test
    void plainHttpBaseUrlIsRefusedForARemoteHost() {
        assertThatThrownBy(() -> new AforoClient(new AforoOptions("k").baseUrl("http://api.example.com")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("https");
        new AforoClient(new AforoOptions("k").baseUrl("http://api.example.com").allowInsecureHttp(true)
                .shutdownTimeoutMs(0)).close();
    }

    /** G269: 500 events per request by default. */
    @Test
    void defaultBatchIs500() {
        assertThat(new AforoOptions("k").getFlushCount()).isEqualTo(500);
        assertThat(new AforoOptions("k").getRetryBaseMs()).isEqualTo(500);
    }

    @Test
    void doubleCloseSafe() {
        var client = new AforoClient(options());
        client.close();
        client.close(); // No error
    }

    @Test
    void flushKeepsEventsQueuedDuringAnOutage() {
        try (var client = new AforoClient(options())) {
            client.track(TrackEvent.builder("cust_1", "api_calls").build());
            client.track(TrackEvent.builder("cust_2", "api_calls").build());

            // No server: the events stay queued with their keys, nothing is lost or counted as failed.
            FlushResult result = client.flush();
            assertThat(result.failed()).isZero();
            assertThat(client.bufferedCount()).isEqualTo(2);
            assertThat(client.droppedCount()).isZero();
        }
    }

    @Test
    void resolvedEventToMap() {
        var event = new ResolvedEvent("cust_1", "api_calls", 1, "key_1", "2026-03-21", null);
        Map<String, Object> map = event.toMap();
        assertThat(map).containsEntry("customerId", "cust_1");
        assertThat(map).containsEntry("metricName", "api_calls");
        assertThat(map).doesNotContainKey("metadata");
    }

    @Test
    void resolvedEventWithMetadata() {
        var event = new ResolvedEvent("cust_1", "api_calls", 1, "key_1", "2026-03-21",
                Map.of("region", "us-east-1"));
        Map<String, Object> map = event.toMap();
        assertThat(map).containsKey("metadata");
    }

    @Test
    void executionStatusNormalizedAndSerializedWhenSet() {
        TrackEvent event = TrackEvent.builder("cust_1", "api_calls").executionStatus("  timeout ").build();
        assertThat(event.getExecutionStatus()).isEqualTo("TIMEOUT");
        var resolved = new ResolvedEvent("cust_1", "api_calls", 1, "key_1", "2026-03-21", null,
                event.getExecutionStatus());
        assertThat(resolved.toMap()).containsEntry("executionStatus", "TIMEOUT");
    }

    @Test
    void executionStatusOmittedWhenAbsentOrBlank() {
        assertThat(TrackEvent.builder("cust_1", "api_calls").build().getExecutionStatus()).isNull();
        assertThat(TrackEvent.builder("cust_1", "api_calls").executionStatus("   ").build().getExecutionStatus()).isNull();
        var resolved = new ResolvedEvent("cust_1", "api_calls", 1, "key_1", "2026-03-21", null, null);
        assertThat(resolved.toMap()).doesNotContainKey("executionStatus");
    }

    @Test
    void executionStatusUnknownOrOverLengthOmitted() {
        assertThat(TrackEvent.builder("cust_1", "api_calls").executionStatus("delivered").build()
                .getExecutionStatus()).isNull();
        assertThat(TrackEvent.builder("cust_1", "api_calls").executionStatus("SUCCESS_BUT_WAY_TOO_LONG_FOR_IT").build()
                .getExecutionStatus()).isNull();
        assertThat(TrackEvent.builder("cust_1", "api_calls").executionStatus(" hitl_required ").build()
                .getExecutionStatus()).isEqualTo("HITL_REQUIRED");
    }
}
