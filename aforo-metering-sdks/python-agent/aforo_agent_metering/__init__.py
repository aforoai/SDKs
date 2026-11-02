"""
aforo-agent-metering — Aforo AI Agent Metering SDK for Python.

Instrument AI agent runtimes (LangChain, LlamaIndex, CrewAI, AutoGen,
FastAPI-hosted agents) to bill capability invocations, steps, and
sessions on Aforo's AI_AGENT product type.

Usage:
    from aforo_agent_metering import AforoAgentClient, wrap_capability_handler

    client = AforoAgentClient(
        tenant_id="tenant_xxx",
        product_id="prod_ai_001",
        api_key=os.environ["AFORO_API_KEY"],
        ingestor_url="https://api.aforo.ai",
    )

    @wrap_capability_handler(
        client,
        capability_name="summarize_email",
        customer_resolver=lambda args, kwargs: current_user().customer_id,
    )
    async def summarize(text: str, *, agent_id: str, session_id: str):
        ...

    await client.shutdown()  # sends what is left; also runs at exit
"""

from .client import (
    EXECUTION_STATUSES,
    AforoAgentClient,
    ExecutionStatus,
    __version__,
    normalize_execution_status,
)
from .decorators import wrap_capability_handler

__all__ = [
    "AforoAgentClient",
    "EXECUTION_STATUSES",
    "ExecutionStatus",
    "__version__",
    "normalize_execution_status",
    "wrap_capability_handler",
]
