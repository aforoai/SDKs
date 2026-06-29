"""FastAPI / Starlette ASGI middleware for automatic API usage metering."""

from __future__ import annotations

import time
from typing import Any, Callable, Optional

from ..client import AforoClient
from ..path_normalizer import normalize_path
from ..types import MiddlewareOptions

_DEFAULT_EXCLUDE = ["/health", "/ready", "/metrics", "/favicon.ico", "/openapi.json", "/docs"]


class AforoMeteringMiddleware:
    """ASGI middleware that captures usage events after each response.

    Usage::

        from aforo.middleware.fastapi import AforoMeteringMiddleware
        app.add_middleware(AforoMeteringMiddleware, api_key=os.environ["AFORO_API_KEY"])
    """

    def __init__(self, app: Any, api_key: Optional[str] = None, **kwargs) -> None:
        self.app = app
        opts = MiddlewareOptions(api_key=api_key or kwargs.get("api_key", ""), **{
            k: v for k, v in kwargs.items() if k != "api_key" and hasattr(MiddlewareOptions, k)
        })
        self._client = AforoClient(
            api_key=opts.api_key,
            base_url=opts.base_url,
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

        async def send_wrapper(message: dict) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message.get("status", 200)
            await send(message)

        await self.app(scope, receive, send_wrapper)

        # After response — capture event
        try:
            path = scope.get("path", "/")
            method = scope.get("method", "UNKNOWN")
            headers = dict(scope.get("headers", []))

            if any(path.startswith(p) for p in self._exclude_paths):
                return
            if status_code in self._exclude_status_codes:
                return

            route_template = scope.get("path_params") and scope.get("route", {})
            normalized = normalize_path(path, getattr(route_template, "path", None) if route_template else None)

            # Resolve metric name
            if callable(self._metric_name_fn):
                metric_name = self._metric_name_fn(scope)
            elif isinstance(self._metric_name_fn, str):
                metric_name = self._metric_name_fn
            else:
                metric_name = f"{method} {normalized}"

            # Resolve quantity
            if callable(self._quantity_fn):
                quantity = self._quantity_fn(scope)
            elif self._quantity_fn is not None:
                quantity = float(self._quantity_fn)
            else:
                quantity = 1

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
            )
        except Exception:
            pass  # Never let metering affect the API


def _extract_customer_id(headers: dict) -> Optional[str]:
    """Extract customer ID from ASGI headers (bytes keys)."""
    for key, value in headers.items():
        k = key.decode("utf-8") if isinstance(key, bytes) else key
        v = value.decode("utf-8") if isinstance(value, bytes) else value
        if k.lower() == "x-customer-id":
            return v
        if k.lower() == "x-api-key":
            return v
    return None
