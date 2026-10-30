"""Flask extension for automatic API usage metering."""

from __future__ import annotations

import time
from typing import Any, Optional

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

_DEFAULT_EXCLUDE = ["/health", "/ready", "/metrics", "/favicon.ico", "/static"]


def _header_customer(request: Any) -> Optional[str]:
    return request.headers.get("X-Customer-Id")


class AforoMetering:
    """Flask extension that records one usage event per request (``after_request``).

    Usage::

        from aforo.middleware.flask import AforoMetering

        def customer_for(request):
            return g.current_user.customer_id   # identity you have verified

        aforo = AforoMetering(
            app,
            api_key=os.environ["AFORO_API_KEY"],
            customer_resolver=customer_for,       # required
            metric_name="api_calls",
        )

    Options (keyword arguments, or ``AFORO_*`` app config):

    * ``customer_resolver`` / ``AFORO_CUSTOMER_RESOLVER`` -- required:
      ``callable(request) -> str | None`` (``customer_id`` / ``AFORO_CUSTOMER_ID``
      still work as its old name). ``trust_customer_header=True`` /
      ``AFORO_TRUST_CUSTOMER_HEADER`` reads ``X-Customer-Id`` instead -- a value
      the caller controls. With neither, ``init_app`` raises ``ValueError``. A
      request with no customer is not metered and counts as an ``invalid`` drop.
    * ``metric_name`` / ``AFORO_METRIC_NAME`` -- fixed metric or
      ``callable(request, response) -> str``. Default ``"api_calls"``; it must
      name a metric in your Aforo catalog.
    * ``product_type`` / ``AFORO_PRODUCT_TYPE`` -- default ``"API"``.
    * ``exclude_paths``, ``exclude_status_codes``.

    Every event carries ``endpointPath``, ``httpMethod``, ``statusCode`` and
    ``responseTimeMs``. ``OPTIONS`` requests are never metered.
    """

    def __init__(self, app: Optional[Any] = None, **kwargs) -> None:
        self._client: Optional[AforoClient] = None
        self._kwargs = kwargs
        self._exclude_paths = kwargs.pop("exclude_paths", _DEFAULT_EXCLUDE)
        self._exclude_status_codes = kwargs.pop("exclude_status_codes", [])
        self._metric_name = kwargs.pop("metric_name", None)
        resolver = kwargs.pop("customer_resolver", None)
        legacy = kwargs.pop("customer_id", None)
        self._customer_resolver = resolver if resolver is not None else legacy
        self._trust_customer_header = kwargs.pop("trust_customer_header", None)
        self._product_type = kwargs.pop("product_type", None)
        self._customer = None
        if app is not None:
            self.init_app(app)

    @property
    def client(self) -> Optional[AforoClient]:
        return self._client

    def init_app(self, app: Any) -> None:
        resolver = self._customer_resolver
        if resolver is None:
            resolver = app.config.get("AFORO_CUSTOMER_RESOLVER", app.config.get("AFORO_CUSTOMER_ID"))
        trust = self._trust_customer_header
        if trust is None:
            trust = bool(app.config.get("AFORO_TRUST_CUSTOMER_HEADER", False))
        self._customer = customer_lookup(resolver, bool(trust), _header_customer,
                                         integration="aforo.middleware.flask.AforoMetering")
        api_key = self._kwargs.get("api_key", app.config.get("AFORO_API_KEY", ""))
        base_url = self._kwargs.get("base_url", app.config.get("AFORO_BASE_URL", "https://api.aforo.ai"))
        if self._metric_name is None:
            self._metric_name = app.config.get("AFORO_METRIC_NAME", DEFAULT_METRIC_NAME)
        self._product_type = resolve_product_type(
            self._product_type if self._product_type is not None
            else app.config.get("AFORO_PRODUCT_TYPE")
        )
        allow_http = self._kwargs.get("allow_insecure_http",
                                      bool(app.config.get("AFORO_ALLOW_INSECURE_HTTP", False)))
        compression = self._kwargs.get("compression", app.config.get("AFORO_COMPRESSION", "gzip"))
        self._client = AforoClient(
            api_key=api_key, base_url=base_url, product_type=self._product_type,
            allow_insecure_http=allow_http, compression=compression,
        )
        app.before_request(self._before_request)
        app.after_request(self._after_request)

    def _before_request(self) -> None:
        try:
            from flask import g

            g._aforo_start = time.monotonic()
        except Exception:
            logger.debug("aforo: could not record the request start time", exc_info=True)

    def _after_request(self, response: Any) -> Any:
        try:
            from flask import g, request

            path = request.path or "/"
            status_code = response.status_code

            if is_preflight(request.method):
                return response
            if any(path.startswith(p) for p in self._exclude_paths):
                return response
            if status_code in self._exclude_status_codes:
                return response
            if self._client is None or self._customer is None:
                return response

            customer_id = self._customer(request)
            if not customer_id:
                self._client.report_invalid(f"{NO_CUSTOMER}: {request.method} {path[:200]}")
                return response

            start = getattr(g, "_aforo_start", None)
            elapsed_ms = int((time.monotonic() - start) * 1000) if start is not None else None

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
