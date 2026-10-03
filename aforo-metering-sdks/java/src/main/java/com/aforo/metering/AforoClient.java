package com.aforo.metering;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BiConsumer;
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
    private final String productType;
    private final ScheduledExecutorService scheduler;
    private final BiConsumer<List<ResolvedEvent>, DropReason> onDrop;
    // Kept so close() can deregister — otherwise every client leaks a JVM
    // shutdown hook (and stays reachable through it) for the process lifetime.
    private final Thread shutdownHook;
    private volatile boolean closed = false;

    // Drop accounting — events permanently lost (overflow eviction or failed batch)
    private final AtomicLong dropped = new AtomicLong();
    private final AtomicLong overflowDrops = new AtomicLong();
    private final AtomicLong invalidDrops = new AtomicLong();

    public AforoClient(AforoOptions options) {
        // The ingestor accepts 1-1000 events per batch request.
        this.flushCount = Math.max(1, Math.min(options.getFlushCount(), AforoOptions.MAX_BATCH_SIZE));
        this.productType = options.getProductType();
        this.onDrop = options.getOnDrop();
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

        // Register JVM shutdown hook (deregistered in close())
        this.shutdownHook = new Thread(() -> {
            try { close(); } catch (Exception e) { LOG.log(Level.WARNING, "Error during shutdown", e); }
        }, "aforo-metering-shutdown");
        Runtime.getRuntime().addShutdownHook(this.shutdownHook);
    }

    /**
     * Enqueue a usage event for batched delivery.
     * Non-blocking — returns immediately.
     *
     * <p>Events the ingestor would refuse — a blank or over-long customerId /
     * metricName / idempotencyKey, a quantity &lt;= 0 or with more digits than the
     * server accepts — are not buffered and not sent. Each one is counted in
     * {@link #droppedCount()}, WARN-logged, and handed to the opt-in
     * {@link AforoOptions#onDrop onDrop} hook with {@link DropReason#INVALID}.
     * This method does not throw for event content. See {@link EventLimits}.</p>
     *
     * @throws IllegalStateException if the client is closed
     */
    public void track(TrackEvent event) {
        if (closed) throw new IllegalStateException("AforoClient is closed");

        String occurredAt = event.getOccurredAt() != null
                ? event.getOccurredAt() : Instant.now().toString();
        // No caller key = dedup opt-out: unique random key per track() call,
        // stamped ONCE here so flush retries of this buffered event reuse it
        // (retry-dedup preserved) — never minted at flush/retry time. The previous
        // content-hash fallback silently COLLAPSED legitimately distinct events
        // recorded in the same instant — the same bug Aforo's ingest fixed
        // server-side in April 2026 (H4 fix). Callers wanting logical retry-dedup
        // supply their own stable key, which is passed through verbatim.
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

        String violation = describeViolation(resolved);
        if (violation != null) {
            recordInvalid(resolved, violation);
            return;
        }

        ResolvedEvent evicted = buffer.pushEvict(resolved);
        if (evicted != null) {
            recordDrop(List.of(evicted), DropReason.OVERFLOW);
        }

        if (buffer.size() >= flushCount) {
            scheduler.submit(() -> { try { flush(); } catch (Exception e) { LOG.log(Level.FINE, "Async flush failed", e); } });
        }
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
     * An event that breaks an ingestor constraint: never buffered, counted, logged
     * (first, then every 1000th, so a tight loop can't storm the log) and handed to
     * the onDrop hook with {@link DropReason#INVALID}.
     */
    private void recordInvalid(ResolvedEvent event, String violation) {
        long total = dropped.incrementAndGet();
        long invalids = invalidDrops.incrementAndGet();
        if (invalids == 1 || invalids % 1000 == 0) {
            LOG.warning("[aforo] Dropping invalid event: " + violation + " (" + invalids
                    + " invalid, " + total + " total dropped).");
        }
        invokeOnDrop(List.of(event), DropReason.INVALID);
    }

    /**
     * Account for permanently lost events: bump the counter, WARN-log, and
     * invoke the opt-in onDrop hook. Overflow logs are throttled (first,
     * then every 1000th eviction) so sustained overflow can't storm the log;
     * failed-batch drops log every time (bounded by flush cadence).
     */
    private void recordDrop(List<ResolvedEvent> events, DropReason reason) {
        long total = dropped.addAndGet(events.size());

        if (reason == DropReason.OVERFLOW) {
            long overflows = overflowDrops.addAndGet(events.size());
            if (overflows == 1 || overflows % 1000 == 0) {
                LOG.warning("[aforo] Buffer overflow: oldest event dropped (" + total
                        + " total dropped). Consider raising maxQueueSize or checking ingest connectivity.");
            }
        } else {
            LOG.warning("[aforo] Dropped " + events.size() + " event(s) — " + reason
                    + " (" + total + " total dropped).");
        }

        invokeOnDrop(events, reason);
    }

    private void invokeOnDrop(List<ResolvedEvent> events, DropReason reason) {
        if (onDrop != null) {
            try {
                onDrop.accept(events, reason);
            } catch (Exception e) {
                // A hook bug must never break tracking/flushing.
                LOG.log(Level.FINE, "onDrop hook threw", e);
            }
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
            Transport.Outcome result = transport.sendDetailed(batch);
            totalSent += result.sent();
            totalFailed += result.failed();

            if (result.partial()) {
                // 2xx, but the ingestor refused some events individually. Only the
                // events it identified by index go to the hook; any it counted
                // without an index are counted too, but not guessed at.
                List<ResolvedEvent> rejected = new ArrayList<>();
                for (int index : result.rejectedIndexes()) rejected.add(batch.get(index));
                if (!rejected.isEmpty()) recordDrop(rejected, DropReason.REJECTED);
                int unidentified = result.failed() - rejected.size();
                if (unidentified > 0) {
                    long total = dropped.addAndGet(unidentified);
                    LOG.warning("[aforo] Ingestor rejected " + unidentified
                            + " more event(s) without identifying them (" + total + " total dropped).");
                }
            } else if (result.failed() > 0) {
                // The batch was already drained from the buffer — without this
                // it vanishes silently. Surface it (counter + WARN + opt-in hook).
                recordDrop(batch, result.reason() != null ? result.reason() : DropReason.RETRY_EXHAUSTED);
            }
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

        // Deregister the JVM hook so repeated create/close cycles don't
        // accumulate hooks. IllegalStateException = JVM is already shutting
        // down (i.e., THIS hook is what invoked close()) — nothing to remove.
        try {
            Runtime.getRuntime().removeShutdownHook(shutdownHook);
        } catch (IllegalStateException ignored) {
            LOG.log(Level.FINE, "JVM already shutting down — hook not removed");
        }

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

    /** Total events permanently dropped (overflow, failed or rejected batches, invalid events) since creation. */
    public long droppedCount() { return dropped.get(); }
}
