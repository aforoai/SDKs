"""Django middleware for automatic API usage metering."""

from __future__ import annotations

import os
from typing import Any, Callable

from ..client import AforoClient
from ..path_normalizer import normalize_path

_DEFAULT_EXCLUDE = ["/health", "/ready", "/metrics", "/favicon.ico", "/admin", "/static"]


class AforoMeteringMiddleware:
    """Django middleware that captures usage events after each response.

    Usage in ``settings.py``::

        MIDDLEWARE = [
            ...
            "aforo.middleware.django.AforoMeteringMiddleware",
        ]
        AFORO_API_KEY = os.environ["AFORO_API_KEY"]
    """

    def __init__(self, get_response: Callable) -> None:
        self.get_response = get_response

        from django.conf import settings
        api_key = getattr(settings, "AFORO_API_KEY", os.environ.get("AFORO_API_KEY", ""))
        base_url = getattr(settings, "AFORO_BASE_URL", "https://ingest.aforo.ai")

        self._client = AforoClient(api_key=api_key, base_url=base_url)
        self._exclude_paths = getattr(settings, "AFORO_EXCLUDE_PATHS", _DEFAULT_EXCLUDE)
        self._exclude_status_codes = getattr(settings, "AFORO_EXCLUDE_STATUS_CODES", [])

    def __call__(self, request: Any) -> Any:
        response = self.get_response(request)

        try:
            path = request.path or "/"
            method = request.method or "UNKNOWN"
            status_code = response.status_code

            if any(path.startswith(p) for p in self._exclude_paths):
                return response
            if status_code in self._exclude_status_codes:
                return response

            route = getattr(request, "resolver_match", None)
            route_template = route.route if route else None
            normalized = normalize_path(path, route_template)

            customer_id = (
                getattr(request, "user", None) and getattr(request.user, "id", None)
                or request.META.get("HTTP_X_CUSTOMER_ID")
                or request.META.get("HTTP_X_API_KEY")
            )

            if not customer_id:
                return response

            self._client.track(
                customer_id=str(customer_id),
                metric_name=f"{method} {normalized}",
                quantity=1,
            )
        except Exception:
            pass

        return response
