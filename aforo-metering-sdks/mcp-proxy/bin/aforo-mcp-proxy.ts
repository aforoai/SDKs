#!/usr/bin/env node
/**
 * @file CLI entry point for aforo-mcp-proxy.
 *
 * Usage:
 *   aforo-mcp-proxy --transport stdio --command "npx" --arg -y --arg @mcp/server-fs --arg /tmp \
 *     --tenant tenant_abc --product prod_mcp_fs --api-key sk_live_xxx --customer-id cust_123
 *
 *   aforo-mcp-proxy --transport sse --upstream http://localhost:8080/sse --port 3100 \
 *     --tenant tenant_abc --product prod_mcp_fs --api-key sk_live_xxx \
 *     --auth-tokens-file /etc/aforo/proxy-tokens.json
 *
 *   aforo-mcp-proxy --config /path/to/aforo-proxy.json
 */

import { Command } from 'commander';
import { loadConfig, type CliArgs } from '../src/config.js';
import { StdioProxy } from '../src/proxy/StdioProxy.js';
import { SseProxy } from '../src/proxy/SseProxy.js';
import { StreamableHttpProxy } from '../src/proxy/StreamableHttpProxy.js';
import { logger } from '../src/util/logger.js';
import { collectArg, resolveChildArgs } from '../src/util/cliArgs.js';
import { PROXY_VERSION } from '../src/version.js';
import type { TransportType } from '../src/types.js';

const list = (value: string | undefined) => value ? value.split(',').map((v) => v.trim()).filter(Boolean) : undefined;

const program = new Command();

program
  .name('aforo-mcp-proxy')
  .description('Aforo MCP Transport Proxy — transparent sidecar for metering MCP servers')
  .version(PROXY_VERSION)
  .option('-c, --config <path>', 'Path to JSON config file')
  .option('-t, --transport <type>', 'Transport type: stdio, sse, streamable-http')
  .option('--command <cmd>', 'Command to spawn MCP server (stdio mode)')
  .option('--arg <value>', 'One argument for the command; repeat for each (stdio mode). A value may contain commas.', collectArg)
  .option('--args <args>', 'Comma-separated args for the command (stdio mode). An argument cannot contain a comma: use --arg. --arg wins when both are given.')
  .option('--upstream <url>', 'Upstream MCP server URL (SSE/HTTP mode)')
  .option('--port <port>', 'Listen port (SSE/HTTP mode, default 3100)')
  .option('--host <host>', 'Listen host (SSE/HTTP mode, default 127.0.0.1)')
  .option('--auth-token <token>', 'Bearer token clients must send (SSE/HTTP mode; at least 16 chars)')
  .option('--auth-tokens-file <path>', 'JSON file {"<token>": "<customerId>"}: one token per client, billed to its customer')
  .option('--allow-unauthenticated', 'Accept requests without a bearer token (loopback listen host only)')
  .option('--allowed-hosts <hosts>', 'Comma-separated extra Host header values to accept')
  .option('--allowed-origins <origins>', 'Comma-separated browser origins allowed to call the proxy')
  .option('--pass-env <names>', 'Comma-separated environment variables the stdio child may inherit')
  .option('--health-file <path>', 'File the proxy keeps fresh while serving, for container health checks')
  .option('--tenant <id>', 'Aforo tenant ID')
  .option('--product <id>', 'Aforo product ID')
  .option('--api-key <key>', 'Aforo API key')
  .option('--ingestor-url <url>', 'Aforo ingestor URL')
  .option('--agent-id <id>', 'Agent identifier override')
  .option('--customer-id <id>', 'Customer billed for every tool call (single-customer sidecar)')
  .option('--trust-client-customer-id', 'Bill the customer the MCP client names in _meta.customer_id (trusted clients only)')
  .option('--allow-insecure-http', 'Allow a plain http:// ingestor URL on a non-loopback host')
  .option('--quota-enforcement', 'Enable quota enforcement')
  .option('--quota-timeout-ms <ms>', 'Deadline for the pre-flight quota check (default 1000)')
  .option('--quota-fail-mode <mode>', 'open (default) or closed: what to do when the quota check cannot answer')
  .option('--response-timeout-ms <ms>', 'Meter a tool call as TIMEOUT when no response arrives within this many ms (default 300000)')
  .option('--debug', 'Enable debug logging')
  .action(async (opts) => {
    try {
      const childArgs = resolveChildArgs({ arg: opts.arg, args: opts.args });
      if (childArgs.warning) logger.warn(childArgs.warning);
      // Build CLI args in the ProxyConfig shape
      const cliArgs: CliArgs = {
        config: opts.config,
        transport: opts.transport as TransportType,
        command: opts.command,
        args: childArgs.args,
        upstream: opts.upstream,
        passEnv: list(opts.passEnv),
        healthFile: opts.healthFile,
        listen: {
          ...(opts.port ? { port: parseInt(opts.port, 10) } : {}),
          ...(opts.host ? { host: opts.host } : {}),
          ...(opts.authToken ? { authToken: opts.authToken } : {}),
          ...(opts.authTokensFile ? { authTokensFile: opts.authTokensFile } : {}),
          ...(opts.allowUnauthenticated ? { allowUnauthenticated: true } : {}),
          ...(opts.allowedHosts ? { allowedHosts: list(opts.allowedHosts) } : {}),
          ...(opts.allowedOrigins ? { allowedOrigins: list(opts.allowedOrigins) } : {}),
        },
        aforo: {
          tenantId: opts.tenant,
          productId: opts.product,
          apiKey: opts.apiKey,
          ingestorUrl: opts.ingestorUrl,
          agentId: opts.agentId,
          customerId: opts.customerId,
          ...(opts.trustClientCustomerId ? { trustClientCustomerId: true } : {}),
          ...(opts.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
          ...(opts.quotaEnforcement ? { quotaEnforcement: true } : {}),
          quotaTimeoutMs: opts.quotaTimeoutMs ? parseInt(opts.quotaTimeoutMs, 10) : undefined,
          quotaFailMode: opts.quotaFailMode,
          responseTimeoutMs: opts.responseTimeoutMs ? parseInt(opts.responseTimeoutMs, 10) : undefined,
          ...(opts.debug ? { debug: true } : {}),
        },
      };

      const config = loadConfig(cliArgs);

      logger.info('Aforo MCP Proxy starting', {
        transport: config.transport,
        tenantId: config.aforo.tenantId,
        productId: config.aforo.productId,
        quotaEnforcement: config.aforo.quotaEnforcement,
      });

      let proxy;
      switch (config.transport) {
        case 'stdio':
          proxy = new StdioProxy(config);
          break;
        case 'sse':
          proxy = new SseProxy(config);
          break;
        case 'streamable-http':
          proxy = new StreamableHttpProxy(config);
          break;
        default:
          throw new Error(`Unknown transport: ${config.transport}`);
      }

      await proxy.start();
    } catch (err) {
      logger.error('Fatal error', { error: (err as Error).message });
      process.exit(1);
    }
  });

program.parse();
