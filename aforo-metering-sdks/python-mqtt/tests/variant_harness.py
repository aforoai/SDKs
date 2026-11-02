"""How the shared wave-5 transport tests build and feed this variant's client."""

from aforo_mqtt_metering import AforoMqttBilling
from aforo_mqtt_metering import client as CLIENT_MODULE  # noqa: N812


def MAKE(url, *, api_key="test-key", timeout=None, shutdown_timeout=None, **kw):  # noqa: N802
    if timeout is not None:
        kw["timeout_sec"] = timeout
    if shutdown_timeout is not None:
        kw["shutdown_timeout_sec"] = shutdown_timeout
    kw.setdefault("flush_interval_sec", 3600)
    return AforoMqttBilling(tenant_id="tenant-1", product_id="prod-1", api_key=api_key, ingestor_url=url, **kw)


def EMIT(billing, i, customer="cust_1"):  # noqa: N802
    billing.push(customer_id=customer, topic=f"t/{i}", qos=0, retained=False, event_type="PUBLISH",
                 client_id="dev-1")
