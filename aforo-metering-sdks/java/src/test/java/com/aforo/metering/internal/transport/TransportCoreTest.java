package com.aforo.metering.internal.transport;

import com.aforo.metering.internal.transport.Fakes.FakeSender;
import com.aforo.metering.internal.transport.Fakes.FakeTiming;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static com.aforo.metering.internal.transport.Fakes.ioError;
import static com.aforo.metering.internal.transport.Fakes.json;
import static com.aforo.metering.internal.transport.Fakes.status;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@DisplayName("TransportCore — wave 5 transport spec")
class TransportCoreTest {

    private static final Pattern KEY = Pattern.compile("\"k\":\"([^\"]+)\"");

    private final FakeSender sender = new FakeSender();
    private final FakeTiming timing = new FakeTiming();
    private final List<String> dropped = new CopyOnWriteArrayList<>();
    private final List<TransportCore.Reason> reasons = new CopyOnWriteArrayList<>();
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

    private TransportCore<String> core(TransportConfig.Builder b) {
        TransportCore<String> c = new TransportCore<>(b.build(), e -> "{\"k\":\"" + e + "\"}",
                (events, reason) -> {
                    dropped.addAll(events);
                    for (int i = 0; i < events.size(); i++) reasons.add(reason);
                }, sender, timing);
        open.add(c);
        return c;
    }

    private static List<String> keys(String body) {
        List<String> out = new ArrayList<>();
        Matcher m = KEY.matcher(body);
        while (m.find()) out.add(m.group(1));
        return out;
    }

    @Nested
    @DisplayName("Backoff")
    class Backoff {

        @Test
        void fullJitterStaysWithinTheCappedCeiling() {
            TransportCore<String> c = core(config());
            timing.random = () -> 0.999_999;
            assertThat(c.jitter(0)).isBetween(0L, 499L);
            assertThat(c.jitter(3)).isBetween(3_900L, 3_999L);
            assertThat(c.jitter(20)).isBetween(29_900L, 29_999L); // capped at maxDelay 30 s
            timing.random = () -> 0.0;
            assertThat(c.jitter(5)).isZero();
        }

        @Test
        void retryAfterDeltaSecondsWinsOverASmallerJitter() {
            TransportCore<String> c = core(config());
            timing.random = () -> 0.0;
            assertThat(c.retryDelay(0, "7")).isEqualTo(7_000);
        }

        @Test
        void retryAfterHttpDateIsRead() {
            TransportCore<String> c = core(config());
            timing.random = () -> 0.0;
            String date = DateTimeFormatter.RFC_1123_DATE_TIME.format(
                    ZonedDateTime.ofInstant(java.time.Instant.ofEpochMilli(timing.epochMillis() + 12_000), ZoneOffset.UTC));
            assertThat(c.retryDelay(0, date)).isBetween(11_000L, 12_000L);
        }

        @Test
        void retryAfterIsCappedAtSixtySeconds() {
            TransportCore<String> c = core(config());
            assertThat(c.retryDelay(0, "3600")).isEqualTo(60_000);
            assertThat(c.retryDelay(0, "99999999999999999999999")).isEqualTo(60_000);
        }

        @Test
        void unreadableRetryAfterIsIgnored() {
            TransportCore<String> c = core(config());
            timing.random = () -> 0.5;
            assertThat(c.parseRetryAfter("soon")).isEqualTo(-1);
            assertThat(c.retryDelay(1, "soon")).isEqualTo(500);
        }

        @Test
        void retriesUseJitteredDelaysAndKeepTheSameBody() {
            timing.random = () -> 0.5;
            sender.then(status(503)).then(ioError()).then(status(202));
            TransportCore<String> c = core(config());
            c.track("a");
            c.track("b");

            TransportCore.FlushStats stats = c.flush();

            assertThat(stats.sent()).isEqualTo(2);
            assertThat(sender.requests()).isEqualTo(3);
            assertThat(timing.sleeps).containsExactly(250L, 500L);
            assertThat(sender.bodies).allSatisfy(b -> assertThat(keys(b)).containsExactly("a", "b"));
        }

        @Test
        void retryAfterOn429IsHonoured() {
            timing.random = () -> 0.0;
            sender.then(status(429, "2")).then(status(202));
            TransportCore<String> c = core(config());
            c.track("a");
            c.flush();
            assertThat(timing.sleeps).containsExactly(2_000L);
        }
    }

    @Nested
    @DisplayName("Outage: requeue and breaker")
    class Outage {

        @Test
        void exhaustedRetriesRequeueWithTheSameKeysAndNothingIsDropped() {
            sender.fallback = ioError();
            TransportCore<String> c = core(config().maxRetries(2));
            c.track("a");
            c.track("b");

            TransportCore.FlushStats stats = c.flush();

            assertThat(stats.sent()).isZero();
            assertThat(stats.dropped()).isZero();
            assertThat(stats.pending()).isEqualTo(2);
            assertThat(c.droppedCount()).isZero();
            assertThat(reasons).isEmpty();
            assertThat(sender.requests()).isEqualTo(3);

            // Ingestor recovers; the breaker cooldown passes; the same keys are sent.
            sender.fallback = status(202);
            TransportCore.FlushStats after = waitForDelivery(c);
            assertThat(after.pending()).isZero();
            assertThat(keys(sender.bodies.get(sender.bodies.size() - 1))).containsExactly("a", "b");
        }

        @Test
        void unauthorizedIsAnOutageLoggedAtErrorNotADrop() {
            List<LogRecord> logs = capture();
            sender.fallback = status(401);
            TransportCore<String> c = core(config().maxRetries(3));
            c.track("a");
            c.flush();

            assertThat(sender.requests()).isEqualTo(1); // no pointless retries of a bad key
            assertThat(c.size()).isEqualTo(1);
            assertThat(c.droppedCount()).isZero();
            assertThat(logs).anySatisfy(r -> {
                assertThat(r.getLevel()).isEqualTo(Level.SEVERE);
                assertThat(r.getMessage()).contains("401").doesNotContain("sk_live_secret_value");
            });
        }

        @Test
        void forbiddenIsAnOutageToo() {
            sender.fallback = status(403);
            TransportCore<String> c = core(config());
            c.track("a");
            c.flush();
            assertThat(c.size()).isEqualTo(1);
            assertThat(reasons).isEmpty();
        }

        @Test
        void overflowWhileTheBreakerIsOpenEvictsTheOldest() {
            sender.fallback = ioError();
            TransportCore<String> c = core(config().maxRetries(0).maxQueueSize(3));
            timing.random = () -> 0.9;
            c.track("a");
            c.flush(); // outage, breaker open for a long time
            c.track("b");
            c.track("c");
            c.track("d");

            assertThat(reasons).containsExactly(TransportCore.Reason.OVERFLOW);
            assertThat(dropped).containsExactly("a");
            assertThat(c.size()).isEqualTo(3);
        }

        /** A cooldown of 0 ms (full jitter can draw 0) must still resend on its own, without a new track(). */
        @Test
        void aZeroCooldownStillResendsWithoutNewTraffic() throws Exception {
            timing.random = () -> 0.0;
            sender.then(ioError());
            TransportCore<String> c = core(config().maxRetries(0).breakerInitialMs(5_000));
            c.track("a");
            c.flush(); // outage; cooldown drawn as 0 ms
            long deadline = System.nanoTime() + 5_000_000_000L;
            while (sender.requests() < 2 && System.nanoTime() < deadline) Thread.sleep(10);
            assertThat(sender.requests()).isEqualTo(2);
            assertThat(keys(sender.bodies.get(1))).containsExactly("a");
        }

        private TransportCore.FlushStats waitForDelivery(TransportCore<String> c) {
            TransportCore.FlushStats last = null;
            for (int i = 0; i < 50 && c.size() > 0; i++) {
                timing.now.addAndGet(2_000_000); // past the breaker cooldown
                last = c.flush();
            }
            return last == null ? c.flush() : last;
        }
    }

    @Nested
    @DisplayName("Status handling")
    class Statuses {

        @Test
        void otherClientErrorsAreRejectedWithoutRetry() {
            sender.fallback = status(400);
            TransportCore<String> c = core(config());
            c.track("a");
            TransportCore.FlushStats stats = c.flush();
            assertThat(stats.dropped()).isEqualTo(1);
            assertThat(sender.requests()).isEqualTo(1);
            assertThat(reasons).containsExactly(TransportCore.Reason.REJECTED);
        }

        @Test
        void payloadTooLargeSplitsInHalfAndRejectsASingleEvent() {
            // 413 for any body with more than one event, then 413 again for "c" alone.
            sender.fallback = (body, t) -> {
                List<String> k = keys(body);
                if (k.size() > 1 || k.contains("c")) return new HttpSender.Response(413, "", null);
                return new HttpSender.Response(202, "", null);
            };
            TransportCore<String> c = core(config());
            for (String k : List.of("a", "b", "c", "d")) c.track(k);

            TransportCore.FlushStats stats = c.flush();

            assertThat(stats.sent()).isEqualTo(3);
            assertThat(stats.dropped()).isEqualTo(1);
            assertThat(dropped).containsExactly("c");
            assertThat(reasons).containsExactly(TransportCore.Reason.REJECTED);
        }

        @Test
        void perEventRetryableFailuresGoBackToTheQueueAndTheRestAreRejected() {
            sender.then(json(202, "{\"success\":true,\"data\":{\"accepted\":1,\"failed\":2,\"errors\":["
                    + "{\"index\":1,\"message\":\"busy\",\"retryable\":true},"
                    + "{\"index\":2,\"message\":\"unknown metric\",\"retryable\":false}]},\"meta\":{}}"));
            TransportCore<String> c = core(config());
            c.track("a");
            c.track("b");
            c.track("c");

            TransportCore.FlushStats first = c.flush();
            assertThat(first.sent()).isEqualTo(1);
            assertThat(first.dropped()).isEqualTo(1);
            assertThat(dropped).containsExactly("c");

            // "b" is resent on its own after a short jittered backoff, with its key.
            for (int i = 0; i < 100 && sender.requests() < 2; i++) c.flush();
            c.flush();
            assertThat(c.size()).isZero();
            assertThat(keys(sender.bodies.get(sender.bodies.size() - 1))).containsExactly("b");
            assertThat(sender.requests()).isEqualTo(2);
        }

        @Test
        void bodiesAreSplitAtTheTargetSize() {
            TransportCore<String> c = core(config().targetBodyBytes(1024).flushCount(100));
            String big = "x".repeat(400);
            for (int i = 0; i < 6; i++) c.track(big + i);
            c.flush();
            assertThat(sender.requests()).isGreaterThan(1);
            assertThat(sender.bodies).allSatisfy(b -> assertThat(b.length()).isLessThanOrEqualTo(1024));
        }

        @Test
        void headersCarryTheKeyOnlyInXApiKey() {
            TransportCore<String> c = core(config().header("X-Tenant-Id", "t1").userAgent("aforo-test/9"));
            c.track("a");
            c.flush();
            Map<String, String> h = sender.headers.get(0);
            assertThat(h).containsEntry("X-API-Key", "sk_live_secret_value")
                    .containsEntry("Content-Type", "application/json")
                    .containsEntry("User-Agent", "aforo-test/9")
                    .containsEntry("X-Tenant-Id", "t1")
                    .doesNotContainKeys("Authorization", "Content-Encoding");
            assertThat(sender.bodies.get(0)).doesNotContain("sk_live_secret_value");
        }
    }

    @Nested
    @DisplayName("Single flusher (G308)")
    class SingleFlusher {

        @Test
        void trackNeverStartsAThreadOrARequest() throws Exception {
            TransportCore<String> c = core(config().flushCount(1).maxQueueSize(100_000));
            long before = flusherThreads();
            for (int i = 0; i < 20_000; i++) c.track("e" + i);
            assertThat(flusherThreads()).isEqualTo(before);
            c.flush();
            assertThat(sender.maxInFlight.get()).isEqualTo(1);
            assertThat(flusherThreads()).isEqualTo(before);
        }

        @Test
        void manyTrackingThreadsStillGiveOneRequestAtATime() throws Exception {
            TransportCore<String> c = core(config().flushCount(5).maxQueueSize(100_000));
            List<Thread> threads = new ArrayList<>();
            for (int t = 0; t < 8; t++) {
                int n = t;
                Thread th = new Thread(() -> { for (int i = 0; i < 2_000; i++) c.track(n + "-" + i); });
                threads.add(th);
                th.start();
            }
            for (Thread th : threads) th.join();
            c.flush();
            assertThat(sender.maxInFlight.get()).isEqualTo(1);
        }

        private long flusherThreads() {
            return Thread.getAllStackTraces().keySet().stream()
                    .filter(t -> t.getName().equals("aforo-metering-flush")).count();
        }
    }

    @Nested
    @DisplayName("Shutdown")
    class Shutdown {

        @Test
        void closeSendsWhatIsQueued() {
            TransportCore<String> c = core(config());
            c.track("a");
            c.track("b");
            c.close();
            assertThat(c.sentCount()).isEqualTo(2);
            assertThat(reasons).isEmpty();
            assertThat(sender.closed).isTrue();
        }

        @Test
        void leftoversAtTheDeadlineAreReportedAsShutdown() {
            sender.fallback = ioError();
            TransportCore<String> c = core(config().shutdownTimeoutMs(5_000).maxRetries(3));
            c.track("a");
            c.track("b");
            long start = timing.nowMillis();

            c.close();

            assertThat(dropped).containsExactly("a", "b");
            assertThat(reasons).containsOnly(TransportCore.Reason.SHUTDOWN);
            // Never slept past the deadline.
            assertThat(timing.nowMillis() - start).isLessThanOrEqualTo(5_000);
            // Each request used min(timeout, time left).
            assertThat(sender.timeouts).allSatisfy(t -> assertThat(t).isLessThanOrEqualTo(5_000));
        }

        @Test
        void trackAfterCloseIsReportedAsClosedAndDoesNotThrow() {
            TransportCore<String> c = core(config());
            c.close();
            assertThat(c.track("late")).isFalse();
            assertThat(reasons).containsExactly(TransportCore.Reason.CLOSED);
            assertThat(c.droppedCount()).isEqualTo(1);
        }

        @Test
        void closeIsIdempotent() {
            TransportCore<String> c = core(config());
            c.close();
            c.close();
            assertThat(c.isClosed()).isTrue();
        }

        @Test
        void aThrowingDropHookIsContained() {
            TransportCore<String> c = new TransportCore<>(config().build(), e -> "{\"k\":\"" + e + "\"}",
                    (events, reason) -> { throw new IllegalStateException("hook bug"); }, sender, timing);
            open.add(c);
            c.close();
            assertThat(c.track("x")).isFalse();
            assertThat(c.droppedCount()).isEqualTo(1);
        }
    }

    @Nested
    @DisplayName("Configuration (G270)")
    class Configuration {

        @Test
        void plainHttpIsRefusedForARemoteHost() {
            assertThatThrownBy(() -> TransportConfig.builder().baseUrl("http://ingest.example.com").apiKey("k").build())
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("https");
        }

        @Test
        void plainHttpIsAllowedForLoopbackOrWithTheOptIn() {
            assertThat(TransportConfig.builder().baseUrl("http://localhost:8080/").apiKey("k").build().ingestUri())
                    .hasToString("http://localhost:8080/v1/ingest/batch");
            assertThat(TransportConfig.builder().baseUrl("http://127.0.0.1:1").apiKey("k").build().ingestUri()).isNotNull();
            assertThat(TransportConfig.builder().baseUrl("http://[::1]:1").apiKey("k").build().ingestUri()).isNotNull();
            assertThat(TransportConfig.builder().baseUrl("http://ingest.internal").apiKey("k")
                    .allowInsecureHttp(true).build().ingestUri()).isNotNull();
        }

        @Test
        void otherSchemesAreRefused() {
            assertThatThrownBy(() -> TransportConfig.builder().baseUrl("ftp://x.example").apiKey("k").build())
                    .isInstanceOf(IllegalArgumentException.class);
        }

        @Test
        void theApiKeyNeverAppearsInToString() {
            TransportConfig.Builder b = config();
            assertThat(b.toString()).doesNotContain("sk_live_secret_value");
            assertThat(b.build().toString()).doesNotContain("sk_live_secret_value").contains("[redacted]");
            assertThat(core(config()).toString()).doesNotContain("sk_live_secret_value");
        }

        @Test
        void flushCountDefaultsTo500AndIsClampedTo1000() {
            assertThat(TransportConfig.builder().baseUrl("https://x").apiKey("k").build().flushCount()).isEqualTo(500);
            assertThat(TransportConfig.builder().baseUrl("https://x").apiKey("k").flushCount(5_000).build().flushCount())
                    .isEqualTo(1000);
        }
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
