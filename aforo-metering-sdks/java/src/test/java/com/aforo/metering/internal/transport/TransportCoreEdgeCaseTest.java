package com.aforo.metering.internal.transport;

import com.aforo.metering.internal.transport.Fakes.FakeSender;
import com.aforo.metering.internal.transport.Fakes.FakeTiming;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static com.aforo.metering.internal.transport.Fakes.ioError;
import static com.aforo.metering.internal.transport.Fakes.json;
import static com.aforo.metering.internal.transport.Fakes.redirect;
import static com.aforo.metering.internal.transport.Fakes.status;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * One test (at least) per row of contract/TRANSPORT-SPEC.md, "Edge cases every core
 * handles the same way", plus the 2026-10-26 review findings 5 and 12.
 */
@DisplayName("TransportCore — edge cases every core handles the same way")
class TransportCoreEdgeCaseTest {

    private static final Pattern KEY = Pattern.compile("\"k\":\"([^\"]+)\"");
    private static final String RETRYABLE_A = "{\"success\":true,\"data\":{\"accepted\":0,\"failed\":1,\"errors\":["
            + "{\"index\":0,\"message\":\"busy\",\"retryable\":true}]},\"meta\":{}}";

    private final FakeSender sender = new FakeSender();
    private final FakeTiming timing = new FakeTiming();
    private final List<String> dropped = new CopyOnWriteArrayList<>();
    private final List<TransportCore.Reason> reasons = new CopyOnWriteArrayList<>();
    private final List<TransportCore.TransportError<String>> errors = new CopyOnWriteArrayList<>();
    private final List<Object> acceptedBodies = new CopyOnWriteArrayList<>();
    private final List<TransportCore<String>> open = new ArrayList<>();

    @AfterEach
    void closeAll() {
        open.forEach(TransportCore::close);
    }

    private TransportConfig.Builder config() {
        return TransportConfig.builder()
                .baseUrl("https://ingest.example.test")
                .apiKey("sk_live_secret_value")
                .flushIntervalMs(3_600_000)
                .breakerInitialMs(1_000_000) // held by FakeTiming until a test advances the clock
                .flushCount(10);
    }

    private TransportCore.Listeners<String> listeners() {
        return TransportCore.Listeners.<String>builder()
                .onDrop((events, reason) -> {
                    dropped.addAll(events);
                    for (int i = 0; i < events.size(); i++) reasons.add(reason);
                })
                .onError(errors::add)
                .onAccepted((body, events) -> acceptedBodies.add(body))
                .build();
    }

    private TransportCore<String> core(TransportConfig.Builder b) {
        return core(b, listeners(), sender, timing);
    }

    private TransportCore<String> core(TransportConfig.Builder b, TransportCore.Listeners<String> l,
                                       HttpSender s, Timing t) {
        TransportCore<String> c = new TransportCore<>(b.build(), e -> "{\"k\":\"" + e + "\"}", l, s, t);
        open.add(c);
        return c;
    }

    private static List<String> keys(String body) {
        List<String> out = new ArrayList<>();
        Matcher m = KEY.matcher(body);
        while (m.find()) out.add(m.group(1));
        return out;
    }

    private static void await(String what, long timeoutMs, BooleanSupplier condition) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        while (!condition.getAsBoolean()) {
            if (System.nanoTime() > deadline) throw new AssertionError("timed out waiting for " + what);
            Thread.sleep(5);
        }
    }

    private List<TransportCore.ErrorKind> kinds() {
        List<TransportCore.ErrorKind> out = new ArrayList<>();
        for (TransportCore.TransportError<String> e : errors) out.add(e.kind());
        return out;
    }

    // ── Finding 5: shutdown is bounded and accounts for the batch in flight ─────────

    /** Sender that blocks for its whole timeout, like a hung server; it answers to interrupts as the JDK client does. */
    private static final class HangingSender implements HttpSender {
        final AtomicInteger started = new AtomicInteger();

        @Override
        public Response post(URI uri, Map<String, String> headers, String body, long timeoutMs)
                throws InterruptedException {
            started.incrementAndGet();
            Thread.sleep(timeoutMs);
            return new Response(202, "", null);
        }

        @Override
        public void close() {
        }
    }

    @Test
    void closeCutsARequestStartedBeforeCloseAtTheShutdownDeadlineAndReportsItsBatch() throws Exception {
        HangingSender hung = new HangingSender();
        TransportCore<String> c = core(config().timeoutMs(30_000).shutdownTimeoutMs(300), listeners(), hung,
                Timing.SYSTEM);
        for (int i = 0; i < 10; i++) c.track("e" + i);
        CompletableFuture<TransportCore.FlushStats> flush = CompletableFuture.supplyAsync(c::flush);
        await("request in flight", 5_000, () -> hung.started.get() > 0);

        long t0 = System.nanoTime();
        c.close();
        long tookMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0);

        assertThat(tookMs).as("close() overran shutdownTimeoutMs").isLessThan(300 + 1_000);
        assertThat(dropped).hasSize(10);
        assertThat(reasons).containsOnly(TransportCore.Reason.SHUTDOWN);
        assertThat(c.droppedCount()).isEqualTo(10);
        assertThat(flush.get(2, TimeUnit.SECONDS)).isNotNull(); // the pending flush() was completed
        assertThat(kinds()).contains(TransportCore.ErrorKind.SHUTDOWN);
    }

    @Test
    void secondCloseReturnsWithoutASecondDrain() {
        TransportCore<String> c = core(config());
        c.track("a");
        c.close();
        int requests = sender.requests();
        c.track("b"); // CLOSED
        c.close();
        assertThat(sender.requests()).isEqualTo(requests);
        assertThat(c.sentCount()).isEqualTo(1);
    }

    // ── Redirects ────────────────────────────────────────────────────────────────

    @Test
    void aRedirectIsAnOutageLoggedWithTheTargetHostNotFollowed() {
        List<LogRecord> logs = capture();
        sender.fallback = redirect(307, "https://elsewhere.example.net/v1/ingest/batch");
        TransportCore<String> c = core(config().maxRetries(3));
        c.track("a");

        TransportCore.FlushStats stats = c.flush();

        assertThat(sender.requests()).isEqualTo(1); // not retried, not followed
        assertThat(stats.pending()).isEqualTo(1);
        assertThat(c.droppedCount()).isZero();
        assertThat(logs).anySatisfy(r -> {
            assertThat(r.getLevel()).isEqualTo(Level.SEVERE);
            assertThat(r.getMessage()).contains("307").contains("elsewhere.example.net")
                    .doesNotContain("sk_live_secret_value");
        });
        assertThat(kinds()).containsExactly(TransportCore.ErrorKind.OUTAGE);
        assertThat(errors.get(0).status()).isEqualTo(307);
        assertThat(errors.get(0).events()).containsExactly("a");
    }

    // ── 5xx ──────────────────────────────────────────────────────────────────────

    @Test
    void everyServerErrorIsRetried() {
        timing.random = () -> 0.0;
        sender.then(status(501)).then(status(505)).then(status(599)).then(status(202));
        TransportCore<String> c = core(config().maxRetries(3));
        c.track("a");
        assertThat(c.flush().sent()).isEqualTo(1);
        assertThat(sender.requests()).isEqualTo(4);
    }

    // ── Per-event retryable ──────────────────────────────────────────────────────

    @Test
    void perEventRetryableIsCappedAtMaxRetriesWithBackoffThenTreatedAsAnOutage() throws Exception {
        sender.fallback = json(202, RETRYABLE_A);
        TransportCore<String> c = core(config().maxRetries(2).retryBaseMs(500));
        c.track("a");
        c.flush();

        await("outage after the per-event cap", 5_000, () -> !errors.isEmpty());
        Thread.sleep(50); // a tight loop would keep sending while the breaker is open
        assertThat(sender.requests()).isEqualTo(3); // first send + maxRetries resends
        assertThat(kinds()).containsExactly(TransportCore.ErrorKind.OUTAGE);
        assertThat(c.size()).isEqualTo(1);
        assertThat(timing.sleeps).hasSizeGreaterThanOrEqualTo(2).allSatisfy(s -> assertThat(s).isPositive());
        assertThat(keys(sender.bodies.get(2))).containsExactly("a");
    }

    @Test
    void aRetryableTwoHundredDoesNotResetTheBreakerSoTheCooldownGrows() throws Exception {
        timing.random = () -> 0.5;
        sender.fallback = json(202, RETRYABLE_A);
        TransportCore<String> c = core(config().maxRetries(0).breakerMaxMs(10_000_000));
        c.track("a");
        c.flush();
        await("first opening", 5_000, () -> timing.held.contains(500_000L));
        timing.now.addAndGet(600_000); // past the first cooldown
        await("second opening", 5_000, () -> timing.held.contains(1_000_000L));
    }

    // ── Breaker cooldown ─────────────────────────────────────────────────────────

    @Test
    void breakerCooldownIsAtLeast250msAndCapped() {
        TransportCore<String> c = core(config().breakerInitialMs(5_000).breakerMaxMs(300_000));
        timing.random = () -> 0.0;
        assertThat(c.breakerCooldown(1)).isEqualTo(250);
        timing.random = () -> 0.5;
        assertThat(c.breakerCooldown(1)).isEqualTo(2_500);
        assertThat(c.breakerCooldown(2)).isEqualTo(5_000);
        timing.random = () -> 0.999_999;
        assertThat(c.breakerCooldown(40)).isBetween(299_000L, 300_000L);
    }

    // ── flush() while the breaker is open ────────────────────────────────────────

    @Test
    void explicitFlushWhileTheBreakerIsOpenMakesOneAttempt() {
        sender.fallback = ioError();
        TransportCore<String> c = core(config().maxRetries(3));
        c.track("a");
        c.flush(); // 4 attempts, breaker open for a long time
        assertThat(sender.requests()).isEqualTo(4);

        c.flush();
        assertThat(sender.requests()).isEqualTo(5); // one attempt, not zero and not four

        sender.fallback = status(202);
        TransportCore.FlushStats stats = c.flush();
        assertThat(stats.sent()).isEqualTo(1);
        assertThat(c.size()).isZero();
    }

    // ── Shutdown after an outage ─────────────────────────────────────────────────

    @Test
    void shutdownAfterAnOutageKeepsRetryingUntilTheDeadline() {
        sender.fallback = ioError();
        TransportCore<String> c = core(config().maxRetries(0).shutdownTimeoutMs(5_000));
        c.track("a");
        c.flush(); // outage; breaker held open
        int before = sender.requests();
        long start = timing.nowMillis();

        c.close();

        assertThat(sender.requests() - before).as("retries during shutdown").isGreaterThan(1);
        assertThat(timing.nowMillis() - start).isLessThanOrEqualTo(5_000);
        assertThat(reasons).containsExactly(TransportCore.Reason.SHUTDOWN);
    }

    @Test
    void shutdownAfterAnOutageDeliversWhenTheIngestorRecovers() {
        sender.fallback = ioError();
        TransportCore<String> c = core(config().maxRetries(0).shutdownTimeoutMs(5_000));
        c.track("a");
        c.flush();
        sender.then(ioError()).then(status(202));
        c.close();
        assertThat(reasons).isEmpty();
        assertThat(c.sentCount()).isEqualTo(1);
    }

    // ── A batch split in flight at shutdown ──────────────────────────────────────

    @Test
    void theUnsentHalfOfASplitBatchAtTheDeadlineIsReportedAsShutdown() {
        sender.fallback = (body, t) -> {
            List<String> k = keys(body);
            if (k.size() > 1) return new HttpSender.Response(413, "", null);
            timing.now.addAndGet(2_000); // the first half uses up the shutdown window
            return new HttpSender.Response(202, "", null);
        };
        TransportCore<String> c = core(config().shutdownTimeoutMs(1_000));
        c.track("a");
        c.track("b");

        c.close();

        assertThat(c.sentCount()).isEqualTo(1);
        assertThat(dropped).containsExactly("b");
        assertThat(reasons).containsExactly(TransportCore.Reason.SHUTDOWN);
    }

    // ── Unserializable events ────────────────────────────────────────────────────

    @Test
    void anEventThatCannotBeSerializedIsDroppedAsInvalidAtTrack() {
        TransportCore<String> c = new TransportCore<>(config().build(), e -> {
            if (e.equals("cycle")) throw new StackOverflowError("cyclic metadata");
            return "{\"k\":\"" + e + "\"}";
        }, listeners(), sender, timing);
        open.add(c);

        assertThat(c.track("cycle")).isFalse();
        assertThat(c.track("ok")).isTrue();
        assertThat(reasons).containsExactly(TransportCore.Reason.INVALID);
        assertThat(c.flush().sent()).isEqualTo(1);
        assertThat(keys(sender.bodies.get(0))).containsExactly("ok");
    }

    // ── Callbacks ────────────────────────────────────────────────────────────────

    @Test
    void callbacksMayCallFlushAndCloseWithoutDeadlockAndTheirExceptionsAreContained() throws Exception {
        sender.then(status(400)).fallback = status(202);
        List<TransportCore<String>> self = new ArrayList<>();
        TransportCore.Listeners<String> l = TransportCore.Listeners.<String>builder()
                .onDrop((events, reason) -> { self.get(0).flush(); throw new IllegalStateException("drop hook"); })
                .onError(e -> { self.get(0).flush(); self.get(0).close(); throw new IllegalStateException("error hook"); })
                .onAccepted((body, events) -> { throw new IllegalStateException("accepted hook"); })
                .build();
        TransportCore<String> c = core(config(), l, sender, timing);
        self.add(c);
        c.track("a");

        CompletableFuture<TransportCore.FlushStats> f = CompletableFuture.supplyAsync(c::flush);
        assertThat(f.get(5, TimeUnit.SECONDS).dropped()).isEqualTo(1);
        await("close from the hook", 5_000, c::isClosed);
        CompletableFuture.runAsync(c::close).get(5, TimeUnit.SECONDS);
    }

    @Test
    void onErrorIsTypedByKind() {
        sender.then(status(400));
        TransportCore<String> c = core(config());
        c.track("a");
        c.flush();
        assertThat(kinds()).containsExactly(TransportCore.ErrorKind.REJECTED);
        assertThat(errors.get(0).events()).containsExactly("a");
        assertThat(errors.get(0).willRetry()).isFalse();

        sender.fallback = status(401);
        c.track("b");
        c.flush();
        c.flush(); // still 401 while the breaker is open: reported once per opening
        assertThat(kinds()).containsExactly(TransportCore.ErrorKind.REJECTED, TransportCore.ErrorKind.AUTH);
        assertThat(errors.get(1).willRetry()).isTrue();
        assertThat(errors.get(1).status()).isEqualTo(401);
        assertThat(errors.get(1).message()).doesNotContain("sk_live_secret_value");

        c.close();
        c.track("late");
        assertThat(kinds()).contains(TransportCore.ErrorKind.SHUTDOWN, TransportCore.ErrorKind.CLOSED);
    }

    @Test
    void onAcceptedGetsTheUnwrappedBody() {
        sender.then(json(202, "{\"success\":true,\"data\":{\"accepted\":1,\"killedSessionIds\":[\"s1\"]},\"meta\":{}}"));
        TransportCore<String> c = core(config());
        c.track("a");
        c.flush();
        assertThat(acceptedBodies).hasSize(1);
        assertThat(acceptedBodies.get(0)).isInstanceOf(Map.class);
        assertThat(((Map<?, ?>) acceptedBodies.get(0)).get("killedSessionIds")).isEqualTo(List.of("s1"));
    }

    // ── errors[] is authoritative ────────────────────────────────────────────────

    @Test
    void errorsArrayIsAuthoritativeWhenFailedIsMissingOrZero() {
        sender.then(json(202, "{\"data\":{\"accepted\":2,\"errors\":[{\"index\":0,\"message\":\"bad\",\"retryable\":false}]}}"))
                .then(json(202, "{\"data\":{\"accepted\":2,\"failed\":0,\"errors\":[{\"index\":1,\"message\":\"bad\"}]}}"));
        TransportCore<String> c = core(config());
        c.track("a");
        c.track("b");
        assertThat(c.flush().dropped()).isEqualTo(1);
        c.track("c");
        c.track("d");
        assertThat(c.flush().dropped()).isEqualTo(1);
        assertThat(dropped).containsExactly("a", "d");
    }

    // ── Retry-After ──────────────────────────────────────────────────────────────

    @Test
    void retryAfterMayBeFractionalAndAPastDateMeansZero() {
        TransportCore<String> c = core(config());
        timing.random = () -> 0.0;
        assertThat(c.parseRetryAfter("1.5")).isEqualTo(1_500);
        assertThat(c.retryDelay(0, "0.25")).isEqualTo(250);
        String past = DateTimeFormatter.RFC_1123_DATE_TIME.format(
                ZonedDateTime.ofInstant(java.time.Instant.ofEpochMilli(timing.epochMillis() - 60_000), ZoneOffset.UTC));
        assertThat(c.parseRetryAfter(past)).isZero();
        assertThat(c.parseRetryAfter("-1")).isEqualTo(-1);
    }

    private static List<LogRecord> capture() {
        List<LogRecord> records = Collections.synchronizedList(new ArrayList<>());
        Logger logger = Logger.getLogger(TransportCore.class.getName());
        logger.addHandler(new Handler() {
            @Override public void publish(LogRecord record) { records.add(record); }
            @Override public void flush() { }
            @Override public void close() { }
        });
        return records;
    }
}
