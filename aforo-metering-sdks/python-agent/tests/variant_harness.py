"""How the shared wave-5 transport tests build and feed this variant's client."""

from aforo_agent_metering import AforoAgentClient
from aforo_agent_metering import client as CLIENT_MODULE  # noqa: N812


class _SyncView:
    def __init__(self, client: AforoAgentClient) -> None:
        self.client = client

    def __repr__(self) -> str:
        return repr(self.client)

    def flush(self, timeout=None):
        return self.client.flush_sync(timeout)

    def shutdown(self, timeout=None):
        self.client.shutdown_sync(timeout)

    @property
    def dropped_count(self):
        return self.client.dropped_count


def MAKE(url, *, api_key="test-key", timeout=None, shutdown_timeout=None, **kw):  # noqa: N802
    if timeout is not None:
        kw["timeout_sec"] = timeout
    if shutdown_timeout is not None:
        kw["shutdown_timeout_sec"] = shutdown_timeout
    kw.setdefault("flush_interval_sec", 3600)
    return _SyncView(AforoAgentClient(tenant_id="tenant-1", product_id="prod-1", api_key=api_key,
                                      ingestor_url=url, **kw))


def EMIT(view, i, customer="cust_1"):  # noqa: N802
    view.client.record_capability(f"cap_{i}", "agent_1", customer_id=customer)
