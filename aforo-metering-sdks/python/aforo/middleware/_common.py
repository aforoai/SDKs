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

DEFAULT_PRODUCT_TYPE = "API"
"""``productType`` stamped on every request event unless ``product_type`` is set."""

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


def resolve_product_type(product_type: Optional[str]) -> str:
    """Trim + upper-case the configured ``product_type``; blank -> ``"API"``."""
    value = str(product_type).strip().upper() if product_type is not None else ""
    return value or DEFAULT_PRODUCT_TYPE


def http_fields(
    path: Optional[str],
    method: Optional[str],
    status_code: Any,
    response_time_ms: Optional[int],
) -> dict:
    """Top-level HTTP fields the ingestor understands (camelCase wire names).

    ``endpointPath`` is the request path without the query string, capped at 512.
    """
    endpoint = (path or "/").split("?", 1)[0] or "/"
    fields: dict = {
        "endpointPath": endpoint[:512],
        "httpMethod": (method or "UNKNOWN").upper()[:16],
        "statusCode": int(status_code),
    }
    if response_time_ms is not None:
        fields["responseTimeMs"] = max(0, int(response_time_ms))
    return fields


def is_billable_quantity(quantity: Any) -> bool:
    """The ingestor rejects quantity <= 0 (and fails the whole batch), so skip it."""
    try:
        return quantity is not None and not isinstance(quantity, bool) and float(quantity) > 0
    except (TypeError, ValueError):
        return False
