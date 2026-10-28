"""
Async decorator for capability handlers.

Times the handler, records the invocation on completion, and re-raises any
exception the handler surfaced. Status: returned → SUCCESS; raised a
timeout (``TimeoutError`` / ``asyncio.TimeoutError``) → TIMEOUT; raised
anything else → ERROR; cancelled or interrupted (``asyncio.CancelledError``,
``KeyboardInterrupt`` — anything that isn't an ``Exception``) → CANCELLED. Works with
FastAPI endpoints, LangChain tools, and any other async function whose
kwargs include the standard ``agent_id`` / ``session_id`` /
``customer_id`` trio.

Usage:
    from aforo_agent_metering import AforoAgentClient, wrap_capability_handler

    client = AforoAgentClient(...)

    @wrap_capability_handler(
        client,
        capability_name="summarize_email",
        customer_resolver=lambda args, kwargs: kwargs["user"].customer_id,
    )
    async def summarize(text: str, *, user, agent_id: str, session_id: str):
        ...

The customer: ``customer_resolver(args, kwargs)`` (identity your service
verified), or the client's ``default_customer_id``;
``trust_customer_header=True`` instead bills the call's ``customer_id`` kwarg,
which whoever calls the agent controls. With none of them, decorating raises
``ValueError``. A call with no customer still runs; its event is dropped as
``"invalid"``. The agent id comes from the ``agent_id`` kwarg; a call without
one is dropped as ``"invalid"`` too (there is no ``"unknown"`` agent).

If the wrapped handler doesn't accept a fixed ``capability_name``, pass
``capability_name=None`` and set it via a ``capability_name`` kwarg on
the call site — the decorator will read it out of ``kwargs``. A name read
that way that is longer than 64 characters is cut to 64 and the call is still
metered (one WARNING per process); a name given to the decorator is never
altered.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import logging
import time
from typing import Any, Awaitable, Callable, Dict, Optional, Tuple, TypeVar

from ._transport import clean_customer_id, require_customer_source
from .client import AforoAgentClient, truncate_capability_name

F = TypeVar("F", bound=Callable[..., Awaitable[Any]])

logger = logging.getLogger("aforo_agent_metering")


CustomerResolver = Callable[[Tuple[Any, ...], Dict[str, Any]], Optional[str]]


def wrap_capability_handler(
    client: AforoAgentClient,
    capability_name: Optional[str] = None,
    *,
    customer_resolver: Optional[CustomerResolver] = None,
    trust_customer_header: bool = False,
) -> Callable[[F], F]:
    """Decorator factory that meters an async capability handler.

    Args:
        client: The :class:`AforoAgentClient` that will receive the
            metering event.
        capability_name: The capability being handled. If ``None``, the
            decorator falls back to a ``capability_name`` kwarg on the
            wrapped call or to the wrapped function's ``__name__``.

    The wrapped handler MUST be an ``async def`` — sync handlers raise
    :class:`TypeError` at decoration time so a mismatch surfaces early
    instead of silently no-op'ing in production.
    """
    if customer_resolver is None and not trust_customer_header and client.default_customer_id:
        fixed = client.default_customer_id
        resolver: Optional[CustomerResolver] = lambda _args, _kwargs: fixed  # noqa: E731
    else:
        resolver = customer_resolver
    require_customer_source(resolver, trust_customer_header, integration="wrap_capability_handler",
                            untrusted_source="the call's customer_id keyword argument")

    def customer_for(args: Tuple[Any, ...], kwargs: Dict[str, Any]) -> Optional[str]:
        try:
            if resolver is not None:
                return clean_customer_id(resolver(args, kwargs))
            return clean_customer_id(kwargs.get("customer_id"))
        except Exception:
            logger.warning("[aforo-agent] customer_resolver raised; the call is not metered", exc_info=True)
            return None

    def decorator(handler: F) -> F:
        if not inspect.iscoroutinefunction(handler):
            raise TypeError(
                "wrap_capability_handler only supports async def handlers; "
                f"got {handler!r}"
            )

        @functools.wraps(handler)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            agent_id = kwargs.get("agent_id")
            session_id = kwargs.get("session_id")
            customer_id = customer_for(args, kwargs)
            # capability_name resolves: decorator arg > kwarg > handler name.
            # A name read from the call's kwargs arrives with the request, so
            # an over-long one is cut to the ingestor's limit and the call is
            # still metered. The decorator argument and the handler name are
            # the caller's own and are sent as given.
            cap = (
                capability_name
                or truncate_capability_name(kwargs.get("capability_name"))
                or handler.__name__
            )

            start = time.monotonic()
            status = "SUCCESS"
            try:
                return await handler(*args, **kwargs)
            except (TimeoutError, asyncio.TimeoutError):
                status = "TIMEOUT"
                raise
            except Exception:
                status = "ERROR"
                raise
            except BaseException:  # asyncio.CancelledError, KeyboardInterrupt, SystemExit
                status = "CANCELLED"
                raise
            finally:
                duration_ms = int((time.monotonic() - start) * 1000)
                # Best-effort — a metering bug must never break the
                # handler's return path (already ran + returned or
                # raised at this point).
                try:
                    client.record_capability(
                        capability_name=cap,
                        agent_id=agent_id,
                        customer_id=customer_id,
                        session_id=session_id,
                        execution_status=status,
                        execution_duration_ms=duration_ms,
                    )
                except Exception:
                    logger.debug(
                        "[aforo-agent] record_capability from decorator failed",
                        exc_info=True,
                    )

        return wrapper  # type: ignore[return-value]

    return decorator
