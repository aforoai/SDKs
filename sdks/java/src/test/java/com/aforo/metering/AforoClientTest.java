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
}
