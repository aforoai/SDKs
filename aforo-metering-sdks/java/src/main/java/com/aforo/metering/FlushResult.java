package com.aforo.metering;

/**
 * Result of a flush operation.
 *
 * @param sent   events successfully delivered
 * @param failed events permanently lost
 * @param reason why the batch failed, when {@code failed > 0}; null on success
 */
public record FlushResult(int sent, int failed, DropReason reason) {

    /** Backward-compatible constructor — no failure reason. */
    public FlushResult(int sent, int failed) {
        this(sent, failed, null);
    }

    public static FlushResult success(int count) {
        return new FlushResult(count, 0, null);
    }

    public static FlushResult failure(int count) {
        return new FlushResult(0, count, DropReason.RETRY_EXHAUSTED);
    }

    public static FlushResult failure(int count, DropReason reason) {
        return new FlushResult(0, count, reason);
    }

    public static FlushResult empty() {
        return new FlushResult(0, 0, null);
    }
}
