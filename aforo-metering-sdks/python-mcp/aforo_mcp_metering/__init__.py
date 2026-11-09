"""
aforo-mcp-metering — Aforo MCP Server Metering SDK for Python

Wraps MCP tool handlers to automatically meter tool invocations and
track sessions for Aforo's billing platform. It does not enforce
entitlements.

Usage (``mcp`` 1.x low-level server):
    import os
    import mcp.types as types
    from mcp.server.lowlevel import Server
    from aforo_mcp_metering import AforoMcpBilling

    server = Server("my-tools")

    billing = AforoMcpBilling(
        tenant_id="tenant_smartai",
        product_id="prod_mcp_001",
        api_key=os.environ["AFORO_API_KEY"],
        ingestor_url="https://api.aforo.ai",
        # Bill the customer your server authenticated, never a value the client sends.
        customer_resolver=lambda call: current_session_customer_id(),
    )

    @server.call_tool()
    @billing.wrap_tool_handler
    async def handle_tool(name: str, arguments: dict):
        # Your tool logic. agentId is the MCP client's clientInfo.name
        # unless an agent_id kwarg or agent_resolver gives one.
        return [types.TextContent(type="text", text=result)]
"""

from .client import (
    EXECUTION_STATUSES,
    AforoMcpBilling,
    CustomerResolver,
    ToolCall,
    ToolStatusResolver,
    __version__,
    default_tool_status,
)

__all__ = [
    "EXECUTION_STATUSES",
    "AforoMcpBilling",
    "CustomerResolver",
    "ToolCall",
    "ToolStatusResolver",
    "__version__",
    "default_tool_status",
]
