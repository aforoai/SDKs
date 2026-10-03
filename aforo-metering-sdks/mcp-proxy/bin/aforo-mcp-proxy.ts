#!/usr/bin/env node
/**
 * @file CLI entry point for aforo-mcp-proxy.
 *
 * Usage:
 *   aforo-mcp-proxy --transport stdio --command "npx" --args "-y,@mcp/server-fs,/tmp" \
 *     --tenant tenant_abc --product prod_mcp_fs --api-key sk_live_xxx
 *
 *   aforo-mcp-proxy --transport sse --upstream http://localhost:8080/sse --port 3100 \
 *     --tenant tenant_abc --product prod_mcp_fs --api-key sk_live_xxx
 *
 *   aforo-mcp-proxy --config /path/to/aforo-proxy.json
 */

import { Command } from 'commander';
import { loadConfig } from '../src/config.js';
import { StdioProxy } from '../src/proxy/StdioProxy.js';
import { SseProxy } from '../src/proxy/SseProxy.js';
import { StreamableHttpProxy } from '../src/proxy/StreamableHttpProxy.js';
import { logger } from '../src/util/logger.js';
import { PROXY_VERSION } from '../src/version.js';
import type { ProxyConfig, TransportType } from '../src/types.js';

const program = new Command();

program
  .name('aforo-mcp-proxy')
  .description('Aforo MCP Transport Proxy — transparent sidecar for metering MCP servers')
  .version(PROXY_VERSION)
  .option('-c, --config <path>', 'Path to JSON config file')
  .option('-t, --transport <type>', 'Transport type: stdio, sse, streamable-http')
  .option('--command <cmd>', 'Command to spawn MCP server (stdio mode)')
  .option('--args <args>', 'Comma-separated args for command (stdio mode)')
  .option('--upstream <url>', 'Upstream MCP server URL (SSE/HTTP mode)')
  .option('--port <port>', 'Listen port (SSE/HTTP mode)', '3100')
  .option('--host <host>', 'Listen host (SSE/HTTP mode)', '127.0.0.1')
  .option('--tenant <id>', 'Aforo tenant ID')
  .option('--product <id>', 'Aforo product ID')
  .option('--api-key <key>', 'Aforo API key')
  .option('--ingestor-url <url>', 'Aforo ingestor URL')
  .option('--agent-id <id>', 'Agent identifier override')
  .option('--quota-enforcement', 'Enable quota enforcement')
  .option('--response-timeout-ms <ms>', 'Meter a tool call as TIMEOUT when no response arrives within this many ms (default 300000)')
  .option('--debug', 'Enable debug logging')
  .action(async (opts) => {
    try {
      // Build CLI args in the ProxyConfig shape
      const cliArgs: Partial<ProxyConfig & { config?: string }> = {
        config: opts.config,
        transport: opts.transport as TransportType,
        command: opts.command,
        args: opts.args ? opts.args.split(',') : undefined,
        upstream: opts.upstream,
        listen: opts.port ? { port: parseInt(opts.port, 10), host: opts.host } : undefined,
        aforo: {
          tenantId: opts.tenant ?? '',
          productId: opts.product ?? '',
          apiKey: opts.apiKey ?? '',
          ingestorUrl: opts.ingestorUrl ?? '',
          agentId: opts.agentId,
          quotaEnforcement: opts.quotaEnforcement ?? false,
          responseTimeoutMs: opts.responseTimeoutMs ? parseInt(opts.responseTimeoutMs, 10) : undefined,
          debug: opts.debug ?? false,
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
