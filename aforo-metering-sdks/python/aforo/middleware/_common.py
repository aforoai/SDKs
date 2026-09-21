"""Helpers shared by the framework middlewares."""

from __future__ import annotations

from typing import Any, Callable, Optional, Union

DEFAULT_METRIC_NAME = "api_calls"
"""Metric recorded per request when ``metric_name`` is not configured.

It must exist in the tenant's Aforo metric catalog: the ingestor rejects an
unknown metric, and because it validates a batch as a whole, one such event
fails the entire batch with 400. The previous default, ``"METHOD /path"``, is a
name no catalog contains, so every event failed out of the box.
"""

MetricName = Union[str, Callable[..., Optional[str]], None]
CustomerId = Union[str, Callable[..., Optional[str]], None]


def is_preflight(method: Optional[str]) -> bool:
    """CORS preflights are browser protocol, not billable calls, and carry no
    credentials -- so they never have a customer. They are never metered."""
    return (method or "").upper() == "OPTIONS"


def resolve_metric_name(metric_name: MetricName, *args: Any) -> str:
    """Resolver callable, then fixed name, then :data:`DEFAULT_METRIC_NAME`."""
    if callable(metric_name):
        return metric_name(*args) or DEFAULT_METRIC_NAME
    return metric_name or DEFAULT_METRIC_NAME


def resolve_customer_id(customer_id: CustomerId, request: Any) -> Optional[str]:
    """Configured customer resolver/fixed value, or ``None`` if not configured."""
    if callable(customer_id):
        value = customer_id(request)
    else:
        value = customer_id
    if value is None:
        return None
    value = str(value).strip()
    return value or None
