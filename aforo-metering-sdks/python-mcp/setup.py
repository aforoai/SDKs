from setuptools import setup, find_packages

setup(
    name="aforo-mcp-metering",
    version="2.0.0",
    description="Aforo MCP Server Metering SDK — automatic billing for MCP tool handlers",
    license="Apache-2.0",
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=["httpx>=0.25"],
    extras_require={
        # Kept so old install lines keep working; the SDK uses only httpx.
        "aiohttp": [],
        "httpx": [],
    },
)
