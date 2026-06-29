/**
 * @file Config loading — merges JSON config file + CLI args + environment variables.
 * Priority: env vars > CLI args > config file > defaults.
 */

import { readFileSync } from 'node:fs';
import type { ProxyConfig, TransportType, AforoConfig } from './types.js';

const DEFAULTS: Pick<AforoConfig, 'flushIntervalMs' | 'flushCount' | 'heartbeatIntervalMs' | 'quotaEnforcement' | 'debug'> = {
  flushIntervalMs: 5000,
  flushCount: 50,
  heartbeatIntervalMs: 30_000,
  quotaEnforcement: false,
  debug: false,
};

export function loadConfig(cliArgs: Partial<ProxyConfig & { config?: string }>): ProxyConfig {
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
    quotaEnforcement: envBool('AFORO_QUOTA_ENFORCEMENT')  ?? cliArgs.aforo?.quotaEnforcement ?? fileConfig.aforo?.quotaEnforcement ?? DEFAULTS.quotaEnforcement,
    flushIntervalMs:  envInt('AFORO_FLUSH_INTERVAL_MS')   ?? cliArgs.aforo?.flushIntervalMs  ?? fileConfig.aforo?.flushIntervalMs  ?? DEFAULTS.flushIntervalMs,
    flushCount:       envInt('AFORO_FLUSH_COUNT')          ?? cliArgs.aforo?.flushCount        ?? fileConfig.aforo?.flushCount        ?? DEFAULTS.flushCount,
    heartbeatIntervalMs: envInt('AFORO_HEARTBEAT_INTERVAL_MS') ?? cliArgs.aforo?.heartbeatIntervalMs ?? fileConfig.aforo?.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs,
    debug:           envBool('AFORO_DEBUG')                ?? cliArgs.aforo?.debug             ?? fileConfig.aforo?.debug             ?? DEFAULTS.debug,
  };

  const config: ProxyConfig = {
    transport: transport!,
    command:  cliArgs.command  ?? fileConfig.command,
    args:     cliArgs.args     ?? fileConfig.args,
    env:      fileConfig.env,
    upstream: cliArgs.upstream ?? fileConfig.upstream,
    listen:   cliArgs.listen   ?? fileConfig.listen,
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

  if (config.transport === 'stdio') {
    if (!config.command) throw new Error('command is required for stdio transport');
  } else {
    if (!config.upstream) throw new Error('upstream URL is required for SSE/HTTP transport');
  }
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

function envBool(key: string): boolean | undefined {
  const val = process.env[key];
  if (!val) return undefined;
  return val === 'true' || val === '1';
}
