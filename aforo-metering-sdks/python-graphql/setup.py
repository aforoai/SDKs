from setuptools import setup, find_packages

setup(
    name="aforo-graphql-metering",
    version="1.0.0",
    description="Aforo GraphQL Metering SDK — Strawberry/Graphene/Ariadne extensions + ASGI middleware that meter every GraphQL operation with AST-accurate complexity scoring.",
    long_description=open("README.md").read() if __import__("os").path.exists("README.md") else "",
    long_description_content_type="text/markdown",
    author="Aforo, Inc.",
    license="Apache-2.0",
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=[
        "graphql-core>=3.2",
    ],
    extras_require={
        "aiohttp": ["aiohttp>=3.8"],
        "httpx": ["httpx>=0.24"],
        "strawberry": ["strawberry-graphql>=0.200"],
        "graphene": ["graphene>=3.2"],
        "ariadne": ["ariadne>=0.22"],
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
