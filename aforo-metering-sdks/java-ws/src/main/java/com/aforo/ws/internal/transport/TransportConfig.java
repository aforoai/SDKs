package com.aforo.ws.internal.transport;

import java.net.URI;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Settings of one transport core. Defaults are the numbers in
 * {@code contract/ingest-contract.json → transportPolicy}; see
 * {@code contract/TRANSPORT-SPEC.md} for what each one means.
 *
 * <p>The API key never appears in {@link #toString()}.</p>
 *
 * <p>This file is the transport core. Edit it in the {@code java} module only and
 * run {@code scripts/sync-transport.sh java}; the variants carry copies.</p>
 */
public final class TransportConfig {

    public static final String INGEST_PATH = "/v1/ingest/batch";
    public static final int MAX_EVENTS_PER_REQUEST = 1000;
    public static final int DEFAULT_FLUSH_COUNT = 500;
    public static final int DEFAULT_QUEUE_CAPACITY = 10_000;
    public static final long DEFAULT_FLUSH_INTERVAL_MS = 5_000;
    public static final long DEFAULT_TIMEOUT_MS = 10_000;
    public static final long DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
    public static final long DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
    public static final int DEFAULT_MAX_RETRIES = 3;
    public static final long DEFAULT_RETRY_BASE_MS = 500;
    public static final long DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
    public static final long RETRY_AFTER_CAP_MS = 60_000;
    public static final long DEFAULT_BREAKER_INITIAL_MS = 5_000;
    public static final long DEFAULT_BREAKER_MAX_MS = 300_000;
    public static final int TARGET_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

    private static final Set<String> LOOPBACK_HOSTS = Set.of("localhost", "127.0.0.1", "::1", "[::1]");

    final URI ingestUri;
    final String apiKey;
    final Map<String, String> extraHeaders;
    final String userAgent;
    final int flushCount;
    final int maxQueueSize;
    final long flushIntervalMs;
    final long timeoutMs;
    final long shutdownTimeoutMs;
    final int maxRetries;
    final long retryBaseMs;
    final long retryMaxDelayMs;
    final long breakerInitialMs;
    final long breakerMaxMs;
    final int targetBodyBytes;
    final String threadName;
    final String loggerName;
    final String logPrefix;

    private TransportConfig(Builder b) {
        if (b.apiKey == null || b.apiKey.isBlank()) {
            throw new IllegalArgumentException("apiKey is required");
        }
        if (b.baseUrl == null || b.baseUrl.isBlank()) {
            throw new IllegalArgumentException("baseUrl is required");
        }
        this.ingestUri = ingestUri(b.baseUrl, b.allowInsecureHttp);
        this.apiKey = b.apiKey;
        this.extraHeaders = Collections.unmodifiableMap(new LinkedHashMap<>(b.extraHeaders));
        this.userAgent = b.userAgent;
        this.flushCount = Math.max(1, Math.min(b.flushCount, MAX_EVENTS_PER_REQUEST));
        this.maxQueueSize = Math.max(1, b.maxQueueSize);
        this.flushIntervalMs = Math.max(1, b.flushIntervalMs);
        this.timeoutMs = Math.max(1, b.timeoutMs);
        this.shutdownTimeoutMs = Math.max(0, b.shutdownTimeoutMs);
        this.maxRetries = Math.max(0, b.maxRetries);
        this.retryBaseMs = Math.max(0, b.retryBaseMs);
        this.retryMaxDelayMs = Math.max(0, b.retryMaxDelayMs);
        this.breakerInitialMs = Math.max(0, b.breakerInitialMs);
        this.breakerMaxMs = Math.max(this.breakerInitialMs, b.breakerMaxMs);
        this.targetBodyBytes = Math.max(1024, b.targetBodyBytes);
        this.threadName = b.threadName;
        this.loggerName = b.loggerName;
        this.logPrefix = b.logPrefix;
    }

    /**
     * {@code baseUrl + /v1/ingest/batch}. {@code https} is required; plain {@code http}
     * is accepted for localhost, 127.0.0.1 and ::1, or anywhere with
     * {@code allowInsecureHttp}, because the API key travels in every request.
     */
    static URI ingestUri(String baseUrl, boolean allowInsecureHttp) {
        String trimmed = baseUrl.trim();
        while (trimmed.endsWith("/")) trimmed = trimmed.substring(0, trimmed.length() - 1);
        URI uri;
        try {
            uri = URI.create(trimmed + INGEST_PATH);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("baseUrl is not a valid URL: " + trimmed, e);
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        if (host.isEmpty()) {
            throw new IllegalArgumentException("baseUrl must include a host: " + trimmed);
        }
        if (scheme.equals("https")) return uri;
        if (scheme.equals("http") && (allowInsecureHttp || LOOPBACK_HOSTS.contains(host))) return uri;
        if (scheme.equals("http")) {
            throw new IllegalArgumentException("baseUrl must use https:// (got " + trimmed + "). The API key is sent"
                    + " with every request; plain http is allowed only for localhost, 127.0.0.1 and ::1, or with"
                    + " allowInsecureHttp(true).");
        }
        throw new IllegalArgumentException("baseUrl must be an https:// URL (got " + trimmed + ")");
    }

    public URI ingestUri() { return ingestUri; }
    public int flushCount() { return flushCount; }
    public int maxQueueSize() { return maxQueueSize; }
    public long flushIntervalMs() { return flushIntervalMs; }
    public long timeoutMs() { return timeoutMs; }
    public long shutdownTimeoutMs() { return shutdownTimeoutMs; }
    public int maxRetries() { return maxRetries; }

    @Override
    public String toString() {
        return "TransportConfig{ingestUri=" + ingestUri + ", apiKey=[redacted], flushCount=" + flushCount
                + ", maxQueueSize=" + maxQueueSize + ", flushIntervalMs=" + flushIntervalMs
                + ", timeoutMs=" + timeoutMs + ", shutdownTimeoutMs=" + shutdownTimeoutMs
                + ", maxRetries=" + maxRetries + "}";
    }

    public static Builder builder() {
        return new Builder();
    }

    /** Fluent builder; every value has the contract default. */
    public static final class Builder {
        private String baseUrl;
        private String apiKey;
        private boolean allowInsecureHttp;
        private final Map<String, String> extraHeaders = new LinkedHashMap<>();
        private String userAgent = "aforo-java";
        private int flushCount = DEFAULT_FLUSH_COUNT;
        private int maxQueueSize = DEFAULT_QUEUE_CAPACITY;
        private long flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;
        private long timeoutMs = DEFAULT_TIMEOUT_MS;
        private long shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS;
        private int maxRetries = DEFAULT_MAX_RETRIES;
        private long retryBaseMs = DEFAULT_RETRY_BASE_MS;
        private long retryMaxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS;
        private long breakerInitialMs = DEFAULT_BREAKER_INITIAL_MS;
        private long breakerMaxMs = DEFAULT_BREAKER_MAX_MS;
        private int targetBodyBytes = TARGET_REQUEST_BODY_BYTES;
        private String threadName = "aforo-metering-flush";
        private String loggerName = TransportCore.class.getName();
        private String logPrefix = "[aforo]";

        public Builder baseUrl(String v) { this.baseUrl = v; return this; }
        public Builder apiKey(String v) { this.apiKey = v; return this; }
        public Builder allowInsecureHttp(boolean v) { this.allowInsecureHttp = v; return this; }
        /** A header sent with every request (for example {@code X-Tenant-Id}). Never the API key. */
        public Builder header(String name, String value) {
            if (name != null && value != null) extraHeaders.put(name, value);
            return this;
        }
        public Builder userAgent(String v) { if (v != null && !v.isBlank()) this.userAgent = v; return this; }
        public Builder flushCount(int v) { this.flushCount = v; return this; }
        public Builder maxQueueSize(int v) { this.maxQueueSize = v; return this; }
        public Builder flushIntervalMs(long v) { this.flushIntervalMs = v; return this; }
        public Builder timeoutMs(long v) { this.timeoutMs = v; return this; }
        public Builder shutdownTimeoutMs(long v) { this.shutdownTimeoutMs = v; return this; }
        public Builder maxRetries(int v) { this.maxRetries = v; return this; }
        public Builder retryBaseMs(long v) { this.retryBaseMs = v; return this; }
        public Builder retryMaxDelayMs(long v) { this.retryMaxDelayMs = v; return this; }
        public Builder breakerInitialMs(long v) { this.breakerInitialMs = v; return this; }
        public Builder breakerMaxMs(long v) { this.breakerMaxMs = v; return this; }
        public Builder targetBodyBytes(int v) { this.targetBodyBytes = v; return this; }
        public Builder threadName(String v) { if (v != null && !v.isBlank()) this.threadName = v; return this; }
        public Builder loggerName(String v) { if (v != null && !v.isBlank()) this.loggerName = v; return this; }
        public Builder logPrefix(String v) { if (v != null) this.logPrefix = v; return this; }

        public TransportConfig build() {
            return new TransportConfig(this);
        }

        @Override
        public String toString() {
            return "TransportConfig.Builder{baseUrl=" + baseUrl + ", apiKey=[redacted]}";
        }
    }
}
