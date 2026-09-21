package com.aforo.metering.spring;

/**
 * Spring Boot configuration properties for Aforo metering.
 */
public class AforoMeteringProperties {

    private String apiKey;
    private String baseUrl = "https://ingest.aforo.ai";
    private int flushCount = 50;
    private long flushIntervalMs = 5_000;

    /**
     * Metric recorded for each request by the servlet filter. Must exist in the
     * tenant's Aforo catalog -- the ingestor rejects unknown metrics and fails the
     * whole batch. For a per-request metric, declare a
     * {@link AforoServletFilter.MetricNameResolver} bean.
     */
    private String metricName = AforoServletFilter.DEFAULT_METRIC_NAME;

    /**
     * Header carrying the Aforo customer id. For anything else, declare a
     * {@link AforoServletFilter.CustomerIdResolver} bean.
     */
    private String customerIdHeader = AforoServletFilter.DEFAULT_CUSTOMER_ID_HEADER;

    /** Use the authenticated principal's name as the customer id. Off by default. */
    private boolean usePrincipalAsCustomerId = false;

    public String getApiKey() { return apiKey; }
    public void setApiKey(String apiKey) { this.apiKey = apiKey; }

    public String getBaseUrl() { return baseUrl; }
    public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl; }

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
}
