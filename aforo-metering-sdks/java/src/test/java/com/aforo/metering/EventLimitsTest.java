package com.aforo.metering;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The ingestor's compiled-in field limits. An event that breaks one is rejected
 * server-side and never billed; since the SDK flushes in the background, that
 * rejection reaches nobody, so the event is dropped here with a warning instead.
 */
@DisplayName("EventLimits — the ingestor's compiled-in field constraints")
class EventLimitsTest {

    private String violation(String customerId, String metricName, double quantity) {
        return EventLimits.describeViolation(customerId, metricName, "key-1", "API", quantity);
    }

    @Test
    @DisplayName("an event within every limit has no violation")
    void validEventPasses() {
        assertThat(violation("cust_1", "api_calls", 1)).isNull();
    }

    @Test
    @DisplayName("customerId at 64 passes, 65 is reported with field and limit")
    void customerIdLength() {
        assertThat(violation("c".repeat(64), "api_calls", 1)).isNull();
        assertThat(violation("c".repeat(65), "api_calls", 1))
                .contains("customerId").contains("65").contains("64");
    }

    @Test
    @DisplayName("metricName at 255 passes, 256 is reported")
    void metricNameLength() {
        assertThat(violation("cust_1", "m".repeat(255), 1)).isNull();
        assertThat(violation("cust_1", "m".repeat(256), 1)).contains("metricName");
    }

    @Test
    @DisplayName("idempotencyKey over 255 is reported")
    void idempotencyKeyLength() {
        assertThat(EventLimits.describeViolation("cust_1", "api_calls", "k".repeat(256), "API", 1))
                .contains("idempotencyKey");
    }

    @Test
    @DisplayName("6 decimal places pass; 7 are rejected rather than rounded")
    void quantityDecimalPlaces() {
        assertThat(violation("cust_1", "api_calls", 1.123456)).isNull();
        assertThat(violation("cust_1", "api_calls", 1.1234567))
                .contains("decimal places")
                .as("rounding would change what the customer is billed")
                .contains("will not round it");
    }

    @Test
    @DisplayName("more than 14 integer digits is rejected")
    void quantityIntegerDigits() {
        assertThat(violation("cust_1", "api_calls", 1e15)).contains("integer digits");
    }

    @Test
    @DisplayName("NaN and infinity are left to the caller's own quantity check")
    void nonFiniteLeftAlone() {
        assertThat(violation("cust_1", "api_calls", Double.NaN)).isNull();
        assertThat(violation("cust_1", "api_calls", Double.POSITIVE_INFINITY)).isNull();
    }
}
