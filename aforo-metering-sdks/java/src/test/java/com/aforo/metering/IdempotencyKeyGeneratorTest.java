package com.aforo.metering;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("IdempotencyKeyGenerator")
class IdempotencyKeyGeneratorTest {

    @Test
    void deterministic() {
        String k1 = IdempotencyKeyGenerator.generate("cust_1", "api_calls", 1, "2026-03-21");
        String k2 = IdempotencyKeyGenerator.generate("cust_1", "api_calls", 1, "2026-03-21");
        assertThat(k1).isEqualTo(k2);
    }

    @Test
    void differentInputs() {
        String k1 = IdempotencyKeyGenerator.generate("cust_1", "api_calls", 1, "2026-03-21");
        String k2 = IdempotencyKeyGenerator.generate("cust_2", "api_calls", 1, "2026-03-21");
        assertThat(k1).isNotEqualTo(k2);
    }

    @Test
    void produces32HexChars() {
        String key = IdempotencyKeyGenerator.generate("cust_1", "metric", 5, "2026-01-01");
        assertThat(key).hasSize(32).matches("[0-9a-f]{32}");
    }

    /**
     * Documents WHY generate(...) is no longer the client default: occurredAt only
     * carries millisecond precision, so two genuinely distinct events in one millisecond
     * hash to one key and the ingestor drops the second as a DUPLICATE. Callers who want
     * that dedup opt in via TrackEvent.Builder.idempotencyKey(...).
     */
    @Test
    void collidesWithinOneMillisecond() {
        String sameMs = "2026-03-21T00:00:00.000Z";
        assertThat(IdempotencyKeyGenerator.generate("cust_1", "sms.sent", 1, sameMs))
                .isEqualTo(IdempotencyKeyGenerator.generate("cust_1", "sms.sent", 1, sameMs));
    }

    @Test
    void randomKeysAreUnique() {
        assertThat(IdempotencyKeyGenerator.generateRandom())
                .isNotEqualTo(IdempotencyKeyGenerator.generateRandom());
    }

    @Test
    void randomKeyIsUuid() {
        String key = IdempotencyKeyGenerator.generateRandom();
        assertThat(key).matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    }
}
