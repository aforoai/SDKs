package com.aforo.metering;

/**
 * Bounds a label the SDK copies from an incoming request (path, HTTP method)
 * to the ingestor's length limit, so an over-long request is still metered.
 *
 * <p>Only for request-derived labels. Fields the caller sets
 * ({@code customerId}, {@code metricName}, {@code idempotencyKey},
 * {@code productType}) are never altered — see {@link EventLimits}.</p>
 */
public final class RequestLabels {

    private RequestLabels() {
    }

    /**
     * {@code value} cut to at most {@code max} UTF-16 code units — the unit the
     * ingestor's {@code @Size} counts. A surrogate pair is never split: when the
     * cut would land inside one, the result is one unit shorter.
     */
    public static String truncate(String value, int max) {
        if (value == null || value.length() <= max) return value;
        int end = Math.max(max, 0);
        if (end > 0 && Character.isHighSurrogate(value.charAt(end - 1))
                && Character.isLowSurrogate(value.charAt(end))) {
            end--;
        }
        return value.substring(0, end);
    }
}
