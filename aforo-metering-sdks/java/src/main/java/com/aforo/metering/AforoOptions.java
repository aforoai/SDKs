package com.aforo.metering;

/**
 * Configuration options for the Aforo metering client.
 */
public class AforoOptions {

    /** Production ingest endpoint. */
    public static final String DEFAULT_BASE_URL = "https://api.aforo.ai";
    /** Default product type stamped on every event that doesn't set its own. */
    public static final String DEFAULT_PRODUCT_TYPE = "API";
    /** Server-side maximum events per batch request. */
    public static final int MAX_BATCH_SIZE = 1000;

    private final String apiKey;
    private String baseUrl = DEFAULT_BASE_URL;
    private String productType = DEFAULT_PRODUCT_TYPE;
    private int flushCount = 50;
    private long flushIntervalMs = 5_000;
    private int maxQueueSize = 10_000;
    private int maxRetries = 3;
    private long retryBaseMs = 1_000;
    private long timeoutMs = 10_000;
    private long shutdownTimeoutMs = 5_000;

    public AforoOptions(String apiKey) {
        if (apiKey == null || apiKey.isBlank()) {
            throw new IllegalArgumentException("apiKey is required");
        }
        this.apiKey = apiKey;
    }

    public String getApiKey() { return apiKey; }
    public String getBaseUrl() { return baseUrl; }
    public String getProductType() { return productType; }
    public int getFlushCount() { return flushCount; }
    public long getFlushIntervalMs() { return flushIntervalMs; }
    public int getMaxQueueSize() { return maxQueueSize; }
    public int getMaxRetries() { return maxRetries; }
    public long getRetryBaseMs() { return retryBaseMs; }
    public long getTimeoutMs() { return timeoutMs; }
    public long getShutdownTimeoutMs() { return shutdownTimeoutMs; }

    public AforoOptions baseUrl(String baseUrl) { this.baseUrl = baseUrl; return this; }
    /**
     * Client-level product type sent as top-level {@code productType} on every event
     * (default {@code "API"}). One of API, AGENTIC_API, AI_AGENT, MCP_SERVER, GRPC_API,
     * GRAPHQL_API, WEBSOCKET_API, MQTT_BROKER. Trimmed and uppercased; unknown values are
     * passed through. A per-event {@link TrackEvent.Builder#productType(String)} wins.
     */
    public AforoOptions productType(String productType) {
        String normalized = normalizeProductType(productType);
        this.productType = normalized != null ? normalized : DEFAULT_PRODUCT_TYPE;
        return this;
    }
    public AforoOptions flushCount(int flushCount) { this.flushCount = flushCount; return this; }
    public AforoOptions flushIntervalMs(long flushIntervalMs) { this.flushIntervalMs = flushIntervalMs; return this; }
    public AforoOptions maxQueueSize(int maxQueueSize) { this.maxQueueSize = maxQueueSize; return this; }
    public AforoOptions maxRetries(int maxRetries) { this.maxRetries = maxRetries; return this; }
    public AforoOptions retryBaseMs(long retryBaseMs) { this.retryBaseMs = retryBaseMs; return this; }
    public AforoOptions timeoutMs(long timeoutMs) { this.timeoutMs = timeoutMs; return this; }
    public AforoOptions shutdownTimeoutMs(long shutdownTimeoutMs) { this.shutdownTimeoutMs = shutdownTimeoutMs; return this; }

    /** Trim + uppercase; {@code null} for null/blank. Unknown values pass through. */
    public static String normalizeProductType(String productType) {
        if (productType == null || productType.isBlank()) return null;
        return productType.trim().toUpperCase(java.util.Locale.ROOT);
    }
}
