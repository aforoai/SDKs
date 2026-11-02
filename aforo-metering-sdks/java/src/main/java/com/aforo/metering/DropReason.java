package com.aforo.metering;

/**
 * Why an event was permanently dropped by the SDK.
 */
public enum DropReason {

    /** The ring buffer was full — the OLDEST event was evicted to make room. */
    OVERFLOW,

    /**
     * Kept for compatibility. An outage no longer drops events: the batch goes back
     * to the queue behind a breaker. Only reported when a requeue is impossible.
     */
    RETRY_EXHAUSTED,

    /** The ingestor rejected the batch with a non-retryable 4xx (or the batch could not be serialized). */
    REJECTED,

    /**
     * The event breaks a constraint the ingestor enforces (blank customerId /
     * metricName, quantity &lt;= 0, a field over its length limit). It was never
     * buffered or sent.
     */
    INVALID,

    /** Still queued when {@link AforoClient#close()} reached its shutdown deadline. */
    SHUTDOWN,

    /** Tracked after {@link AforoClient#close()}; {@code track()} does not throw. */
    CLOSED
}
