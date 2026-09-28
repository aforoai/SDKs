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
     * <p><strong>No longer the client default.</strong> {@code occurredAt} only carries
     * millisecond precision, so two genuinely distinct events for the same customer +
     * metric + quantity inside one millisecond hash to the same key; the ingestor then
     * answers DUPLICATE and drops the second one, which silently under-bills. Kept
     * public for callers who deliberately want content-addressed dedup (e.g. replaying
     * a fixed batch) and pass the result to {@code TrackEvent.Builder.idempotencyKey}.</p>
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
     * Generate a random UUID v4 key.
     *
     * <p>This is the default key for an event whose caller supplied none: every event
     * gets its own key, so no two distinct events can collide. Dedup stays opt-in via an
     * explicit {@code idempotencyKey}.</p>
     */
    public static String generateRandom() {
        return UUID.randomUUID().toString();
    }
}
