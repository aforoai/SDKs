package com.aforo.mqtt.internal.transport;

import java.util.concurrent.ThreadLocalRandom;

/**
 * Clock, sleep and random source used by the transport core for retry backoff,
 * {@code Retry-After}, breaker cooldowns and the shutdown deadline. Tests pass a
 * fake so backoff behaviour is checked without waiting on the wall clock.
 *
 * <p>This file is the transport core. Edit it in the {@code java} module only and
 * run {@code scripts/sync-transport.sh java}; the variants carry copies.</p>
 */
public interface Timing {

    /** Monotonic milliseconds; only differences are meaningful. */
    long nowMillis();

    /** Wall-clock epoch milliseconds, used to read an HTTP-date {@code Retry-After}. */
    long epochMillis();

    /** A uniformly distributed value in {@code [0, 1)}. */
    double nextRandom();

    /**
     * Waits up to {@code millis}. May return early when {@code monitor} is notified
     * (close, flush); callers re-check their condition and wait again.
     */
    void sleep(long millis, Object monitor) throws InterruptedException;

    /** Real time. */
    Timing SYSTEM = new Timing() {
        @Override
        public long nowMillis() {
            return System.nanoTime() / 1_000_000L;
        }

        @Override
        public long epochMillis() {
            return System.currentTimeMillis();
        }

        @Override
        public double nextRandom() {
            return ThreadLocalRandom.current().nextDouble();
        }

        @Override
        public void sleep(long millis, Object monitor) throws InterruptedException {
            if (millis <= 0) return;
            synchronized (monitor) {
                monitor.wait(millis);
            }
        }
    };
}
