import loopback_guard

loopback_guard.install()

import pytest

import urlopen_bridge
from aforo_grpc_metering import client as client_module
from mock_ingestor import NODE, MockIngestor


def pytest_configure(config):
    config.addinivalue_line("markers", "real_transport: use the transport core's own httpx transport")


@pytest.fixture(autouse=True)
def _route_http_through_urlopen(request, monkeypatch):
    if request.node.get_closest_marker("real_transport") is None:
        urlopen_bridge.install(monkeypatch, client_module)
    yield


@pytest.fixture
def mock_ingestor():
    if NODE is None:
        pytest.skip("node is not installed; the mock ingestor needs it")
    mock = MockIngestor()
    try:
        yield mock
    finally:
        mock.close()
