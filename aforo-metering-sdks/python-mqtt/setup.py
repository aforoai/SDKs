from setuptools import setup, find_packages

setup(
    name="aforo-mqtt-metering",
    version="1.0.0",
    description="Aforo MQTT Metering SDK — paho-mqtt and aiomqtt client wrappers that meter PUBLISH/SUBSCRIBE/CONNECT/DISCONNECT events.",
    long_description=open("README.md").read() if __import__("os").path.exists("README.md") else "",
    long_description_content_type="text/markdown",
    author="Aforo, Inc.",
    license="Apache-2.0",
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=[],
    extras_require={
        "paho": ["paho-mqtt>=1.6"],
        "aiomqtt": ["aiomqtt>=2.0"],
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
