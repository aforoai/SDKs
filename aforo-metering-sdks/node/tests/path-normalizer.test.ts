import { normalizePath } from '../src/path-normalizer';

describe('normalizePath', () => {
  it('should use route template when provided', () => {
    expect(normalizePath('/users/123', '/users/:id')).toBe('/users/:id');
  });

  it('should replace numeric IDs', () => {
    expect(normalizePath('/users/42')).toBe('/users/:id');
    expect(normalizePath('/orders/123/items/456')).toBe('/orders/:id/items/:id');
  });

  it('should replace UUIDs', () => {
    expect(normalizePath('/users/550e8400-e29b-41d4-a716-446655440000'))
      .toBe('/users/:id');
  });

  it('should replace MongoDB ObjectIds', () => {
    expect(normalizePath('/docs/507f1f77bcf86cd799439011'))
      .toBe('/docs/:id');
  });

  it('should keep path words intact', () => {
    expect(normalizePath('/api/v1/users')).toBe('/api/v1/users');
    expect(normalizePath('/health')).toBe('/health');
  });

  it('should handle root path', () => {
    expect(normalizePath('/')).toBe('/');
  });

  it('should handle nested paths with mixed segments', () => {
    expect(normalizePath('/api/v1/teams/42/members/99/roles'))
      .toBe('/api/v1/teams/:id/members/:id/roles');
  });

  it('should keep version-like segments', () => {
    // "v1", "v2" have letters and digits but are short enough to be kept
    // They don't match our heuristic because "v1" is only 2 chars
    expect(normalizePath('/api/v1/data')).toBe('/api/v1/data');
  });
});
