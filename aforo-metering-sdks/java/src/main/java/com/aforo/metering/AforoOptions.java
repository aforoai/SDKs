package com.aforo.metering;

/**
 * Configuration options for the Aforo metering client.
 */
public class AforoOptions {

    private final String apiKey;
    private String baseUrl = "https://ingest.aforo.ai";
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
    public int getFlushCount() { return flushCount; }
    public long getFlushIntervalMs() { return flushIntervalMs; }
    public int getMaxQueueSize() { return maxQueueSize; }
    public int getMaxRetries() { return maxRetries; }
    public long getRetryBaseMs() { return retryBaseMs; }
    public long getTimeoutMs() { return timeoutMs; }
    public long getShutdownTimeoutMs() { return shutdownTimeoutMs; }

    public AforoOptions baseUrl(String baseUrl) { this.baseUrl = baseUrl; return this; }
    public AforoOptions flushCount(int flushCount) { this.flushCount = flushCount; return this; }
    public AforoOptions flushIntervalMs(long flushIntervalMs) { this.flushIntervalMs = flushIntervalMs; return this; }
    public AforoOptions maxQueueSize(int maxQueueSize) { this.maxQueueSize = maxQueueSize; return this; }
    public AforoOptions maxRetries(int maxRetries) { this.maxRetries = maxRetries; return this; }
    public AforoOptions retryBaseMs(long retryBaseMs) { this.retryBaseMs = retryBaseMs; return this; }
    public AforoOptions timeoutMs(long timeoutMs) { this.timeoutMs = timeoutMs; return this; }
    public AforoOptions shutdownTimeoutMs(long shutdownTimeoutMs) { this.shutdownTimeoutMs = shutdownTimeoutMs; return this; }
}
