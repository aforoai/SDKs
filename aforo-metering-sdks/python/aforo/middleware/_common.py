"""Helpers shared by the framework middlewares."""

from __future__ import annotations

import logging
from typing import Any, Callable, Optional, Union

from .._transport.identity import clean_customer_id, require_customer_source
from ..limits import truncate_label

logger = logging.getLogger("aforo.middleware")

NO_CUSTOMER = "no customer for this request (the customer resolver returned nothing)"

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


def customer_lookup(
    customer_resolver: CustomerId,
    trust_customer_header: bool,
    header_reader: Callable[[Any], Optional[str]],
    *,
    integration: str,
) -> Callable[[Any], Optional[str]]:
    """Build the per-request customer lookup, or raise ValueError.

    ``customer_resolver`` is a callable (or one fixed id) that returns the
    customer from identity your service has verified. Without one,
    ``trust_customer_header=True`` is required to read ``X-Customer-Id``, a
    header the caller of your API controls. There is no other fallback.
    """
    resolver: Optional[Callable[[Any], Any]]
    if customer_resolver is None or callable(customer_resolver):
        resolver = customer_resolver
    else:
        fixed = clean_customer_id(customer_resolver)
        if fixed is None:
            raise ValueError(f"{integration}: customer_resolver is blank")
        resolver = lambda _request: fixed  # noqa: E731 -- one configured customer
    require_customer_source(resolver, trust_customer_header, integration=integration,
                            untrusted_source="the X-Customer-Id request header")

    def lookup(request: Any) -> Optional[str]:
        if resolver is not None:
            return clean_customer_id(resolver(request))
        return clean_customer_id(header_reader(request))

    return lookup


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

    ``endpointPath`` (the request path without the query string) and
    ``httpMethod`` come from the incoming request, so an over-long value is cut
    to the ingestor's limit (512 / 16 UTF-16 code units) and the event is still
    sent -- dropping it would let a caller avoid metering with a long path.
    """
    endpoint = (path or "/").split("?", 1)[0] or "/"
    fields: dict = {
        "endpointPath": truncate_label("endpointPath", endpoint),
        "httpMethod": truncate_label("httpMethod", (method or "UNKNOWN").upper()),
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
