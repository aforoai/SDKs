"""FastAPI / Starlette ASGI middleware for automatic API usage metering."""

from __future__ import annotations

import time
from typing import Any, Callable, Optional

from ..client import AforoClient
from ..types import MiddlewareOptions
from ._common import (
    http_fields,
    is_billable_quantity,
    is_preflight,
    resolve_metric_name,
    resolve_product_type,
)

_DEFAULT_EXCLUDE = ["/health", "/ready", "/metrics", "/favicon.ico", "/openapi.json", "/docs"]


class AforoMeteringMiddleware:
    """ASGI middleware that captures usage events after each response.

    Usage::

        from aforo.middleware.fastapi import AforoMeteringMiddleware
        app.add_middleware(
            AforoMeteringMiddleware,
            api_key=os.environ["AFORO_API_KEY"],
            metric_name="api_calls",   # or a callable(scope) -> str
            customer_id=lambda scope: ...,  # callable(scope) -> str | None
            product_type="API",        # top-level productType, default "API"
        )

    ``metric_name`` defaults to ``"api_calls"`` and must name a metric in your
    Aforo catalog: the ingestor rejects unknown metrics, and one rejected event
    fails the whole batch. ``customer_id`` defaults to the ``X-Customer-Id``
    header; the caller's ``X-Api-Key`` is never used (it is a secret, not an
    id). Requests with no customer, and ``OPTIONS`` preflights, are not metered;
    nor are requests whose ``quantity`` resolves to <= 0. Every event carries
    top-level ``productType`` plus ``endpointPath`` (path without query),
    ``httpMethod``, ``statusCode`` and ``responseTimeMs``.
    """

    def __init__(self, app: Any, api_key: Optional[str] = None, **kwargs) -> None:
        self.app = app
        opts = MiddlewareOptions(api_key=api_key or kwargs.get("api_key", ""), **{
            k: v for k, v in kwargs.items() if k != "api_key" and hasattr(MiddlewareOptions, k)
        })
        self._product_type = resolve_product_type(opts.product_type)
        self._client = AforoClient(
            api_key=opts.api_key,
            base_url=opts.base_url,
            product_type=self._product_type,
            flush_count=opts.flush_count,
            flush_interval=opts.flush_interval,
            max_queue_size=opts.max_queue_size,
        )
        self._exclude_paths = opts.exclude_paths or _DEFAULT_EXCLUDE
        self._exclude_status_codes = opts.exclude_status_codes
        self._metric_name_fn = opts.metric_name
        self._quantity_fn = opts.quantity
        self._customer_id_fn = opts.customer_id
        self._metadata_fn = opts.metadata

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        status_code = 200
        start = time.monotonic()

        async def send_wrapper(message: dict) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message.get("status", 200)
            await send(message)

        await self.app(scope, receive, send_wrapper)
        elapsed_ms = int((time.monotonic() - start) * 1000)

        # After response — capture event
        try:
            path = scope.get("path", "/")
            method = scope.get("method", "UNKNOWN")
            headers = dict(scope.get("headers", []))

            if is_preflight(method):
                return
            if any(path.startswith(p) for p in self._exclude_paths):
                return
            if status_code in self._exclude_status_codes:
                return

            # Resolve metric name (must be a metric in the tenant's catalog)
            metric_name = resolve_metric_name(self._metric_name_fn, scope)

            # Resolve quantity
            if callable(self._quantity_fn):
                quantity = self._quantity_fn(scope)
            elif self._quantity_fn is not None:
                quantity = float(self._quantity_fn)
            else:
                quantity = 1
            if not is_billable_quantity(quantity):
                return  # the ingestor rejects quantity <= 0 (and the whole batch)

            # Resolve customer ID
            if callable(self._customer_id_fn):
                customer_id = self._customer_id_fn(scope)
            elif isinstance(self._customer_id_fn, str):
                customer_id = self._customer_id_fn
            else:
                customer_id = _extract_customer_id(headers)

            if not customer_id:
                return

            metadata = None
            if self._metadata_fn:
                metadata = self._metadata_fn(scope)

            self._client.track(
                customer_id=customer_id,
                metric_name=metric_name,
                quantity=quantity,
                metadata=metadata,
                product_type=self._product_type,
                extra_fields=http_fields(path, method, status_code, elapsed_ms),
            )
        except Exception:
            pass  # Never let metering affect the API


def _extract_customer_id(headers: dict) -> Optional[str]:
    """Extract the customer ID from the ``X-Customer-Id`` ASGI header.

    The caller's ``X-Api-Key`` header is deliberately NOT used: that is the end
    user's secret, and using it as customerId wrote credentials into billing
    data while never matching an Aforo customer.
    """
    for key, value in headers.items():
        k = key.decode("utf-8") if isinstance(key, bytes) else key
        v = value.decode("utf-8") if isinstance(value, bytes) else value
        if k.lower() == "x-customer-id" and v.strip():
            return v.strip()
    return None
