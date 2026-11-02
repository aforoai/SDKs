/**
 * @file Config loading — merges JSON config file + CLI args + environment variables.
 * Priority: env vars > CLI args > config file > defaults.
 */

import { readFileSync } from 'node:fs';
import type { ProxyConfig, TransportType, AforoConfig, ListenConfig } from './types.js';
import { ListenerGuard } from './auth/ListenerGuard.js';
import { requireCustomerSource, requireStdioCustomerSource } from './identity/customer.js';
import { checkBaseUrl as assertIngestorUrl } from './transport-core/core.js';

export const DEFAULT_PRODUCT_TYPE = 'MCP_SERVER';

const DEFAULTS: Pick<AforoConfig, 'flushIntervalMs' | 'flushCount' | 'heartbeatIntervalMs' | 'quotaEnforcement' | 'debug'> = {
  flushIntervalMs: 5000,
  flushCount: 500,
  heartbeatIntervalMs: 30_000,
  quotaEnforcement: false,
  debug: false,
};

export type CliArgs = Partial<Omit<ProxyConfig, 'aforo' | 'listen'>> & {
  config?: string;
  aforo?: Partial<AforoConfig>;
  listen?: Partial<ListenConfig>;
};

export function loadConfig(cliArgs: CliArgs): ProxyConfig {
  // 1. Load config file if specified
  let fileConfig: Partial<ProxyConfig> = {};
  if (cliArgs.config) {
    try {
      const raw = readFileSync(cliArgs.config, 'utf-8');
      fileConfig = JSON.parse(raw) as Partial<ProxyConfig>;
    } catch (err) {
      throw new Error(`Failed to read config file ${cliArgs.config}: ${(err as Error).message}`);
    }
  }

  // 2. Merge: file < CLI < env
  const transport = envString('AFORO_TRANSPORT') as TransportType
    ?? cliArgs.transport
    ?? fileConfig.transport;

  const aforo: AforoConfig = {
    tenantId:        envString('AFORO_TENANT_ID')        ?? cliArgs.aforo?.tenantId        ?? fileConfig.aforo?.tenantId        ?? '',
    productId:       envString('AFORO_PRODUCT_ID')       ?? cliArgs.aforo?.productId       ?? fileConfig.aforo?.productId       ?? '',
    apiKey:          envString('AFORO_API_KEY')           ?? cliArgs.aforo?.apiKey           ?? fileConfig.aforo?.apiKey           ?? '',
    ingestorUrl:     envString('AFORO_INGESTOR_URL')      ?? cliArgs.aforo?.ingestorUrl      ?? fileConfig.aforo?.ingestorUrl      ?? '',
    agentId:         envString('AFORO_AGENT_ID')          ?? cliArgs.aforo?.agentId          ?? fileConfig.aforo?.agentId,
    customerId:      envString('AFORO_CUSTOMER_ID')       ?? cliArgs.aforo?.customerId       ?? fileConfig.aforo?.customerId,
    trustClientCustomerId: envBool('AFORO_TRUST_CLIENT_CUSTOMER_ID') ?? cliArgs.aforo?.trustClientCustomerId ?? fileConfig.aforo?.trustClientCustomerId,
    allowInsecureHttp: envBool('AFORO_ALLOW_INSECURE_HTTP') ?? cliArgs.aforo?.allowInsecureHttp ?? fileConfig.aforo?.allowInsecureHttp,
    productType:     normalizeProductType(envString('AFORO_PRODUCT_TYPE') ?? cliArgs.aforo?.productType ?? fileConfig.aforo?.productType) ?? DEFAULT_PRODUCT_TYPE,
    quotaEnforcement: envBool('AFORO_QUOTA_ENFORCEMENT')  ?? cliArgs.aforo?.quotaEnforcement ?? fileConfig.aforo?.quotaEnforcement ?? DEFAULTS.quotaEnforcement,
    quotaTimeoutMs:  envInt('AFORO_QUOTA_TIMEOUT_MS')      ?? cliArgs.aforo?.quotaTimeoutMs    ?? fileConfig.aforo?.quotaTimeoutMs,
    quotaAllowCacheMs: envInt('AFORO_QUOTA_ALLOW_CACHE_MS') ?? cliArgs.aforo?.quotaAllowCacheMs ?? fileConfig.aforo?.quotaAllowCacheMs,
    quotaFailMode:   (envString('AFORO_QUOTA_FAIL_MODE') as AforoConfig['quotaFailMode']) ?? cliArgs.aforo?.quotaFailMode ?? fileConfig.aforo?.quotaFailMode,
    flushIntervalMs:  envInt('AFORO_FLUSH_INTERVAL_MS')   ?? cliArgs.aforo?.flushIntervalMs  ?? fileConfig.aforo?.flushIntervalMs  ?? DEFAULTS.flushIntervalMs,
    flushCount:       envInt('AFORO_FLUSH_COUNT')          ?? cliArgs.aforo?.flushCount        ?? fileConfig.aforo?.flushCount        ?? DEFAULTS.flushCount,
    maxQueueSize:     envInt('AFORO_MAX_QUEUE_SIZE')       ?? cliArgs.aforo?.maxQueueSize      ?? fileConfig.aforo?.maxQueueSize,
    shutdownTimeoutMs: envInt('AFORO_SHUTDOWN_TIMEOUT_MS') ?? cliArgs.aforo?.shutdownTimeoutMs ?? fileConfig.aforo?.shutdownTimeoutMs,
    responseTimeoutMs: envInt('AFORO_RESPONSE_TIMEOUT_MS') ?? cliArgs.aforo?.responseTimeoutMs ?? fileConfig.aforo?.responseTimeoutMs,
    heartbeatIntervalMs: envInt('AFORO_HEARTBEAT_INTERVAL_MS') ?? cliArgs.aforo?.heartbeatIntervalMs ?? fileConfig.aforo?.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs,
    debug:           envBool('AFORO_DEBUG')                ?? cliArgs.aforo?.debug             ?? fileConfig.aforo?.debug             ?? DEFAULTS.debug,
  };

  // Library-only settings (functions) come from the CLI-args object when embedded.
  if (cliArgs.aforo?.customerResolver) aforo.customerResolver = cliArgs.aforo.customerResolver;
  if (cliArgs.aforo?.statusResolver) aforo.statusResolver = cliArgs.aforo.statusResolver;
  if (cliArgs.aforo?.onDrop) aforo.onDrop = cliArgs.aforo.onDrop;

  const config: ProxyConfig = {
    transport: transport!,
    command:  cliArgs.command  ?? fileConfig.command,
    args:     cliArgs.args     ?? fileConfig.args,
    env:      fileConfig.env,
    passEnv:  envList('AFORO_PASS_ENV') ?? cliArgs.passEnv ?? fileConfig.passEnv,
    healthFile: envString('AFORO_HEALTH_FILE') ?? cliArgs.healthFile ?? fileConfig.healthFile,
    upstream: cliArgs.upstream ?? fileConfig.upstream,
    listen:   mergeListen(fileConfig.listen, cliArgs.listen),
    aforo,
  };

  validate(config);
  return config;
}

function validate(config: ProxyConfig): void {
  if (!config.transport) {
    throw new Error('transport is required (stdio | sse | streamable-http)');
  }
  if (!['stdio', 'sse', 'streamable-http'].includes(config.transport)) {
    throw new Error(`Invalid transport: ${config.transport}. Must be stdio, sse, or streamable-http`);
  }
  if (!config.aforo.tenantId)    throw new Error('aforo.tenantId is required');
  if (!config.aforo.productId)   throw new Error('aforo.productId is required');
  if (!config.aforo.apiKey)      throw new Error('aforo.apiKey is required');
  if (!config.aforo.ingestorUrl) throw new Error('aforo.ingestorUrl is required');

  assertIngestorUrl(config.aforo.ingestorUrl, config.aforo.allowInsecureHttp === true);
  if (config.aforo.quotaFailMode !== undefined && config.aforo.quotaFailMode !== 'open' && config.aforo.quotaFailMode !== 'closed') {
    throw new Error(`aforo.quotaFailMode must be "open" or "closed" (got ${String(config.aforo.quotaFailMode)})`);
  }

  if (config.transport === 'stdio') {
    if (!config.command) throw new Error('command is required for stdio transport');
    requireStdioCustomerSource(config.aforo, config.listen);
    return;
  }
  if (!config.upstream) throw new Error('upstream URL is required for SSE/HTTP transport');
  // Builds the listener's auth table: fails on a missing token, a bad tokens file or an unsafe opt-out.
  const tokensMapCustomers = new ListenerGuard(config.listen).tokensMapCustomers;
  requireCustomerSource({ ...config.aforo, tokensMapCustomers });
}

/** Field-wise merge: env > CLI > file. */
function mergeListen(file: ListenConfig | undefined, cli: Partial<ListenConfig> | undefined): ListenConfig {
  const pick = <K extends keyof ListenConfig>(key: K): ListenConfig[K] | undefined =>
    (cli?.[key] !== undefined ? cli[key] : file?.[key]) as ListenConfig[K] | undefined;
  const listen: ListenConfig = { port: pick('port') ?? 3100 };
  const host = pick('host');
  if (host !== undefined) listen.host = host;
  const authToken = envString('AFORO_PROXY_AUTH_TOKEN') ?? pick('authToken');
  if (authToken !== undefined) listen.authToken = authToken;
  const authTokensFile = envString('AFORO_PROXY_AUTH_TOKENS_FILE') ?? pick('authTokensFile');
  if (authTokensFile !== undefined) listen.authTokensFile = authTokensFile;
  const authTokens = pick('authTokens');
  if (authTokens !== undefined) listen.authTokens = authTokens;
  const allowUnauthenticated = envBool('AFORO_PROXY_ALLOW_UNAUTHENTICATED') ?? pick('allowUnauthenticated');
  if (allowUnauthenticated !== undefined) listen.allowUnauthenticated = allowUnauthenticated;
  const allowedHosts = envList('AFORO_PROXY_ALLOWED_HOSTS') ?? pick('allowedHosts');
  if (allowedHosts !== undefined) listen.allowedHosts = allowedHosts;
  const allowedOrigins = envList('AFORO_PROXY_ALLOWED_ORIGINS') ?? pick('allowedOrigins');
  if (allowedOrigins !== undefined) listen.allowedOrigins = allowedOrigins;
  const maxBodyBytes = pick('maxBodyBytes');
  if (maxBodyBytes !== undefined) listen.maxBodyBytes = maxBodyBytes;
  return listen;
}

/** Trim + uppercase; blank/non-string -> undefined. Unknown values pass through. */
export function normalizeProductType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}

// ─── Env helpers ────────────────────────────────────────────────────────────

function envString(key: string): string | undefined {
  return process.env[key] || undefined;
}

function envInt(key: string): number | undefined {
  const val = process.env[key];
  if (!val) return undefined;
  const n = parseInt(val, 10);
  return isNaN(n) ? undefined : n;
}

function envList(key: string): string[] | undefined {
  const val = process.env[key];
  if (!val) return undefined;
  return val.split(',').map((v) => v.trim()).filter(Boolean);
}

function envBool(key: string): boolean | undefined {
  const val = process.env[key];
  if (!val) return undefined;
  return val === 'true' || val === '1';
}
