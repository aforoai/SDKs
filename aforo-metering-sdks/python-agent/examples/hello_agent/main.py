#!/usr/bin/env python3
"""hello_agent — runnable Python example for aforo-agent-metering.

Sibling of node-agent/examples/hello-agent — same 10-invocation plan
across the 5 canonical capabilities from research-agent.yaml, expressed
against the Python SDK. Verifies the SDK's session start / record_capability
/ record_step / flush chain and prints per-event JSON to stdout so an
operator can eyeball payloads against the wire shape usage-ingestor
expects.

What this covers:
    - AforoAgentClient construction with env-driven config
    - client.start() to kick off the periodic-flush background task
    - client.record_capability() with capability_name (metadata
      snake_case → ProductTypeEventExtractor.extractAiAgentFields
      → event.toolName for per-capability billing)
    - Explicit token counts + execution duration per capability
    - HITL_REQUIRED execution status on one verify_claim call to
      exercise the governance branch
    - client.shutdown() for a final flush before exit

Run:
    cd examples/hello_agent
    cp .env.example .env    # then edit
    pip install -r requirements.txt
    python main.py

Verify:
    - usage-ingestor Postgres: expect 10 rows in usage_events with
      metric_name='ai_agent.capability_invocations' for this session.
    - analytics-service ClickHouse: expect 10 rows in
      ai_agent_invocations keyed by capability_name.
    See the README for the exact SQL.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
import uuid
from dataclasses import dataclass
from typing import Any

# dotenv is optional — this example still runs with raw os.environ.
try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

from aforo_agent_metering import AforoAgentClient


@dataclass(frozen=True)
class Config:
    tenant_id: str
    product_id: str
    api_key: str
    ingestor_url: str
    agent_id: str
    customer_id: str


def _read_config() -> Config:
    """Read + validate env vars, exit with a helpful message on miss."""
    missing: list[str] = []
    tenant = os.environ.get("AFORO_TENANT_ID", "").strip()
    product = os.environ.get("AFORO_PRODUCT_ID", "").strip()
    api_key = os.environ.get("AFORO_API_KEY", "").strip()
    if not tenant:
        missing.append("AFORO_TENANT_ID")
    if not product:
        missing.append("AFORO_PRODUCT_ID")
    if not api_key:
        missing.append("AFORO_API_KEY")
    if missing:
        sys.stderr.write(
            f"[hello_agent] missing required env vars: {', '.join(missing)}\n"
            f"Copy .env.example to .env and fill in the values.\n",
        )
        sys.exit(2)
    return Config(
        tenant_id=tenant,
        product_id=product,
        api_key=api_key,
        ingestor_url=os.environ.get(
            "AFORO_INGEST_URL", "https://api.aforo.ai",
        ).strip(),
        agent_id=os.environ.get(
            "AFORO_AGENT_ID", "agent_hello_001",
        ).strip() or "agent_hello_001",
        customer_id=os.environ.get(
            "AFORO_CUSTOMER_ID", "cust_hello_001",
        ).strip() or "cust_hello_001",
    )


# 10 total: 3 summarize_url, 2 extract_entities, 2 verify_claim (1 HITL),
# 2 rank_sources, 1 answer_question. Deterministic — same run every time.
PLAN: list[dict[str, Any]] = [
    {"cap": "summarize_url", "in": 320, "out": 84, "ms": 510, "status": "SUCCESS",
     "meta": {"input_url": "https://example.com/a1"}},
    {"cap": "summarize_url", "in": 410, "out": 96, "ms": 620, "status": "SUCCESS",
     "meta": {"input_url": "https://example.com/a2"}},
    {"cap": "summarize_url", "in": 280, "out": 72, "ms": 480, "status": "SUCCESS",
     "meta": {"input_url": "https://example.com/a3"}},
    {"cap": "extract_entities", "in": 180, "out": 44, "ms": 260, "status": "SUCCESS",
     "meta": {"input_text_length": 37}},
    {"cap": "extract_entities", "in": 150, "out": 38, "ms": 240, "status": "SUCCESS",
     "meta": {"input_text_length": 30}},
    {"cap": "verify_claim", "in": 220, "out": 55, "ms": 720, "status": "SUCCESS",
     "meta": {"input_claim": "The sky is blue"}},
    {"cap": "verify_claim", "in": 260, "out": 60, "ms": 890, "status": "HITL_REQUIRED",
     "meta": {"input_claim": "Requires human review"}},
    {"cap": "rank_sources", "in": 190, "out": 48, "ms": 320, "status": "SUCCESS",
     "meta": {"input_query": "aforo"}},
    {"cap": "rank_sources", "in": 240, "out": 52, "ms": 400, "status": "SUCCESS",
     "meta": {"input_query": "billing"}},
    {"cap": "answer_question", "in": 380, "out": 128, "ms": 1200, "status": "SUCCESS",
     "meta": {"input_question": "What is AI agent metering?"}},
]


async def run() -> None:
    # WARNING logger so drop hooks emit visibly on the console.
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")

    cfg = _read_config()
    sys.stderr.write(f"[hello_agent] target: {cfg.ingestor_url}\n")
    sys.stderr.write(f"[hello_agent] tenant: {cfg.tenant_id}\n")
    sys.stderr.write(f"[hello_agent] product: {cfg.product_id}\n")
    sys.stderr.write(f"[hello_agent] agent: {cfg.agent_id}\n")
    sys.stderr.write(f"[hello_agent] customer: {cfg.customer_id}\n")

    def _on_drop(events: list[dict[str, Any]], reason: str) -> None:
        sys.stderr.write(
            f"[hello_agent] dropped {len(events)} event(s) — {reason}\n"
            f"  keys: {[e.get('idempotencyKey') for e in events]}\n",
        )

    client = AforoAgentClient(
        tenant_id=cfg.tenant_id,
        product_id=cfg.product_id,
        api_key=cfg.api_key,
        ingestor_url=cfg.ingestor_url,
        default_customer_id=cfg.customer_id,
        flush_count=3,
        flush_interval_sec=1.0,
        on_drop=_on_drop,
    )
    await client.start()

    # The Python SDK's session id is a caller-managed value (unlike the Node
    # SDK's opaque handle). Stamp one per run so downstream analytics can
    # correlate the 10 invocations as one session.
    session_id = "sess_" + uuid.uuid4().hex[:16]
    sys.stderr.write(f"[hello_agent] session {session_id} opened\n")

    started_at = time.time()
    total_in = 0
    total_out = 0
    for step in PLAN:
        client.record_capability(
            capability_name=step["cap"],
            agent_id=cfg.agent_id,
            customer_id=cfg.customer_id,
            session_id=session_id,
            input_tokens=step["in"],
            output_tokens=step["out"],
            execution_status=step["status"],
            execution_duration_ms=step["ms"],
            metadata=step["meta"],
        )
        total_in += step["in"]
        total_out += step["out"]
        sys.stdout.write(json.dumps({
            "sessionId": session_id,
            "capability": step["cap"],
            "inputTokens": step["in"],
            "outputTokens": step["out"],
            "durationMs": step["ms"],
            "status": step["status"],
        }) + "\n")
        sys.stdout.flush()

    await client.shutdown()
    elapsed_ms = int((time.time() - started_at) * 1000)

    sys.stderr.write(
        "[hello_agent] ── summary ────────────────────────────────\n"
        f"[hello_agent] session:         {session_id}\n"
        f"[hello_agent] invocations:     {len(PLAN)}\n"
        f"[hello_agent] total tokens in: {total_in}\n"
        f"[hello_agent] total tokens out:{total_out}\n"
        f"[hello_agent] elapsed:         {elapsed_ms}ms\n"
        f"[hello_agent] dropped:         {client.dropped_count}\n",
    )


if __name__ == "__main__":
    asyncio.run(run())
