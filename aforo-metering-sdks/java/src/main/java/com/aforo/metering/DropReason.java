package com.aforo.metering;

/**
 * Why an event was permanently dropped by the SDK.
 */
public enum DropReason {

    /** The ring buffer was full — the OLDEST event was evicted to make room. */
    OVERFLOW,

    /** A batch failed after all transport retries (ingest outage). */
    RETRY_EXHAUSTED,

    /** The ingestor rejected the batch with a non-retryable 4xx (or the batch could not be serialized). */
    REJECTED,

    /**
     * The event breaks a constraint the ingestor enforces (blank customerId /
     * metricName, quantity &lt;= 0, a field over its length limit). It was never
     * buffered or sent.
     */
    INVALID
}
