from setuptools import setup, find_packages

setup(
    name="aforo-mcp-metering",
    version="1.0.0",
    description="Aforo MCP Server Metering SDK — automatic billing for MCP tool handlers",
    license="Apache-2.0",
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=[],
    extras_require={
        "aiohttp": ["aiohttp>=3.8"],
        "httpx": ["httpx>=0.24"],
    },
)
