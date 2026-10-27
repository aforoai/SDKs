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
 *   - 32 usage events: 10 "Agent Steps", 10 "Agent Tool Calls",
 *     10 "Tokens Consumed", 1 "Tasks Completed", 1 "Agent Sessions"
 *     (the last one carries sessionBoundary SESSION_END).
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
  productId: process.env.AFORO_PRODUCT_ID, // optional, sent as metadata.productId
  apiKey: process.env.AFORO_API_KEY,
  customerId: process.env.AFORO_CUSTOMER_ID,
  endpoint: process.env.AFORO_INGEST_URL || 'http://localhost:8084', // → /v1/ingest/batch
  agentId: process.env.AFORO_AGENT_ID || 'agent_hello_001',
};

const missing = [];
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
  process.stderr.write(`[hello-agent] target: ${config.endpoint}\n`);
  process.stderr.write(`[hello-agent] product: ${config.productId}\n`);
  process.stderr.write(`[hello-agent] customer: ${config.customerId}\n`);
  process.stderr.write(`[hello-agent] agent: ${config.agentId}\n`);

  const startedAt = Date.now();

  const agent = new AforoAgent({
    apiKey: config.apiKey, // sent as X-API-Key
    customerId: config.customerId, // the customer billed for the run
    agentId: config.agentId,
    productId: config.productId,
    endpoint: config.endpoint,
    // Tighten flush to see events land faster in the demo.
    maxBatchSize: 10,
    flushIntervalMs: 1000,
    // Print delivery problems so an operator noticing rows missing knows why.
    onError: (err) => {
      process.stderr.write(
        `[hello-agent] ${err.kind}: ${err.message}\n` +
        `  ${err.events.map((e) => e.idempotencyKey).join(', ')}\n`,
      );
    },
  });

  const session = agent.startSession({
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
