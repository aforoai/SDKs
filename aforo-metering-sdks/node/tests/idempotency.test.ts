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
