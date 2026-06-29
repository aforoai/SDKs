package com.aforo.metering;

/**
 * Result of a flush operation.
 */
public record FlushResult(int sent, int failed) {

    public static FlushResult success(int count) {
        return new FlushResult(count, 0);
    }

    public static FlushResult failure(int count) {
        return new FlushResult(0, count);
    }

    public static FlushResult empty() {
        return new FlushResult(0, 0);
    }
}
