"""FastAPI / Starlette ASGI middleware for automatic API usage metering."""

from __future__ import annotations

import time
from typing import Any, Callable, Optional

from ..client import AforoClient
from ..types import MiddlewareOptions
from ._common import (
    NO_CUSTOMER,
    customer_lookup,
    http_fields,
    is_billable_quantity,
    is_preflight,
    logger,
    resolve_metric_name,
    resolve_product_type,
)

_DEFAULT_EXCLUDE = ["/health", "/ready", "/metrics", "/favicon.ico", "/openapi.json", "/docs"]


class AforoMeteringMiddleware:
    """ASGI middleware that records one usage event after each response.

    Usage::

        from aforo.middleware.fastapi import AforoMeteringMiddleware

        def customer_from_session(scope):
            # Return the customer id from identity you have verified, e.g. the
            # user your auth middleware put on the scope.
            user = scope.get("user")
            return getattr(user, "customer_id", None)

        app.add_middleware(
            AforoMeteringMiddleware,
            api_key=os.environ["AFORO_API_KEY"],
            customer_resolver=customer_from_session,  # required
            metric_name="api_calls",
        )

    ``customer_resolver`` is required: ``callable(scope) -> str | None``. To
    read the ``X-Customer-Id`` header instead -- a value the caller of your API
    controls -- pass ``trust_customer_header=True``; do that only behind a
    gateway that sets the header itself. With neither, construction raises
    ``ValueError``. A request whose resolver returns nothing is not metered and
    is counted as an ``invalid`` drop; the request itself is never affected.

    ``metric_name`` defaults to ``"api_calls"`` and must name a metric in your
    Aforo catalog. ``OPTIONS`` preflights and requests whose ``quantity`` is
    <= 0 are not metered. Every event carries ``productType``, ``endpointPath``
    (path without query), ``httpMethod``, ``statusCode`` and ``responseTimeMs``.
    """

    def __init__(self, app: Any, api_key: Optional[str] = None, **kwargs) -> None:
        self.app = app
        opts = MiddlewareOptions(api_key=api_key or kwargs.get("api_key", ""), **{
            k: v for k, v in kwargs.items() if k != "api_key" and hasattr(MiddlewareOptions, k)
        })
        self._customer = customer_lookup(
            opts.customer_resolver if opts.customer_resolver is not None else opts.customer_id,
            opts.trust_customer_header, _extract_customer_id,
            integration="aforo.middleware.fastapi.AforoMeteringMiddleware",
        )
        self._product_type = resolve_product_type(opts.product_type)
        self._client = AforoClient(
            api_key=opts.api_key,
            base_url=opts.base_url,
            product_type=self._product_type,
            flush_count=opts.flush_count,
            flush_interval=opts.flush_interval,
            max_queue_size=opts.max_queue_size,
            allow_insecure_http=opts.allow_insecure_http,
        )
        self._exclude_paths = opts.exclude_paths or _DEFAULT_EXCLUDE
        self._exclude_status_codes = opts.exclude_status_codes
        self._metric_name_fn = opts.metric_name
        self._quantity_fn = opts.quantity
        self._metadata_fn = opts.metadata

    @property
    def client(self) -> AforoClient:
        """The middleware's client (for ``flush()`` / ``shutdown()`` / ``dropped_count``)."""
        return self._client

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

        # After the response: record the event (never affects the response).
        try:
            path = scope.get("path", "/")
            method = scope.get("method", "UNKNOWN")

            if is_preflight(method):
                return
            if any(path.startswith(p) for p in self._exclude_paths):
                return
            if status_code in self._exclude_status_codes:
                return

            metric_name = resolve_metric_name(self._metric_name_fn, scope)

            if callable(self._quantity_fn):
                quantity = self._quantity_fn(scope)
            elif self._quantity_fn is not None:
                quantity = float(self._quantity_fn)
            else:
                quantity = 1
            if not is_billable_quantity(quantity):
                return  # the ingestor rejects quantity <= 0

            customer_id = self._customer(scope)
            if not customer_id:
                self._client.report_invalid(f"{NO_CUSTOMER}: {method} {path[:200]}")
                return

            metadata = self._metadata_fn(scope) if self._metadata_fn else None

            self._client.track(
                customer_id=customer_id,
                metric_name=metric_name,
                quantity=quantity,
                metadata=metadata,
                product_type=self._product_type,
                extra_fields=http_fields(path, method, status_code, elapsed_ms),
            )
        except Exception:
            logger.debug("aforo: metering a request failed; the response was not affected", exc_info=True)


def _extract_customer_id(scope: dict) -> Optional[str]:
    """``X-Customer-Id`` from the ASGI headers (only with ``trust_customer_header``).

    The caller's ``X-Api-Key`` header is never used: that is the end user's
    secret, not a customer id.
    """
    for key, value in scope.get("headers", []) or []:
        k = key.decode("latin-1") if isinstance(key, bytes) else key
        if k.lower() == "x-customer-id":
            v = value.decode("latin-1") if isinstance(value, bytes) else value
            if v.strip():
                return v.strip()
    return None
