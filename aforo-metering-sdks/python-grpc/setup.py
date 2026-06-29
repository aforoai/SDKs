from setuptools import setup, find_packages

setup(
    name="aforo-grpc-metering",
    version="1.0.0",
    description="Aforo gRPC Metering SDK — server interceptors and decorators that meter every RPC call to Aforo's usage ingestor.",
    long_description=open("README.md").read() if __import__("os").path.exists("README.md") else "",
    long_description_content_type="text/markdown",
    author="Aforo, Inc.",
    license="Apache-2.0",
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=[
        "grpcio>=1.50.0",
    ],
    extras_require={
        "aiohttp": ["aiohttp>=3.8"],
        "httpx": ["httpx>=0.24"],
    },
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: Apache Software License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Software Development :: Libraries",
    ],
)
