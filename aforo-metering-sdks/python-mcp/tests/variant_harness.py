"""How the shared wave-5 transport tests build and feed this variant's client.

AforoMcpBilling's flush()/shutdown() are coroutines; the shared tests call
them synchronously, so the harness hands out a thin synchronous view."""

from aforo_mcp_metering import AforoMcpBilling
from aforo_mcp_metering import client as CLIENT_MODULE  # noqa: N812


class _SyncView:
    def __init__(self, billing: AforoMcpBilling) -> None:
        self.billing = billing

    def __repr__(self) -> str:
        return repr(self.billing)

    def flush(self, timeout=None):
        return self.billing._core.flush(timeout).pending

    def shutdown(self, timeout=None):
        self.billing.shutdown_sync(timeout)

    @property
    def dropped_count(self):
        return self.billing.dropped_count


def MAKE(url, *, api_key="test-key", timeout=None, shutdown_timeout=None, **kw):  # noqa: N802
    if timeout is not None:
        kw["timeout_sec"] = timeout
    if shutdown_timeout is not None:
        kw["shutdown_timeout_sec"] = shutdown_timeout
    kw.setdefault("flush_interval_sec", 3600)
    kw.setdefault("heartbeat_enabled", False)
    return _SyncView(AforoMcpBilling(tenant_id="tenant-1", product_id="prod-1", api_key=api_key,
                                     ingestor_url=url, **kw))


def EMIT(view, i, customer="cust_1"):  # noqa: N802
    view.billing.record_tool_invocation(f"tool_{i}", "agent_1", customer_id=customer)
