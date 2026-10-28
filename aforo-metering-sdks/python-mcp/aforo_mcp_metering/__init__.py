"""
aforo-mcp-metering — Aforo MCP Server Metering SDK for Python

Wraps MCP tool handlers to automatically meter tool invocations,
track sessions, and enforce entitlements via Aforo's billing platform.

Usage:
    from aforo_mcp_metering import AforoMcpBilling

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
        # Your tool logic
        return [TextContent(type="text", text=result)]
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
