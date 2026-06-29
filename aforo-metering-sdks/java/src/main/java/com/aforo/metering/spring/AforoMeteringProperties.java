package com.aforo.metering.spring;

/**
 * Spring Boot configuration properties for Aforo metering.
 */
public class AforoMeteringProperties {

    private String apiKey;
    private String baseUrl = "https://ingest.aforo.ai";
    private int flushCount = 50;
    private long flushIntervalMs = 5_000;

    public String getApiKey() { return apiKey; }
    public void setApiKey(String apiKey) { this.apiKey = apiKey; }

    public String getBaseUrl() { return baseUrl; }
    public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl; }

    public int getFlushCount() { return flushCount; }
    public void setFlushCount(int flushCount) { this.flushCount = flushCount; }

    public long getFlushIntervalMs() { return flushIntervalMs; }
    public void setFlushIntervalMs(long flushIntervalMs) { this.flushIntervalMs = flushIntervalMs; }
}
