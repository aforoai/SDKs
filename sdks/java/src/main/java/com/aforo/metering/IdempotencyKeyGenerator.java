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
     * Generate a random UUID key.
     */
    public static String generateRandom() {
        return UUID.randomUUID().toString();
    }
}
