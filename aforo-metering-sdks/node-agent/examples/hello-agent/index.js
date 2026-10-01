#!/usr/bin/env node
/**
 * hello-agent — runnable smoke example for @aforoai/agent-metering.
 *
 * Simulates a single AI_AGENT session emitting 10 capability invocations
 * across the 5 canonical capabilities from research-agent.yaml — the same
 * capabilities @aforoai/agent-test-server dispatches, so a single loadgen
 * scenario can point either at this example (SDK path) or at agent-test-server
 * (wire-driver path) and expect the same event stream on the ingest side.
 *
 * What this covers:
 *   - AforoAgent construction with env-driven config
 *   - AforoAgent.startSession() → AgentSession handle
 *   - session.recordStep() with capabilityName (extractor bridges this to
 *     event.toolName in usage-ingestor's ProductTypeEventExtractor —
 *     the source of truth for per-capability billing / dimensionPricing)
 *   - Realistic token counts + duration timing per capability
 *   - HITL_REQUIRED execution status flagged on 1 of 2 verify_claim calls
 *     to exercise the governance branch
 *   - session.end() with taskCompleted + final flush
 *
 * Run:
 *   cd examples/hello-agent
 *   cp .env.example .env    # then edit
 *   npm install
 *   node index.js
 *
 * Verify (against the target ingest URL — see .env.example):
 *   - usage_events row count: 12 (1 session_start, 10 capability steps
 *     matching agent_step, 1 session_end)
 *     Note: some steps ALSO emit a token_usage event for total tokens —
 *     the SDK emits this when inputTokens+outputTokens > 0. See the
 *     "Expected event count" section in this file's README for the
 *     exact per-run breakdown.
 *   - ai_agent_invocations ClickHouse row count: 10 (one per capability
 *     invocation, from analytics-service's McpEventConsumer sibling
 *     AiAgentEventConsumer — verify the "capability_name" column)
 */

'use strict';

// Load .env if dotenv is available; fall back to process.env otherwise so
// the example runs in CI without dotenv being a hard dependency.
try {
  // eslint-disable-next-line global-require
  require('dotenv').config();
} catch {
  // dotenv not installed — that's fine, use raw env.
}

const { AforoAgent } = require('@aforoai/agent-metering');

// ── Config ────────────────────────────────────────────────────────────────
const config = {
  tenantId: process.env.AFORO_TENANT_ID,
  productId: process.env.AFORO_PRODUCT_ID,
  apiKey: process.env.AFORO_API_KEY,
  customerId: process.env.AFORO_CUSTOMER_ID,
  ingestorUrl: process.env.AFORO_INGEST_URL || 'http://localhost:8084',
  agentId: process.env.AFORO_AGENT_ID || 'agent_hello_001',
};

const missing = [];
if (!config.tenantId) missing.push('AFORO_TENANT_ID');
if (!config.productId) missing.push('AFORO_PRODUCT_ID');
if (!config.apiKey) missing.push('AFORO_API_KEY');
if (!config.customerId) missing.push('AFORO_CUSTOMER_ID');
if (missing.length > 0) {
  process.stderr.write(
    `[hello-agent] missing required env vars: ${missing.join(', ')}\n` +
    `Copy .env.example to .env and fill in the values.\n`,
  );
  process.exit(2);
}

// ── The invocation plan ──────────────────────────────────────────────────
// 10 total: 3 summarize_url, 2 extract_entities, 2 verify_claim (1 HITL),
// 2 rank_sources, 1 answer_question. Deterministic — same run every time.
const plan = [
  { cap: 'summarize_url', input: { url: 'https://example.com/a1' }, in: 320, out: 84, ms: 510 },
  { cap: 'summarize_url', input: { url: 'https://example.com/a2' }, in: 410, out: 96, ms: 620 },
  { cap: 'summarize_url', input: { url: 'https://example.com/a3' }, in: 280, out: 72, ms: 480 },
  { cap: 'extract_entities', input: { text: 'The quick brown fox jumps over Alice.' }, in: 180, out: 44, ms: 260 },
  { cap: 'extract_entities', input: { text: 'Second entity extraction text.' }, in: 150, out: 38, ms: 240 },
  { cap: 'verify_claim', input: { claim: 'The sky is blue', sources: ['https://s1', 'https://s2'] }, in: 220, out: 55, ms: 720, status: 'SUCCESS' },
  { cap: 'verify_claim', input: { claim: 'Requires human review', sources: ['https://s3'] }, in: 260, out: 60, ms: 890, status: 'HITL_REQUIRED' },
  { cap: 'rank_sources', input: { query: 'aforo', sources: ['a', 'b', 'c'] }, in: 190, out: 48, ms: 320 },
  { cap: 'rank_sources', input: { query: 'billing', sources: ['x', 'y', 'z', 'w'] }, in: 240, out: 52, ms: 400 },
  { cap: 'answer_question', input: { question: 'What is AI agent metering?' }, in: 380, out: 128, ms: 1200 },
];

async function run() {
  process.stderr.write(`[hello-agent] target: ${config.ingestorUrl}\n`);
  process.stderr.write(`[hello-agent] tenant: ${config.tenantId}\n`);
  process.stderr.write(`[hello-agent] product: ${config.productId}\n`);
  process.stderr.write(`[hello-agent] customer: ${config.customerId}\n`);
  process.stderr.write(`[hello-agent] agent: ${config.agentId}\n`);

  const startedAt = Date.now();

  const agent = new AforoAgent({
    tenantId: config.tenantId,
    productId: config.productId,
    apiKey: config.apiKey,
    // The customer billed for the run; /v1/ingest/events requires one.
    customerId: config.customerId,
    ingestorUrl: config.ingestorUrl,
    // Tighten flush to see events land faster in the demo.
    flushBatchSize: 3,
    flushIntervalMs: 1000,
    // Print any drops so an operator noticing rows missing knows why.
    onDrop: (events, reason) => {
      process.stderr.write(
        `[hello-agent] dropped ${events.length} event(s) — ${reason}\n` +
        `  ${events.map((e) => e.idempotencyKey).join(', ')}\n`,
      );
    },
  });

  const session = await agent.startSession({
    agentId: config.agentId,
    framework: 'CLAUDE',
    modelProvider: 'ANTHROPIC',
    modelName: 'claude-sonnet-4-6',
    metadata: { runner: 'hello-agent', run_seed: 1 },
  });

  process.stderr.write(`[hello-agent] session ${session.sessionId} opened\n`);

  let totalIn = 0;
  let totalOut = 0;
  for (const step of plan) {
    await session.recordStep({
      stepKind: 'TOOL_CALL',
      capabilityName: step.cap,
      inputTokens: step.in,
      outputTokens: step.out,
      durationMs: step.ms,
      executionStatus: step.status || 'SUCCESS',
      metadata: { input: step.input },
    });
    totalIn += step.in;
    totalOut += step.out;
    process.stdout.write(
      JSON.stringify({
        sessionId: session.sessionId,
        capability: step.cap,
        inputTokens: step.in,
        outputTokens: step.out,
        durationMs: step.ms,
        status: step.status || 'SUCCESS',
      }) + '\n',
    );
  }

  await session.end({ taskCompleted: true, metadata: { steps_planned: plan.length } });

  const elapsedMs = Date.now() - startedAt;
  process.stderr.write(
    `[hello-agent] ── summary ────────────────────────────────\n` +
    `[hello-agent] session:         ${session.sessionId}\n` +
    `[hello-agent] invocations:     ${plan.length}\n` +
    `[hello-agent] total tokens in: ${totalIn}\n` +
    `[hello-agent] total tokens out:${totalOut}\n` +
    `[hello-agent] elapsed:         ${elapsedMs}ms\n` +
    `[hello-agent] dropped:         ${agent.droppedCount}\n`,
  );
}

run().catch((err) => {
  process.stderr.write(`[hello-agent] fatal: ${err.stack || err}\n`);
  process.exit(1);
});
