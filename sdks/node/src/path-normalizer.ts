/**
 * Normalize a URL path by replacing dynamic segments with parameter placeholders.
 *
 * If a framework route template is available (e.g., Express `req.route?.path`),
 * use that directly — it already has :param placeholders.
 *
 * Otherwise, apply heuristic normalization:
 *   /users/123         → /users/:id
 *   /orders/abc-def    → /orders/:id
 *   /v1/items/42/reviews/7 → /v1/items/:id/reviews/:id
 *
 * UUIDs, numeric IDs, and alphanumeric slugs are detected and replaced.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
const MONGO_ID_RE = /^[0-9a-f]{24}$/i;
// Version-like segments: v1, v2, v10, etc. — should NOT be normalized
const VERSION_RE = /^v\d+$/i;

export function normalizePath(
  actualPath: string,
  routeTemplate?: string,
): string {
  // Prefer the framework's route template if available
  if (routeTemplate) {
    return routeTemplate;
  }

  // Heuristic: replace dynamic-looking segments
  const segments = actualPath.split('/');
  const normalized = segments.map((seg) => {
    if (!seg) return seg;
    // Preserve version segments (v1, v2, v10)
    if (VERSION_RE.test(seg)) return seg;
    if (UUID_RE.test(seg)) return ':id';
    if (NUMERIC_RE.test(seg)) return ':id';
    if (MONGO_ID_RE.test(seg)) return ':id';
    // Alphanumeric tokens > 4 chars that mix letters and digits look like IDs
    if (seg.length > 4 && seg.length <= 12 && /^[a-zA-Z0-9_-]+$/.test(seg) && /\d/.test(seg) && /[a-zA-Z]/.test(seg)) {
      return ':id';
    }
    return seg;
  });

  return normalized.join('/');
}
