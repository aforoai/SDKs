import { generateIdempotencyKey, generateRandomKey } from '../src/idempotency';

describe('idempotency', () => {
  describe('generateIdempotencyKey', () => {
    it('should produce deterministic keys for same input', () => {
      const key1 = generateIdempotencyKey('cust_1', 'api_calls', 1, '2026-03-21T00:00:00Z');
      const key2 = generateIdempotencyKey('cust_1', 'api_calls', 1, '2026-03-21T00:00:00Z');
      expect(key1).toBe(key2);
    });

    it('should produce different keys for different inputs', () => {
      const key1 = generateIdempotencyKey('cust_1', 'api_calls', 1, '2026-03-21T00:00:00Z');
      const key2 = generateIdempotencyKey('cust_2', 'api_calls', 1, '2026-03-21T00:00:00Z');
      expect(key1).not.toBe(key2);
    });

    it('should produce 32-char hex string', () => {
      const key = generateIdempotencyKey('cust_1', 'metric', 5, '2026-01-01T00:00:00Z');
      expect(key).toHaveLength(32);
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    // Documents WHY this helper is no longer the client default: occurredAt only
    // carries millisecond precision, so two genuinely distinct events inside one
    // millisecond hash to one key and the ingestor drops the second as a
    // DUPLICATE. Callers who want that dedup opt in via track({ idempotencyKey }).
    it('collides for two distinct events in the same millisecond', () => {
      const sameMs = '2026-03-21T00:00:00.000Z';
      expect(generateIdempotencyKey('cust_1', 'sms.sent', 1, sameMs)).toBe(
        generateIdempotencyKey('cust_1', 'sms.sent', 1, sameMs),
      );
    });
  });

  describe('generateRandomKey', () => {
    it('should produce unique keys', () => {
      const key1 = generateRandomKey();
      const key2 = generateRandomKey();
      expect(key1).not.toBe(key2);
    });

    it('should produce UUID format', () => {
      const key = generateRandomKey();
      expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });
});
