package com.aforo.metering;

import java.util.Map;

/**
 * A usage event to track. Use the builder pattern for construction.
 */
public class TrackEvent {

    private final String customerId;
    private final String metricName;
    private final double quantity;
    private final String idempotencyKey;
    private final String occurredAt;
    private final Map<String, Object> metadata;

    private TrackEvent(Builder builder) {
        this.customerId = builder.customerId;
        this.metricName = builder.metricName;
        this.quantity = builder.quantity;
        this.idempotencyKey = builder.idempotencyKey;
        this.occurredAt = builder.occurredAt;
        this.metadata = builder.metadata;
    }

    public String getCustomerId() { return customerId; }
    public String getMetricName() { return metricName; }
    public double getQuantity() { return quantity; }
    public String getIdempotencyKey() { return idempotencyKey; }
    public String getOccurredAt() { return occurredAt; }
    public Map<String, Object> getMetadata() { return metadata; }

    public static Builder builder(String customerId, String metricName) {
        return new Builder(customerId, metricName);
    }

    public static class Builder {
        private final String customerId;
        private final String metricName;
        private double quantity = 1;
        private String idempotencyKey;
        private String occurredAt;
        private Map<String, Object> metadata;

        private Builder(String customerId, String metricName) {
            this.customerId = customerId;
            this.metricName = metricName;
        }

        public Builder quantity(double quantity) { this.quantity = quantity; return this; }
        public Builder idempotencyKey(String idempotencyKey) { this.idempotencyKey = idempotencyKey; return this; }
        public Builder occurredAt(String occurredAt) { this.occurredAt = occurredAt; return this; }
        public Builder metadata(Map<String, Object> metadata) { this.metadata = metadata; return this; }

        public TrackEvent build() { return new TrackEvent(this); }
    }
}
