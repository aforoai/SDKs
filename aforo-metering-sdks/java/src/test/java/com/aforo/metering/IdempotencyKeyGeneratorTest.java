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

    @Test
    void randomKeyIsUuid() {
        String key = IdempotencyKeyGenerator.generateRandom();
        assertThat(key).matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    }
}
