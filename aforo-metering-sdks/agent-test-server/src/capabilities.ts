// Capability registry — 5 canonical capabilities mirroring
// agent-samples/manifests/research-agent.yaml so a run driven by that
// manifest (SDK, hello-agent example, loadgen wire driver) maps 1:1 to
// what this server dispatches.
//
// Every handler is DETERMINISTIC and side-effect-free: given the same
// input, always the same output. No Date.now(), no Math.random(). This
// makes response bodies snapshot-testable and lets the ai_agent_wire
// loadgen driver assert on exact response shapes if it wants to.
//
// Token counts + duration are computed from the input length by a fixed
// formula so a "small" input maps to a small billed footprint and a
// "large" input maps to a large one — enough to exercise per-capability
// pricing tiers without pretending to be a real LLM. `--simulate-latency`
// on the CLI adds a fixed sleep BEFORE the response so perf-shape tests
// see a non-zero wire latency; the returned executionDurationMs is
// derived from the input alone and stays deterministic across runs.

import type { ExecutionStatus } from './types.js';

interface CapabilityHandler {
  name: string;
  description: string;
  /** Fixed simulated latency (ms) applied when opts.simulateLatency is true. */
  simulatedLatencyMs: number;
  /**
   * Deterministic dispatch. Returns the response body, execution status, and
   * synthesized token counts. `executionDurationMs` is derived from the
   * input alone so re-runs against the same request produce the same value.
   */
  handle: (input: Record<string, unknown>) => CapabilityResult;
}

export interface CapabilityResult {
  output: Record<string, unknown>;
  executionStatus: ExecutionStatus;
  executionDurationMs: number;
  tokensIn: number;
  tokensOut: number;
}

/** Deterministic input-length-based fake-tokenizer. */
function estimateTokens(input: string): number {
  // Roughly 4 chars per token, floor at 1 so an empty string still records
  // 1 token — a real invocation always burns at least the system prompt.
  return Math.max(1, Math.floor(input.length / 4));
}

/** Deterministic input-length-based duration. */
function estimateDurationMs(input: string, baseMs: number): number {
  // Scale by chars/10 (~10 chars per ms) on top of a per-capability base.
  return baseMs + Math.floor(input.length / 10);
}

const registry: Record<string, CapabilityHandler> = {
  summarize_url: {
    name: 'summarize_url',
    description: 'Fetch a public URL and return a synthetic summary of its main claims.',
    simulatedLatencyMs: 500,
    handle: (input) => {
      const url = String(input.url ?? '');
      const length = String(input.length ?? 'medium');
      const summaryText = `Synthetic summary of ${url} (length=${length}). ` +
        'This is a deterministic stand-in for a real LLM-generated summary — the ' +
        'response body is stable across runs so downstream assertions can key off it.';
      const inputBudget = estimateTokens(url + length);
      return {
        output: {
          url,
          length,
          summary: summaryText,
          citation_count: 0,
        },
        executionStatus: 'SUCCESS',
        executionDurationMs: estimateDurationMs(url + length, 100),
        tokensIn: inputBudget,
        tokensOut: estimateTokens(summaryText),
      };
    },
  },

  extract_entities: {
    name: 'extract_entities',
    description: 'Extract named entities from a text block. Synthetic response.',
    simulatedLatencyMs: 500,
    handle: (input) => {
      const text = String(input.text ?? '');
      // Deterministic entity list — same input, same output.
      const entities = [
        { type: 'PERSON', text: 'Alice Example' },
        { type: 'ORG', text: 'Acme Research' },
        { type: 'LOCATION', text: 'San Francisco' },
      ];
      return {
        output: {
          text_length: text.length,
          entities,
          entity_count: entities.length,
        },
        executionStatus: 'SUCCESS',
        executionDurationMs: estimateDurationMs(text, 80),
        tokensIn: estimateTokens(text),
        tokensOut: estimateTokens(JSON.stringify(entities)),
      };
    },
  },

  verify_claim: {
    name: 'verify_claim',
    description: 'Verify a claim against candidate sources. Synthetic verdict.',
    simulatedLatencyMs: 500,
    handle: (input) => {
      const claim = String(input.claim ?? '');
      const sources = Array.isArray(input.sources) ? input.sources : [];
      // Deterministic: verdict depends on claim length parity. HITL_REQUIRED
      // when the caller explicitly requests it (matches research-agent.yaml
      // governance.hitl_required_for=[verify_claim] semantics — a real
      // implementation would enforce HITL; the test server flags it based on
      // an input hint so both the SUCCESS and HITL_REQUIRED branches are
      // exercisable from a scripted run).
      const requireHitl = input.require_hitl === true;
      let verdict: 'supported' | 'refuted' | 'unverifiable';
      if (claim.length === 0) verdict = 'unverifiable';
      else if (claim.length % 2 === 0) verdict = 'supported';
      else verdict = 'refuted';
      const executionStatus: ExecutionStatus = requireHitl ? 'HITL_REQUIRED' : 'SUCCESS';
      return {
        output: {
          claim,
          verdict,
          citation: sources[0] ?? null,
          sources_considered: sources.length,
        },
        executionStatus,
        executionDurationMs: estimateDurationMs(claim, 150),
        tokensIn: estimateTokens(claim + sources.join(',')),
        tokensOut: estimateTokens(verdict + String(sources[0] ?? '')),
      };
    },
  },

  rank_sources: {
    name: 'rank_sources',
    description: 'Rank a list of source URLs by synthetic relevance to a query.',
    simulatedLatencyMs: 500,
    handle: (input) => {
      const query = String(input.query ?? '');
      const sources = Array.isArray(input.sources) ? (input.sources as unknown[]) : [];
      // Round-robin the input: deterministic ranking = reverse order.
      const ranked = [...sources].reverse().map((s, idx) => ({
        source: s,
        rank: idx + 1,
        relevance: (sources.length - idx) / Math.max(1, sources.length),
      }));
      return {
        output: {
          query,
          ranked,
          count: ranked.length,
        },
        executionStatus: 'SUCCESS',
        executionDurationMs: estimateDurationMs(query, 60),
        tokensIn: estimateTokens(query + JSON.stringify(sources)),
        tokensOut: estimateTokens(JSON.stringify(ranked)),
      };
    },
  },

  answer_question: {
    name: 'answer_question',
    description: 'Synthesize a cited answer from a question. Synthetic response.',
    simulatedLatencyMs: 500,
    handle: (input) => {
      const question = String(input.question ?? '');
      const maxSources = Number(input.max_sources ?? 3);
      const answerText = `Synthetic answer to "${question}" derived from ` +
        `${maxSources} synthetic sources. Response body is stable across runs.`;
      const sources = Array.from({ length: Math.min(maxSources, 5) }, (_, i) => ({
        source: `https://synthetic.example/${i + 1}`,
        title: `Synthetic Source ${i + 1}`,
      }));
      return {
        output: {
          question,
          answer: answerText,
          sources,
        },
        executionStatus: 'SUCCESS',
        executionDurationMs: estimateDurationMs(question, 200),
        tokensIn: estimateTokens(question),
        tokensOut: estimateTokens(answerText + JSON.stringify(sources)),
      };
    },
  },
};

/** Canonical capability list. */
export function listCapabilities(): { name: string; description: string }[] {
  return Object.values(registry).map((h) => ({
    name: h.name,
    description: h.description,
  }));
}

export function hasCapability(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(registry, name);
}

export interface CallCapabilityOptions {
  simulateLatency?: boolean;
}

/**
 * Dispatch a capability. Returns the result payload; the caller stamps the
 * invocationId + sessionId and writes the wire response. Sleeps the
 * per-capability simulatedLatencyMs when opts.simulateLatency is true.
 */
export async function callCapability(
  name: string,
  input: Record<string, unknown>,
  opts: CallCapabilityOptions = {},
): Promise<CapabilityResult> {
  const handler = registry[name];
  if (!handler) {
    // Callers gate on hasCapability() BEFORE this — reaching here means a
    // bug in the caller. Throw so the transport layer surfaces it as a 500
    // instead of silently returning an empty body.
    throw new Error(`unknown capability: ${name}`);
  }
  if (opts.simulateLatency) {
    await new Promise((r) => setTimeout(r, handler.simulatedLatencyMs));
  }
  return handler.handle(input);
}
