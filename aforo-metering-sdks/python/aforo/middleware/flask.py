"""Flask extension for automatic API usage metering."""

from __future__ import annotations

import time
from typing import Any, Optional

from ..client import AforoClient
from ._common import (
    DEFAULT_METRIC_NAME,
    http_fields,
    is_preflight,
    resolve_customer_id,
    resolve_metric_name,
    resolve_product_type,
)

_DEFAULT_EXCLUDE = ["/health", "/ready", "/metrics", "/favicon.ico", "/static"]


class AforoMetering:
    """Flask extension that captures usage events via ``after_request``.

    Usage::

        from aforo.middleware.flask import AforoMetering
        aforo = AforoMetering(
            app,
            api_key=os.environ["AFORO_API_KEY"],
            metric_name="api_calls",                       # or a callable(request, response)
            customer_id=lambda req: req.headers.get("X-Customer-Id"),
            product_type="API",
        )

    Options (keyword arguments, or ``AFORO_*`` app config):

    * ``metric_name`` / ``AFORO_METRIC_NAME`` -- fixed metric or
      ``callable(request, response) -> str``. Default ``"api_calls"``. Must name
      a metric in your Aforo catalog: the ingestor rejects unknown metrics, and
      one rejected event fails the whole batch.
    * ``customer_id`` / ``AFORO_CUSTOMER_ID`` -- fixed id or
      ``callable(request) -> str | None``. Default: the ``X-Customer-Id`` header.
      The caller's ``X-Api-Key`` is never used -- it is a secret, not an id.
      Requests with no customer are not metered.
    * ``product_type`` / ``AFORO_PRODUCT_TYPE`` -- top-level ``productType`` on
      every event. Default ``"API"``.
    * ``exclude_paths``, ``exclude_status_codes``.

    Every event also carries top-level ``endpointPath`` (path without query),
    ``httpMethod``, ``statusCode`` and ``responseTimeMs``.
    ``OPTIONS`` (CORS preflight) requests are never metered.
    """

    def __init__(self, app: Optional[Any] = None, **kwargs) -> None:
        self._client: Optional[AforoClient] = None
        self._kwargs = kwargs
        self._exclude_paths = kwargs.pop("exclude_paths", _DEFAULT_EXCLUDE)
        self._exclude_status_codes = kwargs.pop("exclude_status_codes", [])
        self._metric_name = kwargs.pop("metric_name", None)
        self._customer_id = kwargs.pop("customer_id", None)
        self._product_type = kwargs.pop("product_type", None)
        if app is not None:
            self.init_app(app)

    def init_app(self, app: Any) -> None:
        api_key = self._kwargs.get("api_key", app.config.get("AFORO_API_KEY", ""))
        base_url = self._kwargs.get("base_url", app.config.get("AFORO_BASE_URL", "https://api.aforo.ai"))
        if self._metric_name is None:
            self._metric_name = app.config.get("AFORO_METRIC_NAME", DEFAULT_METRIC_NAME)
        if self._customer_id is None:
            self._customer_id = app.config.get("AFORO_CUSTOMER_ID")
        self._product_type = resolve_product_type(
            self._product_type if self._product_type is not None
            else app.config.get("AFORO_PRODUCT_TYPE")
        )

        self._client = AforoClient(
            api_key=api_key, base_url=base_url, product_type=self._product_type
        )
        app.before_request(self._before_request)
        app.after_request(self._after_request)

    def _before_request(self) -> None:
        try:
            from flask import g

            g._aforo_start = time.monotonic()
        except Exception:
            pass

    def _after_request(self, response: Any) -> Any:
        try:
            from flask import request

            path = request.path or "/"
            status_code = response.status_code

            if is_preflight(request.method):
                return response
            if any(path.startswith(p) for p in self._exclude_paths):
                return response
            if status_code in self._exclude_status_codes:
                return response

            if self._customer_id is not None:
                customer_id = resolve_customer_id(self._customer_id, request)
            else:
                customer_id = resolve_customer_id(request.headers.get("X-Customer-Id"), request)

            if not customer_id:
                return response

            from flask import g

            start = getattr(g, "_aforo_start", None)
            elapsed_ms = int((time.monotonic() - start) * 1000) if start is not None else None

            if self._client:
                self._client.track(
                    customer_id=customer_id,
                    metric_name=resolve_metric_name(self._metric_name, request, response),
                    quantity=1,
                    product_type=self._product_type,
                    extra_fields=http_fields(path, request.method, status_code, elapsed_ms),
                )
        except Exception:
            pass

        return response
