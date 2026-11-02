/**
 * @file Who a tool call is billed to (G265, G303 — Jay's decision 2026-10-26).
 *
 * The customer comes from something the operator controls: a resolver
 * function, the customer mapped to the client's bearer token, or one fixed
 * customer for the whole sidecar. The `_meta.customer_id` the MCP client sends
 * is used only when the operator opts in with `trustClientCustomerId`. With
 * none of these the proxy refuses to start. There is no fallback to the agent
 * id or to a placeholder; a call whose customer cannot be decided runs, and its
 * event is dropped as `invalid`.
 */

import type { CustomerContext, CustomerResolver } from '../types.js';
import { logger } from '../util/logger.js';

export interface CustomerIdentityConfig {
  customerId?: string;
  customerResolver?: CustomerResolver;
  trustClientCustomerId?: boolean;
  /** True when bearer tokens map to customers (`listen.authTokensFile` / `authTokens`). */
  tokensMapCustomers?: boolean;
}

export const MISSING_CUSTOMER_SOURCE =
  'No customer source configured. Set one of: aforo.customerId (--customer-id / AFORO_CUSTOMER_ID) to bill ' +
  'one customer, listen.authTokensFile (--auth-tokens-file) to map each bearer token to a customer, ' +
  'aforo.customerResolver (library use) to decide from authenticated identity, or ' +
  'aforo.trustClientCustomerId (--trust-client-customer-id) to bill the customer the MCP client names in ' +
  '_meta.customer_id (only when every client is trusted).';

export function hasCustomerSource(config: CustomerIdentityConfig): boolean {
  return Boolean(
    nonBlank(config.customerId)
      || typeof config.customerResolver === 'function'
      || config.trustClientCustomerId === true
      || config.tokensMapCustomers === true,
  );
}

/** Throws {@link MISSING_CUSTOMER_SOURCE} when no source is configured. */
export function requireCustomerSource(config: CustomerIdentityConfig): void {
  if (!hasCustomerSource(config)) throw new Error(MISSING_CUSTOMER_SOURCE);
}

/**
 * stdio has no HTTP listener, so no bearer token ever arrives and a token →
 * customer map can bill nobody. Said plainly at startup instead of the
 * generic message, which would point back at the tokens file.
 */
export const STDIO_TOKENS_FILE_HAS_NO_EFFECT =
  'listen.authTokensFile / listen.authTokens map HTTP bearer tokens to customers, but the stdio transport has no ' +
  'HTTP listener, so no call would ever be billed. For stdio set aforo.customerId (--customer-id / AFORO_CUSTOMER_ID) ' +
  'to bill one customer, aforo.customerResolver (library use), or aforo.trustClientCustomerId ' +
  '(--trust-client-customer-id) to bill the customer the MCP client names in _meta.customer_id.';

/** Startup check for a stdio proxy: a tokens file is not a customer source there. */
export function requireStdioCustomerSource(
  config: CustomerIdentityConfig,
  listen: { authTokensFile?: string; authTokens?: Record<string, string> } | undefined,
): void {
  const stdioConfig = { ...config, tokensMapCustomers: false };
  if (hasCustomerSource(stdioConfig)) return;
  const hasTokens = Boolean(listen?.authTokensFile) || Boolean(listen?.authTokens && Object.keys(listen.authTokens).length > 0);
  throw new Error(hasTokens ? STDIO_TOKENS_FILE_HAS_NO_EFFECT : MISSING_CUSTOMER_SOURCE);
}

export function nonBlank(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Build the per-call decision. Order: the resolver (when set, it decides
 * alone); the customer mapped to the authenticated token; `_meta.customer_id`
 * when trusted; the fixed `customerId`. Returns undefined when none applies.
 */
export function makeCustomerDecision(config: CustomerIdentityConfig): (context: CustomerContext) => string | undefined {
  const fixed = nonBlank(config.customerId);
  const resolver = config.customerResolver;
  const trust = config.trustClientCustomerId === true;
  return (context) => {
    if (typeof resolver === 'function') {
      try {
        return nonBlank(resolver(context));
      } catch (err) {
        logger.warn('customerResolver threw; the call is not metered', {
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    }
    const fromToken = nonBlank(context.principal?.customerId);
    if (fromToken) return fromToken;
    if (trust) {
      const claimed = nonBlank(context.meta?.customer_id);
      if (claimed) return claimed;
    }
    return fixed;
  };
}
