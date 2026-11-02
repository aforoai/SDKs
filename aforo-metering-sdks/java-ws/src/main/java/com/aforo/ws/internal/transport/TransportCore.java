package com.aforo.ws.internal.transport;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * The Java transport core: one bounded queue and one long-lived flusher thread per
 * SDK client, implementing {@code contract/TRANSPORT-SPEC.md}.
 *
 * <ul>
 *   <li>{@link #track} never starts a thread or sends: it enqueues, evicts the oldest
 *       event on overflow, and at the flush threshold wakes the flusher with an
 *       {@link AtomicBoolean} compare-and-set (waking an awake flusher is a no-op).</li>
 *   <li>The flusher sends batches of up to {@code flushCount} events, split so no body
 *       exceeds 4 MiB. Retries use full-jitter backoff and honour {@code Retry-After}
 *       (delta-seconds or HTTP-date, capped at 60 s).</li>
 *   <li>After the last retry (or on 401/403) the batch goes back to the front of the
 *       queue with its idempotency keys and the flusher pauses for the breaker cooldown.</li>
 *   <li>{@link #close()} drains until the shutdown deadline; leftovers are reported as
 *       {@link Reason#SHUTDOWN}. {@link #track} after close reports {@link Reason#CLOSED}.</li>
 * </ul>
 *
 * <p>This file is the transport core. Edit it in the {@code java} module only and
 * run {@code scripts/sync-transport.sh java}; the variants carry copies.</p>
 *
 * @param <E> the module's event type, handed back unchanged to the drop handler
 */
public final class TransportCore<E> implements AutoCloseable {

    /** Why events were permanently dropped. */
    public enum Reason {
        OVERFLOW, REJECTED, INVALID, SHUTDOWN, CLOSED, RETRY_EXHAUSTED;

        /** The contract spelling ({@code overflow}, {@code rejected}, ...). */
        public String wireName() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    /** Serializes one event as a JSON object. Called on the tracking thread. */
    @FunctionalInterface
    public interface Encoder<E> {
        String encode(E event) throws Exception;
    }

    /** Receives events the client is about to lose. Exceptions are caught and logged. */
    @FunctionalInterface
    public interface DropHandler<E> {
        void onDrop(List<E> events, Reason reason);
    }

    /** What an {@link ErrorHandler} report is about. Branch on this, never on the message. */
    public enum ErrorKind {
        /** Ingestor unreachable, 408/429/5xx or a redirect after the retries; events are kept and resent. */
        OUTAGE,
        /** 401/403: the API key is wrong or revoked; events are kept and resent. */
        AUTH,
        /** The ingestor refused these events; they are dropped. */
        REJECTED,
        /** Still queued at the shutdown deadline; dropped. */
        SHUTDOWN,
        /** Tracked after close; dropped. */
        CLOSED;

        /** The contract spelling ({@code outage}, {@code auth}, ...). */
        public String wireName() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    /** One {@link ErrorHandler} report. The message never contains the API key. */
    public static final class TransportError<E> {
        private final ErrorKind kind;
        private final String message;
        private final List<E> events;
        private final int status;

        TransportError(ErrorKind kind, String message, List<E> events, int status) {
            this.kind = kind;
            this.message = message;
            this.events = events == null ? List.of() : Collections.unmodifiableList(new ArrayList<>(events));
            this.status = status;
        }

        public ErrorKind kind() { return kind; }
        public String message() { return message; }
        /** The events concerned: the kept ones for OUTAGE/AUTH, the dropped ones otherwise. */
        public List<E> events() { return events; }
        /** HTTP status of the answer that caused the report, or 0 when there was none. */
        public int status() { return status; }
        /** True when the events are still queued and will be resent. */
        public boolean willRetry() { return kind == ErrorKind.OUTAGE || kind == ErrorKind.AUTH; }

        @Override
        public String toString() {
            return "TransportError{kind=" + kind.wireName() + ", status=" + status + ", events=" + events.size()
                    + ", message=" + message + "}";
        }
    }

    /** Receives typed error reports. Exceptions are caught and logged; may call flush() or close(). */
    @FunctionalInterface
    public interface ErrorHandler<E> {
        void onError(TransportError<E> error);
    }

    /** Receives the envelope-unwrapped body of each accepted (2xx) batch. Exceptions are caught and logged. */
    @FunctionalInterface
    public interface AcceptedHandler<E> {
        void onAccepted(Object body, List<E> events);
    }

    /** The optional hooks of one core. */
    public static final class Listeners<E> {
        final DropHandler<E> onDrop;
        final ErrorHandler<E> onError;
        final AcceptedHandler<E> onAccepted;

        private Listeners(Builder<E> b) {
            this.onDrop = b.onDrop;
            this.onError = b.onError;
            this.onAccepted = b.onAccepted;
        }

        public static <E> Builder<E> builder() {
            return new Builder<>();
        }

        public static <E> Listeners<E> of(DropHandler<E> onDrop) {
            return TransportCore.Listeners.<E>builder().onDrop(onDrop).build();
        }

        public static final class Builder<E> {
            private DropHandler<E> onDrop;
            private ErrorHandler<E> onError;
            private AcceptedHandler<E> onAccepted;

            public Builder<E> onDrop(DropHandler<E> h) { this.onDrop = h; return this; }
            public Builder<E> onError(ErrorHandler<E> h) { this.onError = h; return this; }
            public Builder<E> onAccepted(AcceptedHandler<E> h) { this.onAccepted = h; return this; }
            public Listeners<E> build() { return new Listeners<>(this); }
        }
    }

    /** What one {@link #flush()} did. */
    public static final class FlushStats {
        private final int sent;
        private final int dropped;
        private final int pending;

        FlushStats(int sent, int dropped, int pending) {
            this.sent = sent;
            this.dropped = dropped;
            this.pending = pending;
        }

        /** Events the ingestor accepted (or deduplicated). */
        public int sent() { return sent; }
        /** Events permanently dropped during the flush. */
        public int dropped() { return dropped; }
        /** Events still queued when the flush returned (outage, breaker open). */
        public int pending() { return pending; }

        @Override
        public String toString() {
            return "FlushStats{sent=" + sent + ", dropped=" + dropped + ", pending=" + pending + "}";
        }
    }

    private static final class Entry<E> {
        final E event;
        final String json;
        final int bytes;
        /** Times a 2xx marked this event retryable since its last breaker opening (flusher thread only). */
        int retryableAttempts;

        Entry(E event, String json) {
            this.event = event;
            this.json = json;
            this.bytes = json.getBytes(StandardCharsets.UTF_8).length;
        }
    }

    /** Outcome of delivering one request body (after its retries). */
    private enum Kind { DONE, TOO_LARGE, OUTAGE }

    private static final class Result {
        Kind kind = Kind.DONE;
        int sent;
        int dropped;
        boolean requeuedRetryable;
        /** Per-event retryable failures reached maxRetries: treat as an outage. */
        boolean retryCapReached;
        int retryableCount;
        int authStatus;
        int redirectStatus;
        String redirectLocation;
        int lastStatus;
        /** On an outage: the entries of this body that were not delivered, in order. */
        List<Entry<?>> unsent = List.of();
    }

    private final TransportConfig config;
    private final Encoder<E> encoder;
    private final DropHandler<E> dropHandler;
    private final ErrorHandler<E> errorHandler;
    private final AcceptedHandler<E> acceptedHandler;
    private final HttpSender sender;
    private final Timing timing;
    private final Logger log;
    private final String prefix;
    private final Map<String, String> headers;
    private final Map<String, String> gzipHeaders;

    private final ReentrantLock queueLock = new ReentrantLock();
    private final ArrayDeque<Entry<E>> queue = new ArrayDeque<>();

    /** Single wake signal: track() sets it with CAS, the flusher clears it. */
    private final AtomicBoolean wakeRequested = new AtomicBoolean();
    private final Object signal = new Object();
    private final List<CompletableFuture<FlushStats>> flushRequests = new ArrayList<>();

    private final AtomicBoolean closing = new AtomicBoolean();
    private final AtomicBoolean senderClosed = new AtomicBoolean();
    private volatile long closeDeadline = Long.MAX_VALUE;
    private final CompletableFuture<Void> terminated = new CompletableFuture<>();
    private final Thread flusher;

    private final AtomicLong dropped = new AtomicLong();
    private final AtomicLong sentTotal = new AtomicLong();
    private final AtomicLong overflowDrops = new AtomicLong();
    private final AtomicLong invalidDrops = new AtomicLong();
    private final AtomicLong closedDrops = new AtomicLong();

    /** Set by close() when the shutdown deadline passed in real time: stop sending now. */
    private volatile boolean deadlineForced;

    /** Extra real time close() waits after cutting the request in flight (finding 5). */
    static final long CLOSE_GRACE_MS = 500;

    // Flusher-thread state.
    /** An explicit flush() while the breaker is open: one attempt, no retries. */
    private boolean singleAttempt;
    /** The last pass ended in an outage (used by the shutdown drain). */
    private boolean lastPassOutage;
    /** 401/403 or a redirect was logged at SEVERE (and reported) since the last success. */
    private boolean severeReported;
    private int breakerOpenings;
    private long breakerUntil;
    private int retryableStreak;
    private long nextPassNotBefore;
    /** Events were put back (outage or retryable); send again as soon as the cooldown ends. */
    private boolean resumePending;

    public TransportCore(TransportConfig config, Encoder<E> encoder, DropHandler<E> dropHandler) {
        this(config, encoder, dropHandler, HttpSender.jdk(Math.min(TransportConfig.DEFAULT_CONNECT_TIMEOUT_MS,
                config.timeoutMs)), Timing.SYSTEM);
    }

    public TransportCore(TransportConfig config, Encoder<E> encoder, DropHandler<E> dropHandler,
                         HttpSender sender, Timing timing) {
        this(config, encoder, Listeners.of(dropHandler), sender, timing);
    }

    public TransportCore(TransportConfig config, Encoder<E> encoder, Listeners<E> listeners) {
        this(config, encoder, listeners, HttpSender.jdk(Math.min(TransportConfig.DEFAULT_CONNECT_TIMEOUT_MS,
                config.timeoutMs)), Timing.SYSTEM);
    }

    public TransportCore(TransportConfig config, Encoder<E> encoder, Listeners<E> listeners,
                         HttpSender sender, Timing timing) {
        if (config == null || encoder == null || sender == null || timing == null) {
            throw new IllegalArgumentException("config, encoder, sender and timing are required");
        }
        Listeners<E> l = listeners == null ? Listeners.<E>builder().build() : listeners;
        this.config = config;
        this.encoder = encoder;
        this.dropHandler = l.onDrop;
        this.errorHandler = l.onError;
        this.acceptedHandler = l.onAccepted;
        this.sender = sender;
        this.timing = timing;
        this.log = Logger.getLogger(config.loggerName);
        this.prefix = config.logPrefix;
        Map<String, String> h = new LinkedHashMap<>(config.extraHeaders);
        h.put("Content-Type", "application/json");
        h.put("User-Agent", config.userAgent);
        h.put("X-API-Key", config.apiKey);
        this.headers = Collections.unmodifiableMap(h);
        Map<String, String> gz = new LinkedHashMap<>(h);
        gz.put("Content-Encoding", "gzip");
        this.gzipHeaders = Collections.unmodifiableMap(gz);
        this.flusher = new Thread(this::runFlusher, config.threadName);
        this.flusher.setDaemon(true);
        this.flusher.start();
    }

    // ── tracking ──────────────────────────────────────────────────────────────

    /**
     * Enqueues an event. Never blocks on the network and never throws: an event
     * that cannot be serialized is dropped as {@link Reason#INVALID}; after
     * {@link #close()} it is dropped as {@link Reason#CLOSED}.
     *
     * @return {@code true} when the event was queued
     */
    public boolean track(E event) {
        if (closing.get()) {
            dropClosed(event);
            return false;
        }
        String json;
        try {
            json = encoder.encode(event);
        } catch (Exception | StackOverflowError e) {
            // A StackOverflowError here is a cyclic structure in the event, not a broken JVM.
            log.log(Level.FINE, prefix + " event could not be serialized", e);
            dropInvalid(event, "the event could not be serialized: " + e.getClass().getSimpleName());
            return false;
        }
        if (json == null || json.isEmpty()) {
            dropInvalid(event, "the event serialized to nothing");
            return false;
        }
        Entry<E> entry = new Entry<>(event, json);
        Entry<E> evicted = null;
        int size;
        queueLock.lock();
        try {
            if (closing.get()) {
                evicted = entry; // reported as CLOSED below
                size = -1;
            } else {
                queue.addLast(entry);
                if (queue.size() > config.maxQueueSize) evicted = queue.pollFirst();
                size = queue.size();
            }
        } finally {
            queueLock.unlock();
        }
        if (size < 0) {
            dropClosed(event);
            return false;
        }
        if (evicted != null) dropOverflow(List.of(evicted));
        if (size >= config.flushCount) wake();
        return true;
    }

    /** Wakes the flusher once; repeated calls while it is already awake do nothing. */
    private void wake() {
        if (wakeRequested.compareAndSet(false, true)) {
            synchronized (signal) {
                signal.notifyAll();
            }
        }
    }

    // ── drops ─────────────────────────────────────────────────────────────────

    /** Reports an event the module rejected before queueing (blank customer, field limit). */
    public void dropInvalid(E event, String why) {
        long n = invalidDrops.incrementAndGet();
        long total = dropped.incrementAndGet();
        if (n == 1 || n % 1000 == 0) {
            log.warning(prefix + " Dropping invalid event: " + why + " (" + n + " invalid, "
                    + total + " total dropped).");
        }
        notifyDrop(List.of(event), Reason.INVALID);
    }

    private void dropClosed(E event) {
        long n = closedDrops.incrementAndGet();
        long total = dropped.incrementAndGet();
        if (n == 1 || n % 1000 == 0) {
            log.warning(prefix + " Event tracked after close was dropped (" + n + " so far, "
                    + total + " total dropped).");
        }
        notifyDrop(List.of(event), Reason.CLOSED);
        if (n == 1 || n % 1000 == 0) {
            reportError(ErrorKind.CLOSED, "Aforo metering is closed: an event tracked after close() was dropped ("
                    + n + " so far)", List.of(event), 0);
        }
    }

    private void dropOverflow(List<Entry<E>> entries) {
        long n = overflowDrops.addAndGet(entries.size());
        long total = dropped.addAndGet(entries.size());
        if (n == entries.size() || n / 1000 != (n - entries.size()) / 1000) {
            log.warning(prefix + " Queue full: oldest event(s) dropped (" + n + " overflow, " + total
                    + " total dropped). Raise maxQueueSize or check ingest connectivity.");
        }
        notifyDrop(events(entries), Reason.OVERFLOW);
    }

    private void drop(List<Entry<E>> entries, Reason reason, int status) {
        if (entries.isEmpty()) return;
        long total = dropped.addAndGet(entries.size());
        log.warning(prefix + " Dropped " + entries.size() + " event(s): " + reason.wireName()
                + " (" + total + " total dropped).");
        List<E> events = events(entries);
        notifyDrop(events, reason);
        if (reason == Reason.REJECTED) {
            reportError(ErrorKind.REJECTED, "Aforo ingestor rejected " + entries.size() + " event(s); they were dropped",
                    events, status);
        } else if (reason == Reason.SHUTDOWN) {
            reportError(ErrorKind.SHUTDOWN, "Aforo metering shutdown deadline passed: " + entries.size()
                    + " queued event(s) were dropped", events, 0);
        }
    }

    private void reportError(ErrorKind kind, String message, List<E> events, int status) {
        if (errorHandler == null) return;
        try {
            errorHandler.onError(new TransportError<>(kind, message, events, status));
        } catch (Throwable t) {
            log.log(Level.WARNING, prefix + " onError hook threw; continuing", t);
        }
    }

    private void notifyDrop(List<E> events, Reason reason) {
        if (dropHandler == null) return;
        try {
            dropHandler.onDrop(events, reason);
        } catch (Throwable t) {
            log.log(Level.WARNING, prefix + " onDrop hook threw; continuing", t);
        }
    }

    private List<E> events(List<Entry<E>> entries) {
        List<E> out = new ArrayList<>(entries.size());
        for (Entry<E> e : entries) out.add(e.event);
        return Collections.unmodifiableList(out);
    }

    // ── flush ─────────────────────────────────────────────────────────────────

    /**
     * Asks the flusher to send what is queued now and waits for it. Never runs a
     * second, concurrent send. While the breaker is open the flush makes one attempt
     * (no retries); an outage reopens the breaker and the events stay queued
     * ({@link FlushStats#pending()}). Returns at once when called from a hook on the
     * flusher thread or after {@link #close()}.
     */
    public FlushStats flush() {
        if (Thread.currentThread() == flusher || closing.get() || !flusher.isAlive()) {
            return new FlushStats(0, 0, size());
        }
        CompletableFuture<FlushStats> request = new CompletableFuture<>();
        synchronized (signal) {
            flushRequests.add(request);
            signal.notifyAll();
        }
        try {
            return request.get();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new FlushStats(0, 0, size());
        } catch (ExecutionException e) {
            log.log(Level.FINE, prefix + " flush failed", e);
            return new FlushStats(0, 0, size());
        }
    }

    private List<CompletableFuture<FlushStats>> takeFlushRequests() {
        synchronized (signal) {
            if (flushRequests.isEmpty()) return List.of();
            List<CompletableFuture<FlushStats>> out = new ArrayList<>(flushRequests);
            flushRequests.clear();
            return out;
        }
    }

    private boolean hasFlushRequests() {
        synchronized (signal) {
            return !flushRequests.isEmpty();
        }
    }

    private void complete(List<CompletableFuture<FlushStats>> requests, FlushStats stats) {
        for (CompletableFuture<FlushStats> r : requests) r.complete(stats);
    }

    // ── flusher thread ────────────────────────────────────────────────────────

    private void runFlusher() {
        long nextPeriodic = timing.nowMillis() + config.flushIntervalMs;
        try {
            while (!closing.get()) {
                try {
                    nextPeriodic = flusherStep(nextPeriodic);
                } catch (InterruptedException e) {
                    // Only close() interrupts this thread; anything else is ignored so the flusher keeps running.
                    log.log(Level.FINE, prefix + " flusher interrupted", e);
                }
            }
            drainForShutdown();
        } catch (InterruptedException e) {
            log.log(Level.FINE, prefix + " flusher interrupted during shutdown", e);
        } catch (Throwable t) {
            log.log(Level.SEVERE, prefix + " flusher stopped unexpectedly", t);
        } finally {
            List<Entry<E>> left = pollAll();
            if (!left.isEmpty()) drop(left, Reason.SHUTDOWN, 0);
            complete(takeFlushRequests(), new FlushStats(0, 0, size()));
            closeSender();
            terminated.complete(null);
        }
    }

    /** One turn of the flusher loop; returns the next periodic flush time. */
    private long flusherStep(long nextPeriodic) throws InterruptedException {
        long now = timing.nowMillis();
        boolean requested = hasFlushRequests();
        if (!requested && breakerUntil > now) {
            timing.sleep(Math.min(breakerUntil - now, config.flushIntervalMs), signal);
            return nextPeriodic;
        }
        if (!requested && nextPassNotBefore > now) {
            // Backing off before resending events the ingestor marked retryable.
            timing.sleep(Math.min(nextPassNotBefore - now, config.flushIntervalMs), signal);
            return nextPeriodic;
        }
        boolean woken = wakeRequested.getAndSet(false);
        boolean periodic = now >= nextPeriodic;
        // A breaker cooldown or retry backoff just ended with events waiting: resume now.
        boolean resume = resumePending && size() > 0;
        if (!requested && !woken && !periodic && !resume) {
            idleWait(Math.max(1, Math.min(nextPeriodic - now, config.flushIntervalMs)));
            return nextPeriodic;
        }
        long next = periodic ? now + config.flushIntervalMs : nextPeriodic;
        boolean breakerOpen = breakerUntil > now;
        nextPassNotBefore = 0;
        resumePending = false;
        List<CompletableFuture<FlushStats>> requests = takeFlushRequests();
        // The caller asked for a flush while the breaker is open: one attempt now.
        singleAttempt = breakerOpen;
        FlushStats stats;
        try {
            stats = runPass(size());
        } finally {
            singleAttempt = false;
        }
        complete(requests, stats);
        return next;
    }

    /** Real-time wait for work; returns on track() wake, flush(), close() or timeout. */
    private void idleWait(long millis) throws InterruptedException {
        synchronized (signal) {
            if (wakeRequested.get() || !flushRequests.isEmpty() || closing.get()) return;
            signal.wait(millis);
        }
    }

    /**
     * Close: send until the queue is empty or the deadline passes. The breaker is
     * ignored here; after an outage the drain keeps retrying with jittered backoff
     * and never waits past the deadline.
     */
    private void drainForShutdown() throws InterruptedException {
        int outages = 0;
        while (!pastDeadline() && size() > 0) {
            long now = timing.nowMillis();
            if (nextPassNotBefore > now) {
                if (!sleepFor(nextPassNotBefore - now)) break;
                continue;
            }
            nextPassNotBefore = 0;
            runPass(size());
            if (lastPassOutage) {
                if (!sleepFor(jitter(outages++))) break;
            } else {
                outages = 0;
            }
        }
        complete(takeFlushRequests(), new FlushStats(0, 0, size()));
    }

    private boolean pastDeadline() {
        return closing.get() && (deadlineForced || timing.nowMillis() >= closeDeadline);
    }

    /** Sends at most {@code budget} queued events (those present when the pass began). */
    private FlushStats runPass(int budget) {
        int sent = 0;
        int lost = 0;
        lastPassOutage = false;
        while (budget > 0) {
            if (pastDeadline()) break;
            List<Entry<E>> batch = pollBatch(Math.min(config.flushCount, budget));
            if (batch.isEmpty()) break;
            budget -= batch.size();
            Result r;
            try {
                r = deliver(batch);
            } catch (RuntimeException e) {
                // A bug must not lose a batch that is off the queue: put it back (keys keep resends dedup-safe).
                log.log(Level.SEVERE, prefix + " sending a batch failed unexpectedly; the batch was put back", e);
                requeueFront(batch);
                openBreaker(0, null, batch.size(), "unexpected error");
                lastPassOutage = true;
                break;
            }
            sent += r.sent;
            lost += r.dropped;
            if (r.kind == Kind.OUTAGE) {
                lastPassOutage = true;
                break;
            }
            if (r.requeuedRetryable) {
                // Wait a jittered backoff before resending events the ingestor asked us to retry.
                nextPassNotBefore = timing.nowMillis() + jitter(retryableStreak++);
                resumePending = true;
                break;
            }
            retryableStreak = 0;
        }
        return new FlushStats(sent, lost, size());
    }

    /** Splits by body size, sends each part; on an outage requeues everything unsent. */
    private Result deliver(List<Entry<E>> batch) {
        List<List<Entry<E>>> parts = splitByBytes(batch);
        Result total = new Result();
        for (int p = 0; p < parts.size(); p++) {
            Result r = sendSplitting(parts.get(p));
            total.sent += r.sent;
            total.dropped += r.dropped;
            total.requeuedRetryable |= r.requeuedRetryable;
            if (r.kind == Kind.OUTAGE) {
                List<Entry<E>> unsent = new ArrayList<>(cast(r.unsent));
                for (int q = p + 1; q < parts.size(); q++) unsent.addAll(parts.get(q));
                requeueFront(unsent);
                if (r.redirectStatus != 0) {
                    openBreaker(r.redirectStatus, r.redirectLocation, unsent.size(), "HTTP " + r.redirectStatus);
                } else if (r.authStatus != 0) {
                    openBreaker(r.authStatus, null, unsent.size(), "HTTP " + r.authStatus);
                } else {
                    openBreaker(r.lastStatus, null, unsent.size(), r.lastStatus == 0 ? "network error or timeout"
                            : "HTTP " + r.lastStatus);
                }
                total.kind = Kind.OUTAGE;
                return total;
            }
            if (r.retryCapReached) {
                // Per-event retryable failures did not clear after maxRetries: an outage (requeue + breaker).
                List<Entry<E>> rest = new ArrayList<>();
                for (int q = p + 1; q < parts.size(); q++) rest.addAll(parts.get(q));
                requeueFront(rest);
                openBreaker(0, null, r.retryableCount + rest.size(), "events stayed retryable after "
                        + config.maxRetries + " resend(s)");
                total.kind = Kind.OUTAGE;
                return total;
            }
        }
        return total;
    }

    /** Sends one body; a 413 halves it until a single event is left, which is rejected. */
    private Result sendSplitting(List<Entry<E>> part) {
        Result r = sendWithRetries(part);
        if (r.kind != Kind.TOO_LARGE) return r;
        if (part.size() == 1) {
            log.warning(prefix + " The ingestor refused a single event as too large (413).");
            drop(part, Reason.REJECTED, 413);
            Result d = new Result();
            d.dropped = 1;
            return d;
        }
        int mid = part.size() / 2;
        Result left = sendSplitting(new ArrayList<>(part.subList(0, mid)));
        if (left.kind == Kind.OUTAGE || left.retryCapReached) {
            // The right half was never sent: it goes back with the left half's outcome.
            List<Entry<?>> unsent = new ArrayList<>(left.unsent);
            if (left.kind == Kind.OUTAGE) {
                unsent.addAll(part.subList(mid, part.size()));
                left.unsent = unsent;
            } else {
                requeueFront(new ArrayList<>(part.subList(mid, part.size())));
                left.retryableCount += part.size() - mid;
            }
            return left;
        }
        Result right = sendSplitting(new ArrayList<>(part.subList(mid, part.size())));
        right.sent += left.sent;
        right.dropped += left.dropped;
        right.requeuedRetryable |= left.requeuedRetryable;
        right.retryableCount += left.retryableCount;
        return right;
    }

    /**
     * The request bytes for {@code json}: gzip when compression is on and the body is at least
     * {@link TransportConfig#COMPRESSION_MIN_BYTES} (wave 8, G269), else the UTF-8 JSON. A
     * compression failure sends the JSON plain, never drops the batch.
     */
    private byte[] encode(String json, boolean[] gzipped) {
        byte[] raw = json.getBytes(StandardCharsets.UTF_8);
        if (!config.gzip || raw.length < TransportConfig.COMPRESSION_MIN_BYTES) return raw;
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(Math.max(64, raw.length / 4));
        try (java.util.zip.GZIPOutputStream gz = new java.util.zip.GZIPOutputStream(out)) {
            gz.write(raw);
        } catch (IOException e) {
            log.log(Level.FINE, prefix + " gzip failed, sending uncompressed", e);
            return raw;
        }
        gzipped[0] = true;
        return out.toByteArray();
    }

    private Result sendWithRetries(List<Entry<E>> part) {
        // Compressed once; every retry sends the same bytes.
        boolean[] gzipped = {false};
        byte[] body = encode(body(part), gzipped);
        Map<String, String> requestHeaders = gzipped[0] ? gzipHeaders : headers;
        Result r = new Result();
        int maxRetries = singleAttempt ? 0 : config.maxRetries;
        for (int attempt = 0; ; attempt++) {
            long timeout = config.timeoutMs;
            if (closing.get()) {
                long left = closeDeadline - timing.nowMillis();
                if (left <= 0 || deadlineForced) {
                    return outage(r, part);
                }
                timeout = Math.min(timeout, left);
            }
            HttpSender.Response resp = null;
            String failure;
            try {
                resp = sender.postBytes(config.ingestUri, requestHeaders, body, timeout);
                failure = null;
            } catch (IOException e) {
                failure = e.getClass().getSimpleName();
                log.log(Level.FINE, prefix + " ingest request failed (attempt " + (attempt + 1) + ")", e);
            } catch (InterruptedException e) {
                // close() cut the request at the shutdown deadline: the batch goes back and is
                // reported by the drain. The interrupt flag is not restored on purpose.
                log.log(Level.FINE, prefix + " ingest request interrupted (attempt " + (attempt + 1) + ")", e);
                return outage(r, part);
            }
            String retryAfter = null;
            if (resp != null) {
                int status = resp.status();
                r.lastStatus = status;
                if (status >= 200 && status < 300) {
                    return accepted(part, resp.body());
                }
                if (status == 401 || status == 403) {
                    r.authStatus = status;
                    return outage(r, part);
                }
                if (status >= 300 && status < 400) {
                    // Never followed: the API key must not reach another host.
                    r.redirectStatus = status;
                    r.redirectLocation = resp.location();
                    return outage(r, part);
                }
                if (status == 413) {
                    r.kind = Kind.TOO_LARGE;
                    return r;
                }
                boolean retryable = status == 408 || status == 429 || status >= 500;
                if (!retryable) {
                    log.warning(prefix + " Ingestor answered " + status + "; " + part.size()
                            + " event(s) rejected, not retried" + errorMessages(resp.body()));
                    drop(part, Reason.REJECTED, status);
                    r.dropped = part.size();
                    return r;
                }
                failure = "HTTP " + status;
                retryAfter = resp.retryAfter();
            } else {
                r.lastStatus = 0;
            }
            if (attempt >= maxRetries) {
                log.fine(prefix + " giving up after " + (attempt + 1) + " attempt(s): " + failure);
                return outage(r, part);
            }
            long delay = retryDelay(attempt, retryAfter);
            try {
                if (!sleepFor(delay)) {
                    return outage(r, part);
                }
            } catch (InterruptedException e) {
                log.log(Level.FINE, prefix + " retry backoff interrupted", e);
                return outage(r, part);
            }
        }
    }

    private Result outage(Result r, List<Entry<E>> part) {
        r.kind = Kind.OUTAGE;
        r.unsent = new ArrayList<>(part);
        return r;
    }

    @SuppressWarnings("unchecked")
    private List<Entry<E>> cast(List<Entry<?>> entries) {
        return (List<Entry<E>>) (List<?>) entries;
    }

    /**
     * Handles a 2xx: {@code errors[]} is authoritative — events named retryable are requeued
     * (at most {@code maxRetries} times, then the batch counts as an outage), the rest rejected.
     */
    private Result accepted(List<Entry<E>> part, String body) {
        Result r = new Result();
        Object unwrapped = null;
        Map<?, ?> data = null;
        if (body != null && !body.isBlank()) {
            try {
                Object root = MiniJson.parse(body);
                unwrapped = root;
                if (root instanceof Map<?, ?> m) {
                    data = m.get("data") instanceof Map<?, ?> d ? d : m;
                    unwrapped = data;
                }
            } catch (IllegalArgumentException e) {
                log.log(Level.FINE, prefix + " 2xx body is not JSON; treating the batch as accepted", e);
            }
        }
        List<Entry<E>> retry = new ArrayList<>();
        List<Entry<E>> rejected = new ArrayList<>();
        int unidentified = 0;
        int failed = 0;
        if (data != null) {
            boolean[] seen = new boolean[part.size()];
            if (data.get("errors") instanceof List<?> errs) {
                for (Object o : errs) {
                    if (!(o instanceof Map<?, ?> err) || !(err.get("index") instanceof Number n)) continue;
                    double d = n.doubleValue();
                    int idx = (int) d;
                    if (idx != d || idx < 0 || idx >= part.size() || seen[idx]) continue;
                    seen[idx] = true;
                    if (Boolean.TRUE.equals(err.get("retryable"))) retry.add(part.get(idx));
                    else rejected.add(part.get(idx));
                }
            }
            int reportedFailed = data.get("failed") instanceof Number f ? (int) f.doubleValue() : 0;
            failed = Math.min(part.size(), Math.max(reportedFailed, retry.size() + rejected.size()));
            unidentified = failed - retry.size() - rejected.size();
            if (failed > 0) {
                log.warning(prefix + " Ingestor refused " + failed + " of " + part.size() + " event(s)"
                        + (retry.isEmpty() ? "" : " (" + retry.size() + " retryable, requeued)") + errorMessages(body));
            }
        }
        if (retry.isEmpty()) {
            closeBreaker(); // a clean success ends the outage episode and resets the cooldown
        } else {
            breakerUntil = 0;
        }
        if (!rejected.isEmpty()) drop(rejected, Reason.REJECTED, 0);
        if (unidentified > 0) {
            long total = dropped.addAndGet(unidentified);
            log.warning(prefix + " " + unidentified + " refused event(s) were not identified by index ("
                    + total + " total dropped).");
            reportError(ErrorKind.REJECTED, "Aforo ingestor refused " + unidentified
                    + " event(s) without naming them", List.of(), 0);
        }
        if (!retry.isEmpty()) {
            boolean cap = false;
            for (Entry<E> e : retry) {
                if (++e.retryableAttempts > config.maxRetries) cap = true;
            }
            if (cap) {
                for (Entry<E> e : retry) e.retryableAttempts = 0;
                r.retryCapReached = true;
            } else {
                r.requeuedRetryable = true;
            }
            r.retryableCount = retry.size();
            requeueFront(retry);
        }
        r.sent = part.size() - failed;
        r.dropped = rejected.size() + unidentified;
        sentTotal.addAndGet(r.sent);
        if (acceptedHandler != null) {
            try {
                acceptedHandler.onAccepted(unwrapped, events(part));
            } catch (Throwable t) {
                log.log(Level.WARNING, prefix + " onAccepted hook threw; continuing", t);
            }
        }
        return r;
    }

    // ── backoff, breaker ──────────────────────────────────────────────────────

    /** Full jitter: {@code random(0, min(maxDelay, base * 2^attempt))}. */
    long jitter(int attempt) {
        long ceiling = cappedDouble(config.retryBaseMs, attempt, config.retryMaxDelayMs);
        return (long) Math.floor(timing.nextRandom() * ceiling);
    }

    /** {@code max(Retry-After, jitter)}, capped at 60 s when the header was usable. */
    long retryDelay(int attempt, String retryAfterHeader) {
        long jittered = jitter(attempt);
        long retryAfter = parseRetryAfter(retryAfterHeader);
        if (retryAfter < 0) return jittered;
        return Math.min(TransportConfig.RETRY_AFTER_CAP_MS, Math.max(retryAfter, jittered));
    }

    /**
     * Milliseconds from a delta-seconds (possibly fractional, {@code 1.5}) or HTTP-date
     * {@code Retry-After}; an HTTP-date in the past means 0; -1 when absent or unreadable.
     */
    long parseRetryAfter(String value) {
        if (value == null || value.isBlank()) return -1;
        String v = value.trim();
        if (DELTA_SECONDS.matcher(v).matches()) {
            double seconds = Double.parseDouble(v);
            double ms = Math.ceil(seconds * 1000);
            return ms >= TransportConfig.RETRY_AFTER_CAP_MS ? TransportConfig.RETRY_AFTER_CAP_MS : (long) ms;
        }
        try {
            long at = ZonedDateTime.parse(v, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli();
            return Math.max(0, at - timing.epochMillis());
        } catch (DateTimeParseException e) {
            log.log(Level.FINE, prefix + " ignoring unreadable Retry-After: " + v, e);
            return -1;
        }
    }

    private static final java.util.regex.Pattern DELTA_SECONDS = java.util.regex.Pattern.compile("\\d+(\\.\\d+)?");

    private static long cappedDouble(long base, int doublings, long cap) {
        long v = base;
        for (int i = 0; i < doublings && v < cap; i++) v = v * 2;
        return Math.min(v, cap);
    }

    /** Breaker cooldown after the n-th opening: {@code max(250 ms, random(0, min(max, initial * 2^(n-1))))}. */
    long breakerCooldown(int openings) {
        long ceiling = cappedDouble(config.breakerInitialMs, Math.max(0, openings - 1), config.breakerMaxMs);
        return Math.max(MIN_BREAKER_COOLDOWN_MS, (long) Math.floor(timing.nextRandom() * ceiling));
    }

    static final long MIN_BREAKER_COOLDOWN_MS = 250;

    private void openBreaker(int status, String location, int requeued, String reason) {
        boolean first = breakerOpenings == 0;
        breakerOpenings++;
        long cooldown = breakerCooldown(breakerOpenings);
        breakerUntil = timing.nowMillis() + cooldown;
        resumePending = true;
        List<E> kept = peekFront(requeued);
        boolean auth = status == 401 || status == 403;
        boolean redirect = status >= 300 && status < 400;
        if (auth || redirect) {
            if (!severeReported) {
                severeReported = true;
                String msg;
                ErrorKind kind;
                if (auth) {
                    kind = ErrorKind.AUTH;
                    msg = prefix + " Ingestor answered " + status + ": the API key is wrong or revoked. "
                            + requeued + " event(s) stay queued (" + size() + " in total) and are retried in "
                            + cooldown + " ms; fix the key to deliver them.";
                } else {
                    kind = ErrorKind.OUTAGE;
                    msg = prefix + " Ingestor answered " + status + " (redirect to " + redirectTarget(location)
                            + "); redirects are not followed because the API key must not reach another host. "
                            + requeued + " event(s) stay queued (" + size() + " in total); fix the base URL to"
                            + " deliver them.";
                }
                log.severe(msg);
                reportError(kind, msg, kept, status);
            } else {
                log.fine(prefix + " still " + reason + "; retrying in " + cooldown + " ms");
            }
            return;
        }
        log.warning(prefix + " Ingestor unreachable (" + reason + "); " + requeued + " event(s) put back in"
                + " the queue (" + size() + " in total), retrying in " + cooldown + " ms.");
        if (first) {
            reportError(ErrorKind.OUTAGE, prefix + " Ingestor unavailable (" + reason
                    + "). Events are kept and retried.", kept, status);
        }
    }

    /** Scheme, host and port of a redirect target, never its path or query. */
    private static String redirectTarget(String location) {
        if (location == null || location.isBlank()) return "an unknown location";
        try {
            java.net.URI u = java.net.URI.create(location.trim());
            if (u.getHost() == null) return "a relative location";
            return (u.getScheme() == null ? "" : u.getScheme() + "://") + u.getHost()
                    + (u.getPort() > 0 ? ":" + u.getPort() : "");
        } catch (IllegalArgumentException e) {
            return "an unreadable location";
        }
    }

    private void closeBreaker() {
        if (breakerOpenings > 0) {
            log.info(prefix + " Ingestor reachable again; resuming delivery.");
        }
        breakerOpenings = 0;
        breakerUntil = 0;
        severeReported = false;
    }

    /**
     * Sleeps {@code millis}; when closing, never past the shutdown deadline.
     *
     * @return {@code false} when the deadline cut the sleep short
     */
    private boolean sleepFor(long millis) throws InterruptedException {
        long target = timing.nowMillis() + Math.max(0, millis);
        while (true) {
            if (closing.get() && deadlineForced) return false;
            long now = timing.nowMillis();
            long limit = closing.get() ? Math.min(target, closeDeadline) : target;
            if (now >= limit) return now >= target;
            timing.sleep(limit - now, signal);
        }
    }

    // ── queue helpers ─────────────────────────────────────────────────────────

    private List<Entry<E>> pollBatch(int max) {
        List<Entry<E>> out = new ArrayList<>(Math.min(max, 64));
        queueLock.lock();
        try {
            while (out.size() < max) {
                Entry<E> e = queue.pollFirst();
                if (e == null) break;
                out.add(e);
            }
        } finally {
            queueLock.unlock();
        }
        return out;
    }

    /** The first {@code n} queued events (for an error report), without removing them. */
    private List<E> peekFront(int n) {
        List<E> out = new ArrayList<>(Math.min(Math.max(n, 0), 1024));
        queueLock.lock();
        try {
            java.util.Iterator<Entry<E>> it = queue.iterator();
            while (out.size() < n && it.hasNext()) out.add(it.next().event);
        } finally {
            queueLock.unlock();
        }
        return out;
    }

    private List<Entry<E>> pollAll() {
        queueLock.lock();
        try {
            List<Entry<E>> out = new ArrayList<>(queue);
            queue.clear();
            return out;
        } finally {
            queueLock.unlock();
        }
    }

    /** Puts entries back at the front in their original order; overflow evicts the oldest. */
    private void requeueFront(List<Entry<E>> entries) {
        if (entries.isEmpty()) return;
        List<Entry<E>> evicted = new ArrayList<>();
        queueLock.lock();
        try {
            for (int i = entries.size() - 1; i >= 0; i--) queue.addFirst(entries.get(i));
            while (queue.size() > config.maxQueueSize) evicted.add(queue.pollFirst());
        } finally {
            queueLock.unlock();
        }
        if (!evicted.isEmpty()) dropOverflow(evicted);
    }

    private List<List<Entry<E>>> splitByBytes(List<Entry<E>> batch) {
        List<List<Entry<E>>> parts = new ArrayList<>();
        List<Entry<E>> current = new ArrayList<>();
        long bytes = 12; // {"events":[]}
        for (Entry<E> e : batch) {
            long add = e.bytes + (current.isEmpty() ? 0 : 1);
            if (!current.isEmpty() && bytes + add > config.targetBodyBytes) {
                parts.add(current);
                current = new ArrayList<>();
                bytes = 12;
                add = e.bytes;
            }
            current.add(e);
            bytes += add;
        }
        if (!current.isEmpty()) parts.add(current);
        return parts;
    }

    private static <E> String body(List<Entry<E>> part) {
        StringBuilder b = new StringBuilder(64 + part.size() * 256);
        b.append("{\"events\":[");
        for (int i = 0; i < part.size(); i++) {
            if (i > 0) b.append(',');
            b.append(part.get(i).json);
        }
        return b.append("]}").toString();
    }

    /** {@code errors[].message} for a log line; "" when there are none. */
    private static String errorMessages(String body) {
        if (body == null || body.isBlank()) return "";
        try {
            Object root = MiniJson.parse(body);
            if (!(root instanceof Map<?, ?> m)) return "";
            Map<?, ?> data = m.get("data") instanceof Map<?, ?> d ? d : m;
            if (!(data.get("errors") instanceof List<?> errors) || errors.isEmpty()) return "";
            StringBuilder sb = new StringBuilder(":");
            int shown = 0;
            for (Object o : errors) {
                if (shown++ == 10) {
                    sb.append(" ...");
                    break;
                }
                if (!(o instanceof Map<?, ?> err)) continue;
                sb.append(" [");
                if (err.get("index") instanceof Number n) sb.append((long) n.doubleValue()).append(": ");
                sb.append(err.get("message") == null ? "" : String.valueOf(err.get("message"))).append(']');
            }
            return sb.toString();
        } catch (IllegalArgumentException e) {
            return "";
        }
    }

    // ── state, close ──────────────────────────────────────────────────────────

    /** Events waiting in the queue. */
    public int size() {
        queueLock.lock();
        try {
            return queue.size();
        } finally {
            queueLock.unlock();
        }
    }

    /** Events permanently dropped (every reason) since creation. */
    public long droppedCount() {
        return dropped.get();
    }

    /** Events the ingestor accepted since creation. */
    public long sentCount() {
        return sentTotal.get();
    }

    public boolean isClosed() {
        return closing.get();
    }

    /** The flusher thread (tests use it to prove there is exactly one). */
    public Thread flusherThread() {
        return flusher;
    }

    /**
     * Stops accepting events, sends what is queued until {@code shutdownTimeoutMs}
     * passes, and reports anything left as {@link Reason#SHUTDOWN}. Each request in
     * that window uses {@code min(timeout, time left)}; a request started before
     * close is cut at the deadline and its batch is reported too. Pending
     * {@link #flush()} calls are completed. Returns within the shutdown timeout plus
     * a short grace. A second call waits for the first and never drains again; a call
     * from a hook on the flusher thread returns at once and the flusher finishes the
     * drain itself.
     */
    @Override
    public void close() {
        if (!closing.compareAndSet(false, true)) {
            if (Thread.currentThread() != flusher) awaitTermination(config.shutdownTimeoutMs + CLOSE_GRACE_MS);
            return;
        }
        closeDeadline = timing.nowMillis() + config.shutdownTimeoutMs;
        synchronized (signal) {
            signal.notifyAll();
        }
        if (Thread.currentThread() == flusher) {
            return;
        }
        if (awaitTermination(config.shutdownTimeoutMs)) return;
        // Real time is up. Cut the request in flight (the JDK client cancels on interrupt);
        // the flusher puts its batch back and reports it as SHUTDOWN.
        deadlineForced = true;
        flusher.interrupt();
        synchronized (signal) {
            signal.notifyAll();
        }
        if (awaitTermination(CLOSE_GRACE_MS)) return;
        log.warning(prefix + " flusher did not stop within the shutdown deadline (a hook may be blocking);"
                + " reporting what is left and returning.");
        List<Entry<E>> left = pollAll();
        if (!left.isEmpty()) drop(left, Reason.SHUTDOWN, 0);
        complete(takeFlushRequests(), new FlushStats(0, 0, size()));
        closeSender();
    }

    private void closeSender() {
        if (senderClosed.compareAndSet(false, true)) {
            try {
                sender.close();
            } catch (RuntimeException e) {
                log.log(Level.FINE, prefix + " closing the HTTP sender failed", e);
            }
        }
    }

    private boolean awaitTermination(long millis) {
        try {
            terminated.get(millis, java.util.concurrent.TimeUnit.MILLISECONDS);
            return true;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        } catch (ExecutionException | java.util.concurrent.TimeoutException e) {
            return false;
        }
    }

    @Override
    public String toString() {
        return "TransportCore{" + config + ", queued=" + size() + ", dropped=" + dropped.get() + "}";
    }
}
