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
    private final String executionStatus;
    private final String productType;
    private final String endpointPath;
    private final String httpMethod;
    private final Integer statusCode;
    private final Long responseTimeMs;

    public ResolvedEvent(String customerId, String metricName, double quantity,
                         String idempotencyKey, String occurredAt, Map<String, Object> metadata) {
        this(customerId, metricName, quantity, idempotencyKey, occurredAt, metadata, null,
                AforoOptions.DEFAULT_PRODUCT_TYPE, null, null, null, null);
    }

    /**
     * @param executionStatus already-normalized (trimmed, upper-cased) outcome status,
     *                        or {@code null} to omit it from the wire body
     */
    public ResolvedEvent(String customerId, String metricName, double quantity,
                         String idempotencyKey, String occurredAt, Map<String, Object> metadata,
                         String executionStatus) {
        this(customerId, metricName, quantity, idempotencyKey, occurredAt, metadata, executionStatus,
                AforoOptions.DEFAULT_PRODUCT_TYPE, null, null, null, null);
    }

    public ResolvedEvent(String customerId, String metricName, double quantity,
                         String idempotencyKey, String occurredAt, Map<String, Object> metadata,
                         String productType, String endpointPath, String httpMethod,
                         Integer statusCode, Long responseTimeMs) {
        this(customerId, metricName, quantity, idempotencyKey, occurredAt, metadata, null,
                productType, endpointPath, httpMethod, statusCode, responseTimeMs);
    }

    /**
     * @param executionStatus already-normalized (trimmed, upper-cased) outcome status,
     *                        or {@code null} to omit it from the wire body
     * @param productType     top-level product type; {@code null} becomes {@code "API"}
     */
    public ResolvedEvent(String customerId, String metricName, double quantity,
                         String idempotencyKey, String occurredAt, Map<String, Object> metadata,
                         String executionStatus,
                         String productType, String endpointPath, String httpMethod,
                         Integer statusCode, Long responseTimeMs) {
        this.customerId = customerId;
        this.metricName = metricName;
        this.quantity = quantity;
        this.idempotencyKey = idempotencyKey;
        this.occurredAt = occurredAt;
        this.metadata = metadata;
        this.executionStatus = executionStatus;
        this.productType = productType != null ? productType : AforoOptions.DEFAULT_PRODUCT_TYPE;
        this.endpointPath = endpointPath;
        this.httpMethod = httpMethod;
        this.statusCode = statusCode;
        this.responseTimeMs = responseTimeMs;
    }

    public String getCustomerId() { return customerId; }
    public String getMetricName() { return metricName; }
    public double getQuantity() { return quantity; }
    public String getIdempotencyKey() { return idempotencyKey; }
    public String getOccurredAt() { return occurredAt; }
    public Map<String, Object> getMetadata() { return metadata; }
    public String getExecutionStatus() { return executionStatus; }
    public String getProductType() { return productType; }
    public String getEndpointPath() { return endpointPath; }
    public String getHttpMethod() { return httpMethod; }
    public Integer getStatusCode() { return statusCode; }
    public Long getResponseTimeMs() { return responseTimeMs; }

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
        map.put("productType", productType);
        if (endpointPath != null) map.put("endpointPath", endpointPath);
        if (httpMethod != null) map.put("httpMethod", httpMethod);
        if (statusCode != null) map.put("statusCode", statusCode);
        if (responseTimeMs != null) map.put("responseTimeMs", responseTimeMs);
        if (metadata != null && !metadata.isEmpty()) {
            map.put("metadata", metadata);
        }
        if (executionStatus != null && !executionStatus.isEmpty()) {
            map.put("executionStatus", executionStatus);
        }
        return map;
    }
}
