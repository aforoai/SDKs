from setuptools import setup, find_packages

setup(
    name="aforo-ws-metering",
    version="1.0.0",
    description="Aforo WebSocket Metering SDK — wrappers for the `websockets` library + FastAPI/Starlette WebSocket routes that meter frames, bytes and connection duration.",
    long_description=open("README.md").read() if __import__("os").path.exists("README.md") else "",
    long_description_content_type="text/markdown",
    author="Aforo, Inc.",
    license="MIT",
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=[],
    extras_require={
        "websockets": ["websockets>=11"],
        "fastapi": ["fastapi>=0.100", "starlette>=0.27"],
        "aiohttp": ["aiohttp>=3.8"],
        "httpx": ["httpx>=0.24"],
    },
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Software Development :: Libraries",
    ],
)
