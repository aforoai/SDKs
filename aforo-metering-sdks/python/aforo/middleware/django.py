"""Django middleware for automatic API usage metering."""

from __future__ import annotations

import os
import time
from typing import Any, Callable, Optional

from ..client import AforoClient
from ._common import (
    DEFAULT_METRIC_NAME,
    NO_CUSTOMER,
    customer_lookup,
    http_fields,
    is_preflight,
    logger,
    resolve_metric_name,
    resolve_product_type,
)

_DEFAULT_EXCLUDE = ["/health", "/ready", "/metrics", "/favicon.ico", "/admin", "/static"]


def user_id_resolver(request: Any) -> Optional[str]:
    """Ready-made resolver: the id of the authenticated Django user.

    Use it when your Aforo customer ids are your Django user ids::

        AFORO_CUSTOMER_RESOLVER = "aforo.middleware.django.user_id_resolver"
    """
    user = getattr(request, "user", None)
    if user is None or not getattr(user, "is_authenticated", False):
        return None
    user_id = getattr(user, "id", None)
    return str(user_id) if user_id is not None else None


def _header_customer(request: Any) -> Optional[str]:
    return request.META.get("HTTP_X_CUSTOMER_ID")


def _load(value: Any) -> Any:
    """Allow a dotted path in settings (``"myapp.billing.customer_for"``). A
    string that does not import is kept as one fixed customer id."""
    if isinstance(value, str) and "." in value:
        from django.utils.module_loading import import_string

        try:
            return import_string(value)
        except ImportError:
            logger.debug("aforo: %r is not an importable resolver; using it as a fixed customer id", value)
            return value
    return value


class AforoMeteringMiddleware:
    """Django middleware that records one usage event after each response.

    ``settings.py``::

        MIDDLEWARE = [..., "aforo.middleware.django.AforoMeteringMiddleware"]
        AFORO_API_KEY = os.environ["AFORO_API_KEY"]
        AFORO_CUSTOMER_RESOLVER = "myapp.billing.customer_for"  # callable(request) -> str | None
        AFORO_METRIC_NAME = "api_calls"
        AFORO_PRODUCT_TYPE = "API"

    ``AFORO_CUSTOMER_RESOLVER`` (a callable or its dotted path; the old name
    ``AFORO_CUSTOMER_ID`` still works) is required. It returns the customer id
    from identity your service has verified; ``user_id_resolver`` in this module
    returns the authenticated user's id. To read the ``X-Customer-Id`` header
    instead -- a value the caller controls -- set
    ``AFORO_TRUST_CUSTOMER_HEADER = True``. With neither, the middleware raises
    ``ValueError`` when Django builds it. A request with no customer is not
    metered and is counted as an ``invalid`` drop.

    ``AFORO_METRIC_NAME`` defaults to ``"api_calls"`` and must name a metric in
    your Aforo catalog. ``OPTIONS`` requests are never metered. Every event
    carries ``productType``, ``endpointPath``, ``httpMethod``, ``statusCode`` and
    ``responseTimeMs``.
    """

    def __init__(self, get_response: Callable) -> None:
        self.get_response = get_response

        from django.conf import settings
        api_key = getattr(settings, "AFORO_API_KEY", os.environ.get("AFORO_API_KEY", ""))
        base_url = getattr(settings, "AFORO_BASE_URL", "https://api.aforo.ai")
        self._product_type = resolve_product_type(
            getattr(settings, "AFORO_PRODUCT_TYPE", os.environ.get("AFORO_PRODUCT_TYPE"))
        )
        resolver = getattr(settings, "AFORO_CUSTOMER_RESOLVER", None)
        if resolver is None:
            resolver = getattr(settings, "AFORO_CUSTOMER_ID", None)
        self._customer = customer_lookup(
            _load(resolver),
            bool(getattr(settings, "AFORO_TRUST_CUSTOMER_HEADER", False)),
            _header_customer,
            integration="aforo.middleware.django.AforoMeteringMiddleware (settings.AFORO_CUSTOMER_RESOLVER)",
        )
        self._client = AforoClient(
            api_key=api_key, base_url=base_url, product_type=self._product_type,
            allow_insecure_http=bool(getattr(settings, "AFORO_ALLOW_INSECURE_HTTP", False)),
        )
        self._exclude_paths = getattr(settings, "AFORO_EXCLUDE_PATHS", _DEFAULT_EXCLUDE)
        self._exclude_status_codes = getattr(settings, "AFORO_EXCLUDE_STATUS_CODES", [])
        self._metric_name = getattr(settings, "AFORO_METRIC_NAME", DEFAULT_METRIC_NAME)

    @property
    def client(self) -> AforoClient:
        return self._client

    def __call__(self, request: Any) -> Any:
        start = time.monotonic()
        response = self.get_response(request)
        elapsed_ms = int((time.monotonic() - start) * 1000)

        try:
            path = request.path or "/"
            status_code = response.status_code

            if is_preflight(request.method):
                return response
            if any(path.startswith(p) for p in self._exclude_paths):
                return response
            if status_code in self._exclude_status_codes:
                return response

            customer_id = self._customer(request)
            if not customer_id:
                self._client.report_invalid(f"{NO_CUSTOMER}: {request.method} {path[:200]}")
                return response

            self._client.track(
                customer_id=customer_id,
                metric_name=resolve_metric_name(self._metric_name, request, response),
                quantity=1,
                product_type=self._product_type,
                extra_fields=http_fields(path, request.method, status_code, elapsed_ms),
            )
        except Exception:
            logger.debug("aforo: metering a request failed; the response was not affected", exc_info=True)

        return response
