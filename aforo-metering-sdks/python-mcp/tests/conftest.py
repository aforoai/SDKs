import pytest

from . import loopback_guard
from .mock_ingestor import NODE, MockIngestor

loopback_guard.install()


@pytest.fixture
def mock_ingestor():
    if NODE is None:
        pytest.skip("node is not installed; the mock ingestor needs it")
    mock = MockIngestor()
    try:
        yield mock
    finally:
        mock.close()
