package com.aforo.metering;

import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

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
    private int flushCount = 500;
    private long flushIntervalMs = 5_000;
    private int maxQueueSize = 10_000;
    private int maxRetries = 3;
    private long retryBaseMs = 500;
    private long timeoutMs = 10_000;
    private long shutdownTimeoutMs = 5_000;
    private long breakerCooldownMs = 5_000;
    private boolean allowInsecureHttp = false;
    private boolean registerShutdownHook = true;
    private BiConsumer<List<ResolvedEvent>, DropReason> onDrop;
    private Consumer<AforoError> onError;
    private BiConsumer<Map<String, Object>, List<ResolvedEvent>> onAccepted;

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
    public long getBreakerCooldownMs() { return breakerCooldownMs; }
    public boolean isAllowInsecureHttp() { return allowInsecureHttp; }
    public boolean isRegisterShutdownHook() { return registerShutdownHook; }
    public BiConsumer<List<ResolvedEvent>, DropReason> getOnDrop() { return onDrop; }
    public Consumer<AforoError> getOnError() { return onError; }
    public BiConsumer<Map<String, Object>, List<ResolvedEvent>> getOnAccepted() { return onAccepted; }

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
    /**
     * How long {@link AforoClient#close()} keeps sending queued events (default 5 s).
     * Each request in that window gets {@code min(timeoutMs, time left)}; events still
     * queued at the deadline are reported to {@link #onDrop} as {@link DropReason#SHUTDOWN}.
     */
    public AforoOptions shutdownTimeoutMs(long shutdownTimeoutMs) { this.shutdownTimeoutMs = shutdownTimeoutMs; return this; }

    /**
     * First pause after the ingestor stays unreachable through every retry (default 5 s,
     * doubling with full jitter up to 5 minutes). The failed batch stays queued during
     * the pause and is resent with the same idempotency keys.
     */
    public AforoOptions breakerCooldownMs(long breakerCooldownMs) { this.breakerCooldownMs = breakerCooldownMs; return this; }

    /**
     * Allow a plain {@code http://} base URL on a host other than localhost / 127.0.0.1 / ::1.
     * Off by default: the API key is sent with every request.
     */
    public AforoOptions allowInsecureHttp(boolean allowInsecureHttp) { this.allowInsecureHttp = allowInsecureHttp; return this; }

    /**
     * Register a JVM shutdown hook that calls {@link AforoClient#close()} (default {@code true}).
     * The Spring Boot auto-configuration turns it off and closes the client in Spring's
     * stop phase instead, so the two never race.
     */
    public AforoOptions registerShutdownHook(boolean registerShutdownHook) { this.registerShutdownHook = registerShutdownHook; return this; }

    /**
     * OPT-IN hook invoked with events the SDK is about to lose permanently
     * (queue overflow, non-retryable rejection, an event that breaks an ingestor
     * field limit — {@link DropReason#INVALID} — still queued at the shutdown
     * deadline, or tracked after close), so the
     * app can persist / alert / replay them. Dropped events keep their
     * idempotency keys — re-submitting them via track() after recovery is
     * dedup-safe. Default: none (drops are still counted in droppedCount()
     * and WARN-logged). Exceptions thrown by the hook are swallowed.
     */
    public AforoOptions onDrop(BiConsumer<List<ResolvedEvent>, DropReason> onDrop) { this.onDrop = onDrop; return this; }

    /**
     * OPT-IN hook for delivery problems, typed by {@link AforoError#kind()}: {@code OUTAGE}
     * and {@code AUTH} (events kept and resent), {@code REJECTED}, {@code SHUTDOWN},
     * {@code CLOSED} (events dropped). Runs on the background sender thread; it may call
     * {@code flush()} or {@code close()}. Exceptions are caught and logged.
     */
    public AforoOptions onError(Consumer<AforoError> onError) { this.onError = onError; return this; }

    /**
     * OPT-IN hook receiving the envelope-unwrapped body of every accepted (2xx) batch, for
     * fields such as {@code killedSessionIds}. The map is empty when the body was not a JSON
     * object. Runs on the background sender thread; exceptions are caught and logged.
     */
    public AforoOptions onAccepted(BiConsumer<Map<String, Object>, List<ResolvedEvent>> onAccepted) {
        this.onAccepted = onAccepted;
        return this;
    }

    /** The API key is never included. */
    @Override
    public String toString() {
        return "AforoOptions{baseUrl=" + baseUrl + ", apiKey=[redacted], productType=" + productType
                + ", flushCount=" + flushCount + ", flushIntervalMs=" + flushIntervalMs
                + ", maxQueueSize=" + maxQueueSize + ", maxRetries=" + maxRetries
                + ", timeoutMs=" + timeoutMs + ", shutdownTimeoutMs=" + shutdownTimeoutMs + "}";
    }

    /** Trim + uppercase; {@code null} for null/blank. Unknown values pass through. */
    public static String normalizeProductType(String productType) {
        if (productType == null || productType.isBlank()) return null;
        return productType.trim().toUpperCase(java.util.Locale.ROOT);
    }
}
