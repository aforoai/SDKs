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

    @wrap_capability_handler(client, capability_name="summarize_email")
    async def summarize(text: str, *, agent_id: str, session_id: str, customer_id: str):
        ...

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
from typing import Any, Awaitable, Callable, Optional, TypeVar

from .client import AforoAgentClient, truncate_capability_name

F = TypeVar("F", bound=Callable[..., Awaitable[Any]])

logger = logging.getLogger("aforo_agent_metering")


def wrap_capability_handler(
    client: AforoAgentClient,
    capability_name: Optional[str] = None,
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

    def decorator(handler: F) -> F:
        if not inspect.iscoroutinefunction(handler):
            raise TypeError(
                "wrap_capability_handler only supports async def handlers; "
                f"got {handler!r}"
            )

        @functools.wraps(handler)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            agent_id = kwargs.get("agent_id", "unknown")
            session_id = kwargs.get("session_id")
            customer_id = kwargs.get("customer_id")
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
