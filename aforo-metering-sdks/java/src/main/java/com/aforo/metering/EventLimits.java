package com.aforo.metering;

import java.math.BigDecimal;

/**
 * Client-side mirror of the ingestor's per-event field constraints.
 *
 * <p>An event that breaks one of these is rejected by the ingestor and never
 * billed. The server reports it per event (indexed {@code errors[]} in the batch
 * response), but the SDK flushes in the background, so that report reaches
 * nobody: the usage is simply gone. Checking the same limits at {@code track()}
 * surfaces the problem where it can still be acted on.</p>
 *
 * <p>Source: {@code dto/IngestUsageEventRequest} in
 * aforo-nextgen-usage-ingestor-service — the {@code @Size} and {@code @Digits}
 * bean constraints, which are compiled into the server and therefore identical
 * in every environment.</p>
 *
 * <p>Deliberately NOT mirrored: the timestamp window ({@code max-age-days},
 * {@code future-tolerance-minutes}) and the metadata cap
 * ({@code max-metadata-bytes}) from {@code validation/UsageEventValidator}. Each
 * is a per-environment property — a tenant may raise {@code max-age-days} to 365
 * for backfills — so enforcing the default here would make the SDK refuse usage
 * its own server would accept and bill.</p>
 *
 * <p>Nothing here truncates or rounds: that would change what is billed.</p>
 */
final class EventLimits {

    static final int MAX_CUSTOMER_ID = 64;
    static final int MAX_METRIC_NAME = 255;
    static final int MAX_IDEMPOTENCY_KEY = 255;
    static final int MAX_PRODUCT_TYPE = 20;

    /** {@code @Digits(integer = 14, fraction = 6)} — quantity is NUMERIC(20,6). */
    static final int MAX_QUANTITY_INTEGER_DIGITS = 14;
    static final int MAX_QUANTITY_DECIMAL_PLACES = 6;

    private EventLimits() {
    }

    /** The first constraint this event breaks, or null when it would be accepted. */
    static String describeViolation(String customerId, String metricName,
                                    String idempotencyKey, String productType, double quantity) {
        String lengthProblem = length("customerId", customerId, MAX_CUSTOMER_ID);
        if (lengthProblem != null) return lengthProblem;
        lengthProblem = length("metricName", metricName, MAX_METRIC_NAME);
        if (lengthProblem != null) return lengthProblem;
        lengthProblem = length("idempotencyKey", idempotencyKey, MAX_IDEMPOTENCY_KEY);
        if (lengthProblem != null) return lengthProblem;
        lengthProblem = length("productType", productType, MAX_PRODUCT_TYPE);
        if (lengthProblem != null) return lengthProblem;
        return quantity(quantity);
    }

    private static String length(String field, String value, int max) {
        if (value == null || value.length() <= max) return null;
        return field + " is " + value.length() + " characters, exceeding the ingestor's " + max
                + "-character limit. Shorten it — the SDK will not truncate it, because a truncated"
                + " id bills the wrong thing.";
    }

    private static String quantity(double quantity) {
        if (Double.isNaN(quantity) || Double.isInfinite(quantity)) {
            return null; // reported by the caller's own quantity check
        }
        // Via the serialized text, so digits are counted as the BigDecimal the
        // server parses off the wire will count them.
        BigDecimal decimal = new BigDecimal(Double.toString(quantity));
        int decimalPlaces = Math.max(decimal.scale(), 0);
        int integerDigits = decimal.precision() - decimal.scale();
        if (integerDigits > MAX_QUANTITY_INTEGER_DIGITS) {
            return "quantity " + decimal.toPlainString() + " has " + integerDigits
                    + " integer digits, exceeding the ingestor's limit of "
                    + MAX_QUANTITY_INTEGER_DIGITS + " (quantity is NUMERIC(20,6)).";
        }
        if (decimalPlaces > MAX_QUANTITY_DECIMAL_PLACES) {
            return "quantity " + decimal.toPlainString() + " has " + decimalPlaces
                    + " decimal places, exceeding the ingestor's limit of "
                    + MAX_QUANTITY_DECIMAL_PLACES + ". Round it yourself before tracking — the SDK"
                    + " will not round it, because that would change the quantity you are billed for.";
        }
        return null;
    }
}
