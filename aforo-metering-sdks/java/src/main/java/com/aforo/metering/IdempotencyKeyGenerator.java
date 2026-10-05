package com.aforo.metering;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.UUID;

/**
 * Generates idempotency keys for usage events.
 */
public final class IdempotencyKeyGenerator {

    private IdempotencyKeyGenerator() {}

    /**
     * Generate a deterministic key from event fields via SHA-256 (32 hex chars).
     *
     * <p>WARNING — collapse hazard: two legitimately DISTINCT events with
     * identical fields in the same timestamp instant produce the SAME key, so
     * the second dedups away (silent under-billing). The SDK therefore no
     * longer uses this as the automatic fallback for keyless track() calls
     * (2026-07-05 — mirrors Aforo ingest's April 2026 H4 fix). Use it only
     * when your events are guaranteed unique per
     * (customer, metric, quantity, occurredAt).</p>
     */
    public static String generate(String customerId, String metricName, double quantity, String occurredAt) {
        String input = customerId + ":" + metricName + ":" + quantity + ":" + occurredAt;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(input.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash).substring(0, 32);
        } catch (NoSuchAlgorithmException e) {
            return UUID.randomUUID().toString().replace("-", "").substring(0, 32);
        }
    }

    /**
     * Random UUID key — the automatic fallback for keyless track() calls.
     * No caller key = dedup opt-out: every call is a distinct event; the key
     * is stamped once at enqueue so the SDK's own flush retries stay dedup-safe.
     */
    public static String generateRandom() {
        return UUID.randomUUID().toString();
    }
}
