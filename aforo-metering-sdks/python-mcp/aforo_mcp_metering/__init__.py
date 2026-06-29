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
        ingestor_url="https://ingestor.aforo.ai",
    )

    @server.call_tool()
    @billing.wrap_tool_handler
    async def handle_tool(name: str, arguments: dict):
        # Your tool logic
        return [TextContent(type="text", text=result)]
"""

from .client import AforoMcpBilling

__all__ = ["AforoMcpBilling"]
__version__ = "1.0.0"
