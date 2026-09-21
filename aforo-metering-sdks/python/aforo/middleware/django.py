"""Django middleware for automatic API usage metering."""

from __future__ import annotations

import os
from typing import Any, Callable

from ..client import AforoClient
from ._common import (
    DEFAULT_METRIC_NAME,
    is_preflight,
    resolve_customer_id,
    resolve_metric_name,
)

_DEFAULT_EXCLUDE = ["/health", "/ready", "/metrics", "/favicon.ico", "/admin", "/static"]


def _default_customer_id(request: Any) -> Any:
    """Authenticated user's id, then the ``X-Customer-Id`` header.

    The caller's ``X-Api-Key`` header is deliberately NOT used: that is the end
    user's secret, and using it as customerId wrote credentials into billing
    data while never matching an Aforo customer.
    """
    user = getattr(request, "user", None)
    user_id = getattr(user, "id", None) if user is not None else None
    return user_id or request.META.get("HTTP_X_CUSTOMER_ID")


class AforoMeteringMiddleware:
    """Django middleware that captures usage events after each response.

    Usage in ``settings.py``::

        MIDDLEWARE = [
            ...
            "aforo.middleware.django.AforoMeteringMiddleware",
        ]
        AFORO_API_KEY = os.environ["AFORO_API_KEY"]
        AFORO_METRIC_NAME = "api_calls"          # or a callable(request, response) -> str
        AFORO_CUSTOMER_ID = lambda request: request.headers.get("X-Customer-Id")

    ``AFORO_METRIC_NAME`` defaults to ``"api_calls"`` and must name a metric in
    your Aforo catalog: the ingestor rejects unknown metrics, and one rejected
    event fails the whole batch. ``AFORO_CUSTOMER_ID`` (fixed id or
    ``callable(request)``) defaults to ``request.user.id`` then the
    ``X-Customer-Id`` header; requests with no customer are not metered.
    ``OPTIONS`` (CORS preflight) requests are never metered.
    """

    def __init__(self, get_response: Callable) -> None:
        self.get_response = get_response

        from django.conf import settings
        api_key = getattr(settings, "AFORO_API_KEY", os.environ.get("AFORO_API_KEY", ""))
        base_url = getattr(settings, "AFORO_BASE_URL", "https://ingest.aforo.ai")

        self._client = AforoClient(api_key=api_key, base_url=base_url)
        self._exclude_paths = getattr(settings, "AFORO_EXCLUDE_PATHS", _DEFAULT_EXCLUDE)
        self._exclude_status_codes = getattr(settings, "AFORO_EXCLUDE_STATUS_CODES", [])
        self._metric_name = getattr(settings, "AFORO_METRIC_NAME", DEFAULT_METRIC_NAME)
        self._customer_id = getattr(settings, "AFORO_CUSTOMER_ID", None) or _default_customer_id

    def __call__(self, request: Any) -> Any:
        response = self.get_response(request)

        try:
            path = request.path or "/"
            status_code = response.status_code

            if is_preflight(request.method):
                return response
            if any(path.startswith(p) for p in self._exclude_paths):
                return response
            if status_code in self._exclude_status_codes:
                return response

            customer_id = resolve_customer_id(self._customer_id, request)
            if not customer_id:
                return response

            self._client.track(
                customer_id=customer_id,
                metric_name=resolve_metric_name(self._metric_name, request, response),
                quantity=1,
            )
        except Exception:
            pass

        return response
