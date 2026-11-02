package com.aforo.metering;

import java.time.Instant;
import java.util.Map;
import java.util.logging.Logger;

/**
 * A usage event to track. Use the builder pattern for construction.
 */
public class TrackEvent {

    private static final Logger LOG = Logger.getLogger(TrackEvent.class.getName());

    private final String customerId;
    private final String metricName;
    private final double quantity;
    private final String idempotencyKey;
    private final String occurredAt;
    private final Map<String, Object> metadata;
    private final String executionStatus;
    private final String productType;
    private final String endpointPath;
    private final String httpMethod;
    private final Integer statusCode;
    private final Long responseTimeMs;

    private TrackEvent(Builder builder) {
        this.customerId = builder.customerId;
        this.metricName = builder.metricName;
        this.quantity = builder.quantity;
        this.idempotencyKey = builder.idempotencyKey;
        this.occurredAt = builder.occurredAt;
        this.metadata = builder.metadata;
        this.executionStatus = canonicalExecutionStatus(builder.executionStatus);
        this.productType = builder.productType;
        this.endpointPath = builder.endpointPath;
        this.httpMethod = builder.httpMethod;
        this.statusCode = builder.statusCode;
        this.responseTimeMs = builder.responseTimeMs;
    }

    /**
     * Canonical outcome statuses the ingestor accepts (contract/ingest-contract.json,
     * max 20 chars). Anything else would make it reject the event.
     */
    static final java.util.Set<String> ALLOWED_EXECUTION_STATUSES = java.util.Set.of(
            "SUCCESS", "PARTIAL", "TIMEOUT", "ERROR", "VALIDATION_FAILED", "FAILED",
            "FAILURE", "CANCELLED", "PENDING", "BLOCKED", "HITL_REQUIRED");

    /** Trim + upper-case; blank or {@code null} becomes {@code null} (omitted from the wire body). */
    static String normalizeExecutionStatus(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed.toUpperCase(java.util.Locale.ROOT);
    }

    /**
     * {@link #normalizeExecutionStatus} plus an allowlist check. An unknown value is
     * logged and returned as {@code null} so the field is left off the event — sending
     * it would make the ingestor reject the event, losing its usage.
     */
    static String canonicalExecutionStatus(String value) {
        String normalized = normalizeExecutionStatus(value);
        if (normalized == null || ALLOWED_EXECUTION_STATUSES.contains(normalized)) return normalized;
        LOG.warning("[aforo] Ignoring unknown executionStatus \"" + normalized + "\" — expected one of "
                + new java.util.TreeSet<>(ALLOWED_EXECUTION_STATUSES) + "; the event is sent without it.");
        return null;
    }

    public String getCustomerId() { return customerId; }
    public String getMetricName() { return metricName; }
    public double getQuantity() { return quantity; }
    public String getIdempotencyKey() { return idempotencyKey; }
    public String getOccurredAt() { return occurredAt; }
    public Map<String, Object> getMetadata() { return metadata; }
    /** Normalized (trimmed, upper-cased) execution status, or {@code null} when not set. */
    public String getExecutionStatus() { return executionStatus; }
    /** Per-event product type override, or {@code null} to use the client default. */
    public String getProductType() { return productType; }
    public String getEndpointPath() { return endpointPath; }
    public String getHttpMethod() { return httpMethod; }
    public Integer getStatusCode() { return statusCode; }
    public Long getResponseTimeMs() { return responseTimeMs; }

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
        private String executionStatus;
        private String productType;
        private String endpointPath;
        private String httpMethod;
        private Integer statusCode;
        private Long responseTimeMs;

        private Builder(String customerId, String metricName) {
            this.customerId = customerId;
            this.metricName = metricName;
        }

        /** Quantity; must be &gt; 0 (the ingestor rejects 0 and negatives). */
        public Builder quantity(double quantity) { this.quantity = quantity; return this; }
        public Builder idempotencyKey(String idempotencyKey) { this.idempotencyKey = idempotencyKey; return this; }
        /** ISO-8601 instant string, e.g. {@code 2026-09-22T10:00:00Z}. */
        public Builder occurredAt(String occurredAt) { this.occurredAt = occurredAt; return this; }
        public Builder occurredAt(Instant occurredAt) {
            this.occurredAt = occurredAt != null ? occurredAt.toString() : null; return this;
        }
        public Builder metadata(Map<String, Object> metadata) { this.metadata = metadata; return this; }
        /** Per-event product type; overrides {@link AforoOptions#productType(String)}. */
        public Builder productType(String productType) {
            this.productType = AforoOptions.normalizeProductType(productType); return this;
        }
        public Builder endpointPath(String endpointPath) { this.endpointPath = endpointPath; return this; }
        public Builder httpMethod(String httpMethod) { this.httpMethod = httpMethod; return this; }
        public Builder statusCode(Integer statusCode) { this.statusCode = statusCode; return this; }
        public Builder responseTimeMs(Long responseTimeMs) { this.responseTimeMs = responseTimeMs; return this; }

        /**
         * Optional outcome of the request, used by OUTCOME_BASED pricing (each event bills
         * at the weight set for its status; events without a status bill at full price).
         * Trimmed and upper-cased; blank is treated as absent. Accepted values: SUCCESS,
         * PARTIAL, TIMEOUT, ERROR, VALIDATION_FAILED, FAILED, FAILURE, CANCELLED, PENDING,
         * BLOCKED, HITL_REQUIRED (max 20 chars). Any other value is logged and left off
         * the event (the ingestor would otherwise reject the event).
         */
        public Builder executionStatus(String executionStatus) { this.executionStatus = executionStatus; return this; }

        public TrackEvent build() { return new TrackEvent(this); }
    }
}
