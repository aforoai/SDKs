from . import loopback_guard

loopback_guard.install()

import pytest

from .mock_ingestor import NODE, MockIngestor


@pytest.fixture
def mock_ingestor():
    if NODE is None:
        pytest.skip("node is not installed; the mock ingestor needs it")
    mock = MockIngestor()
    try:
        yield mock
    finally:
        mock.close()
