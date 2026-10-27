package com.aforo.metering.internal.transport;

import java.io.IOException;
import java.net.URI;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.DoubleSupplier;

/** Test doubles for the transport core: a scripted HTTP sender and a fake clock. */
final class Fakes {

    private Fakes() {
    }

    /**
     * Clock that only moves when the core sleeps; records every sleep. A sleep of
     * {@link #holdAtOrAbove} or more (a long breaker cooldown) does not move the clock:
     * it waits briefly in real time so the test decides when the cooldown ends by
     * advancing {@link #now}.
     */
    static final class FakeTiming implements Timing {
        volatile long holdAtOrAbove = 100_000;
        final AtomicLong now = new AtomicLong(1_000_000);
        final long epochOffset = 1_800_000_000_000L;
        final List<Long> sleeps = Collections.synchronizedList(new ArrayList<>());
        /** Long (held) sleeps: breaker cooldowns the test ends by moving {@link #now}. */
        final List<Long> held = Collections.synchronizedList(new ArrayList<>());
        volatile DoubleSupplier random = () -> 0.5;

        @Override public long nowMillis() { return now.get(); }
        @Override public long epochMillis() { return epochOffset + now.get(); }
        @Override public double nextRandom() { return random.getAsDouble(); }

        @Override
        public void sleep(long millis, Object monitor) throws InterruptedException {
            if (millis <= 0) return;
            if (millis >= holdAtOrAbove) {
                held.add(millis);
                synchronized (monitor) {
                    monitor.wait(10);
                }
                return;
            }
            sleeps.add(millis);
            now.addAndGet(millis);
        }
    }

    /** One scripted reply: a response, or an exception to throw. */
    interface Reply {
        HttpSender.Response answer(String body, long timeoutMs) throws IOException, InterruptedException;
    }

    static Reply status(int status) {
        return (b, t) -> new HttpSender.Response(status, "", null);
    }

    static Reply status(int status, String retryAfter) {
        return (b, t) -> new HttpSender.Response(status, "", retryAfter);
    }

    static Reply json(int status, String json) {
        return (b, t) -> new HttpSender.Response(status, json, null);
    }

    static Reply redirect(int status, String location) {
        return (b, t) -> new HttpSender.Response(status, "", null, location);
    }

    static Reply ioError() {
        return (b, t) -> { throw new IOException("connection refused"); };
    }

    /** Sender answering from a script; once empty, it answers {@code fallback}. */
    static final class FakeSender implements HttpSender {
        final Deque<Reply> script = new ArrayDeque<>();
        volatile Reply fallback = status(202);
        final List<String> bodies = Collections.synchronizedList(new ArrayList<>());
        final List<Map<String, String>> headers = Collections.synchronizedList(new ArrayList<>());
        final List<Long> timeouts = Collections.synchronizedList(new ArrayList<>());
        final AtomicInteger inFlight = new AtomicInteger();
        final AtomicInteger maxInFlight = new AtomicInteger();
        volatile boolean closed;

        FakeSender then(Reply r) {
            synchronized (script) {
                script.add(r);
            }
            return this;
        }

        @Override
        public Response post(URI uri, Map<String, String> h, String body, long timeoutMs)
                throws IOException, InterruptedException {
            int n = inFlight.incrementAndGet();
            maxInFlight.accumulateAndGet(n, Math::max);
            try {
                bodies.add(body);
                headers.add(h);
                timeouts.add(timeoutMs);
                Reply r;
                synchronized (script) {
                    r = script.isEmpty() ? fallback : script.poll();
                }
                return r.answer(body, timeoutMs);
            } finally {
                inFlight.decrementAndGet();
            }
        }

        @Override
        public void close() {
            closed = true;
        }

        int requests() {
            return bodies.size();
        }
    }
}
