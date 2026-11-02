"""Customer identity for integrations that meter incoming requests.

Every integration (HTTP middleware, gRPC / GraphQL / WebSocket / MQTT
wrappers, MCP and agent decorators) needs to know which customer to bill. That
must come from identity your service has verified -- a session, a JWT subject,
an API-key lookup -- through a ``customer_resolver`` you supply. Reading a value
the caller of your API sends (an ``X-Customer-Id`` header, gRPC metadata, an MCP
``_meta.customer_id``) lets any caller bill someone else, so it needs the
explicit opt-in ``trust_customer_header=True``.
"""

from __future__ import annotations

from typing import Any, Callable, Optional


def require_customer_source(resolver: Optional[Callable[..., Any]], trust_customer_header: bool,
                            *, integration: str, untrusted_source: str) -> None:
    """Raise ValueError unless the integration has a way to find the customer."""
    if resolver is not None and not callable(resolver):
        raise TypeError(f"{integration}: customer_resolver must be callable")
    if resolver is None and not trust_customer_header:
        raise ValueError(
            f"{integration} needs to know which customer to bill. Pass "
            "customer_resolver=<a function that returns the customer id from identity your "
            f"service has verified>, or trust_customer_header=True to read {untrusted_source}, "
            "which the caller of your API controls."
        )


def clean_customer_id(value: Any) -> Optional[str]:
    """Trimmed string, or None for a missing / blank value."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None
