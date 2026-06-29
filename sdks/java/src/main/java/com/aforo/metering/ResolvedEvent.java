package com.aforo.metering;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Internal event with all fields resolved and ready for serialization.
 */
public class ResolvedEvent {

    private final String customerId;
    private final String metricName;
    private final double quantity;
    private final String idempotencyKey;
    private final String occurredAt;
    private final Map<String, Object> metadata;

    public ResolvedEvent(String customerId, String metricName, double quantity,
                         String idempotencyKey, String occurredAt, Map<String, Object> metadata) {
        this.customerId = customerId;
        this.metricName = metricName;
        this.quantity = quantity;
        this.idempotencyKey = idempotencyKey;
        this.occurredAt = occurredAt;
        this.metadata = metadata;
    }

    public String getCustomerId() { return customerId; }
    public String getMetricName() { return metricName; }
    public double getQuantity() { return quantity; }
    public String getIdempotencyKey() { return idempotencyKey; }
    public String getOccurredAt() { return occurredAt; }
    public Map<String, Object> getMetadata() { return metadata; }

    /**
     * Convert to a JSON-friendly map with camelCase keys matching the Aforo ingestor API.
     */
    public Map<String, Object> toMap() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("customerId", customerId);
        map.put("metricName", metricName);
        map.put("quantity", quantity);
        map.put("idempotencyKey", idempotencyKey);
        map.put("occurredAt", occurredAt);
        if (metadata != null && !metadata.isEmpty()) {
            map.put("metadata", metadata);
        }
        return map;
    }
}
