"""Flask extension for automatic API usage metering."""

from __future__ import annotations

from typing import Any, Optional

from ..client import AforoClient
from ..path_normalizer import normalize_path

_DEFAULT_EXCLUDE = ["/health", "/ready", "/metrics", "/favicon.ico", "/static"]


class AforoMetering:
    """Flask extension that captures usage events via ``after_request``.

    Usage::

        from aforo.middleware.flask import AforoMetering
        aforo = AforoMetering(app, api_key=os.environ["AFORO_API_KEY"])
    """

    def __init__(self, app: Optional[Any] = None, **kwargs) -> None:
        self._client: Optional[AforoClient] = None
        self._kwargs = kwargs
        self._exclude_paths = kwargs.pop("exclude_paths", _DEFAULT_EXCLUDE)
        self._exclude_status_codes = kwargs.pop("exclude_status_codes", [])
        if app is not None:
            self.init_app(app)

    def init_app(self, app: Any) -> None:
        api_key = self._kwargs.get("api_key", app.config.get("AFORO_API_KEY", ""))
        base_url = self._kwargs.get("base_url", app.config.get("AFORO_BASE_URL", "https://ingest.aforo.ai"))

        self._client = AforoClient(api_key=api_key, base_url=base_url)
        app.after_request(self._after_request)

    def _after_request(self, response: Any) -> Any:
        try:
            from flask import request

            path = request.path or "/"
            method = request.method or "UNKNOWN"
            status_code = response.status_code

            if any(path.startswith(p) for p in self._exclude_paths):
                return response
            if status_code in self._exclude_status_codes:
                return response

            rule = request.url_rule
            route_template = rule.rule if rule else None
            normalized = normalize_path(path, route_template)

            customer_id = (
                request.headers.get("X-Customer-Id")
                or request.headers.get("X-Api-Key")
            )

            if not customer_id:
                return response

            if self._client:
                self._client.track(
                    customer_id=customer_id,
                    metric_name=f"{method} {normalized}",
                    quantity=1,
                )
        except Exception:
            pass

        return response
