package com.aforo.metering;

import com.aforo.metering.internal.transport.HttpSender;
import com.aforo.metering.internal.transport.Timing;
import com.aforo.metering.internal.transport.TransportConfig;
import com.aforo.metering.internal.transport.TransportCore;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Aforo usage metering client.
 *
 * <p>{@link #track} puts the event in a bounded queue (default 10 000; overflow
 * evicts the oldest event and reports it as {@link DropReason#OVERFLOW}) and
 * returns. One background thread sends batches of up to 500 events. When the
 * ingestor is unreachable, the batch goes back to the queue with the same
 * idempotency keys and is resent after a cooldown, so an outage does not lose
 * usage while the queue has room.</p>
 *
 * <p>{@link #close()} sends what is queued until {@link AforoOptions#shutdownTimeoutMs}
 * passes and reports the rest as {@link DropReason#SHUTDOWN}. Outside Spring the
 * client registers a JVM shutdown hook that does the same; the Spring Boot
 * auto-configuration closes it in Spring's stop phase instead.</p>
 *
 * <pre>{@code
 * try (var client = new AforoClient(new AforoOptions(System.getenv("AFORO_API_KEY")))) {
 *     client.track(TrackEvent.builder(customerId, "api_calls").quantity(1).build());
 * }
 * }</pre>
 */
public class AforoClient implements AutoCloseable {

    private static final Logger LOG = Logger.getLogger(AforoClient.class.getName());
    static final String SDK_VERSION = "2.0.0";

    private final TransportCore<ResolvedEvent> core;
    private final String productType;
    private final BiConsumer<List<ResolvedEvent>, DropReason> onDrop;
    private final ObjectMapper mapper = new ObjectMapper();
    // Kept so close() can deregister — otherwise every client leaks a JVM
    // shutdown hook (and stays reachable through it) for the process lifetime.
    private final Thread shutdownHook;

    public AforoClient(AforoOptions options) {
        this(options, null, null);
    }

    /** Test seam: a fake HTTP sender and clock. {@code null} uses the real ones. */
    AforoClient(AforoOptions options, HttpSender sender, Timing timing) {
        this.productType = options.getProductType();
        this.onDrop = options.getOnDrop();
        TransportConfig config = TransportConfig.builder()
                .baseUrl(options.getBaseUrl())
                .apiKey(options.getApiKey())
                .allowInsecureHttp(options.isAllowInsecureHttp())
                .userAgent("aforo-java/" + SDK_VERSION)
                .flushCount(options.getFlushCount())
                .flushIntervalMs(options.getFlushIntervalMs())
                .maxQueueSize(options.getMaxQueueSize())
                .maxRetries(options.getMaxRetries())
                .retryBaseMs(options.getRetryBaseMs())
                .timeoutMs(options.getTimeoutMs())
                .shutdownTimeoutMs(options.getShutdownTimeoutMs())
                .breakerInitialMs(options.getBreakerCooldownMs())
                .threadName("aforo-metering-flush")
                .loggerName(AforoClient.class.getName())
                .logPrefix("[aforo]")
                .build();
        TransportCore.Encoder<ResolvedEvent> encoder = e -> mapper.writeValueAsString(e.toMap());
        java.util.function.Consumer<AforoError> onError = options.getOnError();
        BiConsumer<Map<String, Object>, List<ResolvedEvent>> onAccepted = options.getOnAccepted();
        TransportCore.Listeners<ResolvedEvent> listeners = TransportCore.Listeners.<ResolvedEvent>builder()
                .onDrop((events, reason) -> { if (onDrop != null) onDrop.accept(events, map(reason)); })
                .onError(onError == null ? null : e -> onError.accept(
                        new AforoError(map(e.kind()), e.message(), e.events(), e.status())))
                .onAccepted(onAccepted == null ? null : (body, events) -> onAccepted.accept(asMap(body), events))
                .build();
        this.core = sender == null && timing == null
                ? new TransportCore<>(config, encoder, listeners)
                : new TransportCore<>(config, encoder, listeners,
                        sender != null ? sender : HttpSender.jdk(TransportConfig.DEFAULT_CONNECT_TIMEOUT_MS),
                        timing != null ? timing : Timing.SYSTEM);

        if (options.isRegisterShutdownHook()) {
            this.shutdownHook = new Thread(() -> {
                try {
                    close();
                } catch (RuntimeException e) {
                    LOG.log(Level.WARNING, "Error during shutdown", e);
                }
            }, "aforo-metering-shutdown");
            Runtime.getRuntime().addShutdownHook(this.shutdownHook);
        } else {
            this.shutdownHook = null;
        }
    }

    static AforoError.Kind map(TransportCore.ErrorKind kind) {
        return switch (kind) {
            case OUTAGE -> AforoError.Kind.OUTAGE;
            case AUTH -> AforoError.Kind.AUTH;
            case REJECTED -> AforoError.Kind.REJECTED;
            case SHUTDOWN -> AforoError.Kind.SHUTDOWN;
            case CLOSED -> AforoError.Kind.CLOSED;
        };
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object body) {
        return body instanceof Map<?, ?> m ? java.util.Collections.unmodifiableMap((Map<String, Object>) m) : Map.of();
    }

    static DropReason map(TransportCore.Reason reason) {
        return switch (reason) {
            case OVERFLOW -> DropReason.OVERFLOW;
            case REJECTED -> DropReason.REJECTED;
            case INVALID -> DropReason.INVALID;
            case SHUTDOWN -> DropReason.SHUTDOWN;
            case CLOSED -> DropReason.CLOSED;
            case RETRY_EXHAUSTED -> DropReason.RETRY_EXHAUSTED;
        };
    }

    /**
     * Enqueue a usage event for batched delivery. Returns immediately and never
     * starts a thread or a request.
     *
     * <p>Events the ingestor would refuse — a blank or over-long customerId /
     * metricName / idempotencyKey, a quantity &lt;= 0 or with more digits than the
     * server accepts — are not queued. Each one is counted in
     * {@link #droppedCount()}, logged, and handed to the opt-in
     * {@link AforoOptions#onDrop onDrop} hook with {@link DropReason#INVALID}.
     * After {@link #close()} the event is reported as {@link DropReason#CLOSED}.
     * This method does not throw for event content or a closed client.</p>
     */
    public void track(TrackEvent event) {
        String occurredAt = event.getOccurredAt() != null
                ? event.getOccurredAt() : Instant.now().toString();
        // No caller key = dedup opt-out: unique random key per track() call,
        // stamped ONCE here so retries of this queued event reuse it.
        String idempotencyKey = event.getIdempotencyKey() != null
                ? event.getIdempotencyKey()
                : IdempotencyKeyGenerator.generateRandom();
        String eventProductType = event.getProductType() != null
                ? event.getProductType() : productType;

        ResolvedEvent resolved = new ResolvedEvent(
                event.getCustomerId(), event.getMetricName(),
                event.getQuantity(), idempotencyKey, occurredAt,
                event.getMetadata(), event.getExecutionStatus(), eventProductType,
                event.getEndpointPath(), event.getHttpMethod(),
                event.getStatusCode(), event.getResponseTimeMs());

        if (!core.isClosed()) {
            String violation = describeViolation(resolved);
            if (violation != null) {
                core.dropInvalid(resolved, violation);
                return;
            }
        }
        core.track(resolved);
    }

    /** The first ingestor constraint this event breaks, or {@code null} when it would be accepted. */
    private static String describeViolation(ResolvedEvent e) {
        if (e.getCustomerId() == null || e.getCustomerId().isBlank()) {
            return "customerId is required (metric=" + EventLimits.abbreviate(e.getMetricName()) + ")";
        }
        if (e.getMetricName() == null || e.getMetricName().isBlank()) {
            return "metricName is required";
        }
        if (!(e.getQuantity() > 0) || Double.isInfinite(e.getQuantity())) {
            return "quantity must be a finite number > 0, got " + e.getQuantity()
                    + " (metric=" + EventLimits.abbreviate(e.getMetricName()) + ")";
        }
        return EventLimits.describeViolation(e.getCustomerId(), e.getMetricName(),
                e.getIdempotencyKey(), e.getProductType(), e.getQuantity());
    }

    /**
     * Ask the background thread to send what is queued and wait for it.
     *
     * <p>{@code failed} counts events dropped during this flush. Events kept in the
     * queue because the ingestor is unreachable are not failed: they are resent
     * after the cooldown.</p>
     */
    public FlushResult flush() {
        TransportCore.FlushStats stats = core.flush();
        return new FlushResult(stats.sent(), stats.dropped(),
                stats.dropped() > 0 ? DropReason.REJECTED : null);
    }

    /**
     * Send what is queued until the shutdown deadline, then stop the background
     * thread and the HTTP client. Events left at the deadline are reported as
     * {@link DropReason#SHUTDOWN}. Idempotent.
     */
    @Override
    public void close() {
        if (shutdownHook != null && Thread.currentThread() != shutdownHook) {
            try {
                Runtime.getRuntime().removeShutdownHook(shutdownHook);
            } catch (IllegalStateException alreadyShuttingDown) {
                LOG.log(Level.FINE, "JVM already shutting down — hook not removed", alreadyShuttingDown);
            }
        }
        core.close();
    }

    /** Events waiting in the queue. */
    public int bufferedCount() { return core.size(); }

    public boolean isClosed() { return core.isClosed(); }

    /** Total events permanently dropped (every {@link DropReason}) since creation. */
    public long droppedCount() { return core.droppedCount(); }

    /** The API key is never included. */
    @Override
    public String toString() {
        return "AforoClient{queued=" + core.size() + ", dropped=" + core.droppedCount() + ", closed=" + core.isClosed() + "}";
    }
}
