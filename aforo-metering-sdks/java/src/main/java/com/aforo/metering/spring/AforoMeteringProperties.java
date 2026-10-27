package com.aforo.metering.spring;

/**
 * Spring Boot configuration properties for Aforo metering.
 */
public class AforoMeteringProperties {

    private String apiKey;
    private String baseUrl = "https://api.aforo.ai";
    /**
     * Top-level {@code productType} stamped on every event ({@code aforo.product-type}).
     * Default {@code API}; e.g. {@code AGENTIC_API}.
     */
    private String productType = "API";
    private int flushCount = 500;
    private long flushIntervalMs = 5_000;

    /**
     * Metric recorded for each request by the servlet filter. Must exist in the
     * tenant's Aforo catalog -- the ingestor rejects unknown metrics and fails the
     * whole batch. For a per-request metric, declare a
     * {@link AforoServletFilter.MetricNameResolver} bean.
     */
    private String metricName = AforoServletFilter.DEFAULT_METRIC_NAME;

    /**
     * Header carrying the Aforo customer id, read only with {@code trust-customer-header=true}.
     * Prefer an {@link AforoServletFilter.CustomerIdResolver} bean.
     */
    private String customerIdHeader = AforoServletFilter.DEFAULT_CUSTOMER_ID_HEADER;

    /** Use the authenticated principal's name as the customer id. Off by default. */
    private boolean usePrincipalAsCustomerId = false;

    /**
     * Read the customer id from {@link #customerIdHeader}. Off by default: callers of your
     * API control that header. Turn it on only when a gateway in front of the app sets it.
     */
    private boolean trustCustomerHeader = false;

    /** Queue capacity; overflow evicts the oldest event. */
    private int maxQueueSize = 10_000;

    /** Total deadline of one ingest request. */
    private long timeoutMs = 10_000;

    /** How long Spring's stop phase keeps sending queued events. */
    private long shutdownTimeoutMs = 5_000;

    /** Allow plain http:// on a host other than localhost. Off by default. */
    private boolean allowInsecureHttp = false;

    public String getApiKey() { return apiKey; }
    public void setApiKey(String apiKey) { this.apiKey = apiKey; }

    public String getBaseUrl() { return baseUrl; }
    public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl; }

    public String getProductType() { return productType; }
    public void setProductType(String productType) { this.productType = productType; }

    public int getFlushCount() { return flushCount; }
    public void setFlushCount(int flushCount) { this.flushCount = flushCount; }

    public long getFlushIntervalMs() { return flushIntervalMs; }
    public void setFlushIntervalMs(long flushIntervalMs) { this.flushIntervalMs = flushIntervalMs; }

    public String getMetricName() { return metricName; }
    public void setMetricName(String metricName) { this.metricName = metricName; }

    public String getCustomerIdHeader() { return customerIdHeader; }
    public void setCustomerIdHeader(String customerIdHeader) { this.customerIdHeader = customerIdHeader; }

    public boolean isUsePrincipalAsCustomerId() { return usePrincipalAsCustomerId; }
    public void setUsePrincipalAsCustomerId(boolean usePrincipalAsCustomerId) {
        this.usePrincipalAsCustomerId = usePrincipalAsCustomerId;
    }

    public boolean isTrustCustomerHeader() { return trustCustomerHeader; }
    public void setTrustCustomerHeader(boolean trustCustomerHeader) { this.trustCustomerHeader = trustCustomerHeader; }

    public int getMaxQueueSize() { return maxQueueSize; }
    public void setMaxQueueSize(int maxQueueSize) { this.maxQueueSize = maxQueueSize; }

    public long getTimeoutMs() { return timeoutMs; }
    public void setTimeoutMs(long timeoutMs) { this.timeoutMs = timeoutMs; }

    public long getShutdownTimeoutMs() { return shutdownTimeoutMs; }
    public void setShutdownTimeoutMs(long shutdownTimeoutMs) { this.shutdownTimeoutMs = shutdownTimeoutMs; }

    public boolean isAllowInsecureHttp() { return allowInsecureHttp; }
    public void setAllowInsecureHttp(boolean allowInsecureHttp) { this.allowInsecureHttp = allowInsecureHttp; }

    /** The API key is never included. */
    @Override
    public String toString() {
        return "AforoMeteringProperties{baseUrl=" + baseUrl + ", apiKey=[redacted], productType=" + productType
                + ", metricName=" + metricName + "}";
    }
}
