package com.aforo.metering;

import java.time.Instant;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Aforo usage metering client.
 *
 * <p>Enqueues events into a thread-safe ring buffer and flushes them
 * in batches via a {@link ScheduledExecutorService} background thread.</p>
 *
 * <p>Implements {@link AutoCloseable} for try-with-resources support.</p>
 *
 * <pre>{@code
 * try (var client = new AforoClient(new AforoOptions("your-key"))) {
 *     client.track(TrackEvent.builder("cust_1", "api_calls").quantity(1).build());
 * }
 * }</pre>
 */
public class AforoClient implements AutoCloseable {

    private static final Logger LOG = Logger.getLogger(AforoClient.class.getName());

    private final RingBuffer buffer;
    private final Transport transport;
    private final int flushCount;
    private final ScheduledExecutorService scheduler;
    private volatile boolean closed = false;

    public AforoClient(AforoOptions options) {
        this.flushCount = options.getFlushCount();
        this.buffer = new RingBuffer(options.getMaxQueueSize());
        this.transport = new Transport(
                options.getBaseUrl(), options.getApiKey(),
                options.getTimeoutMs(), options.getMaxRetries(), options.getRetryBaseMs());

        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "aforo-metering-flush");
            t.setDaemon(true);
            return t;
        });

        scheduler.scheduleAtFixedRate(
                () -> { try { flush(); } catch (Exception e) { LOG.log(Level.FINE, "Periodic flush failed", e); } },
                options.getFlushIntervalMs(), options.getFlushIntervalMs(), TimeUnit.MILLISECONDS);

        // Register JVM shutdown hook
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            try { close(); } catch (Exception e) { LOG.log(Level.WARNING, "Error during shutdown", e); }
        }, "aforo-metering-shutdown"));
    }

    /**
     * Enqueue a usage event for batched delivery.
     * Non-blocking — returns immediately.
     */
    public void track(TrackEvent event) {
        if (closed) throw new IllegalStateException("AforoClient is closed");

        String occurredAt = event.getOccurredAt() != null
                ? event.getOccurredAt() : Instant.now().toString();
        String idempotencyKey = event.getIdempotencyKey() != null
                ? event.getIdempotencyKey()
                : IdempotencyKeyGenerator.generate(
                        event.getCustomerId(), event.getMetricName(),
                        event.getQuantity(), occurredAt);

        ResolvedEvent resolved = new ResolvedEvent(
                event.getCustomerId(), event.getMetricName(),
                event.getQuantity(), idempotencyKey, occurredAt,
                event.getMetadata());

        buffer.push(resolved);

        if (buffer.size() >= flushCount) {
            scheduler.submit(() -> { try { flush(); } catch (Exception e) { LOG.log(Level.FINE, "Async flush failed", e); } });
        }
    }

    /**
     * Force-flush all buffered events synchronously.
     */
    public FlushResult flush() {
        int totalSent = 0, totalFailed = 0;

        while (!buffer.isEmpty()) {
            List<ResolvedEvent> batch = buffer.drainUpTo(flushCount);
            if (batch.isEmpty()) break;
            FlushResult result = transport.send(batch);
            totalSent += result.sent();
            totalFailed += result.failed();
        }

        return new FlushResult(totalSent, totalFailed);
    }

    /**
     * Flush remaining events and shut down the background scheduler.
     */
    @Override
    public void close() {
        if (closed) return;
        closed = true;

        scheduler.shutdown();
        try {
            flush();
            scheduler.awaitTermination(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    public int bufferedCount() { return buffer.size(); }
    public boolean isClosed() { return closed; }
}
