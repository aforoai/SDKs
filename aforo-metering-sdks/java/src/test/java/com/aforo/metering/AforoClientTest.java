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

    @Test
    void throwsAfterClose() {
        var client = new AforoClient(options());
        client.close();
        assertThat(client.isClosed()).isTrue();
        assertThatThrownBy(() -> client.track(
                TrackEvent.builder("cust_1", "api_calls").build()))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void doubleCloseSafe() {
        var client = new AforoClient(options());
        client.close();
        client.close(); // No error
    }

    @Test
    void flushDrainsBuffer() {
        try (var client = new AforoClient(options())) {
            client.track(TrackEvent.builder("cust_1", "api_calls").build());
            client.track(TrackEvent.builder("cust_2", "api_calls").build());

            // Flush will attempt HTTP but fail (no server) — events will be "failed"
            FlushResult result = client.flush();
            // Buffer should be drained regardless
            assertThat(client.bufferedCount()).isEqualTo(0);
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
