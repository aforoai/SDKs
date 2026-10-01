"""
HTTP transport with 3× retry (exponential backoff).

Prefers :mod:`aiohttp`, falls back to :mod:`httpx`, else :mod:`urllib`
(run in a thread executor so the sync call doesn't block the loop).
Same posture as ``aforo_mcp_metering.client``'s ``_do_post_with_body``
so operators seeing failures in one SDK can reason about the other.

Retry policy:

* 2xx → success, return early.
* 4xx other than 408 / 429 → terminal ``rejected``, return early (payload
  is invalid; a retry would only produce another 400).
* 408 / 429 / 5xx / network error → retry with exponential backoff
  (1s, 2s); a 429 waits for its ``Retry-After`` (delta-seconds) when the
  server sends one. After ``max_retries`` attempts return
  ``retry_exhausted``.

A 2xx response can still report per-event rejections
(``{"failed": n, "errors": [{"index", "message"}]}``); see
:func:`parse_partial_failure`.

Callers (see :mod:`aforo_agent_metering.client`) map the ``PostResult``
to the drop-hook contract (``rejected`` | ``retry_exhausted`` |
``success``).
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

try:  # Preferred async client (matches python-mcp).
    import aiohttp

    HAS_AIOHTTP = True
except ImportError:  # pragma: no cover — env dependent.
    HAS_AIOHTTP = False

try:  # Fallback async client.
    import httpx

    HAS_HTTPX = True
except ImportError:  # pragma: no cover — env dependent.
    HAS_HTTPX = False

logger = logging.getLogger("aforo_agent_metering")

#: Async HTTP call signature: (url, headers, body) -> (status, body_text) or
#: (status, body_text, retry_after_header). The third element is optional so a
#: two-tuple transport keeps working; without it a 429 uses plain backoff.
PostFn = Callable[[str, Dict[str, str], str], Awaitable[Tuple[Any, ...]]]


def _unwrap_envelope(payload):
    """The ingestor wraps every 2xx JSON body in ``{success, data, meta}``.

    Returns the inner ``data`` object when present, else the payload unchanged
    (bare shape).
    """
    if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
        return payload["data"]
    return payload


def retry_after_seconds(value: Optional[str]) -> Optional[float]:
    """``Retry-After`` in seconds (delta-seconds form); ``None`` if absent or
    unparseable (an HTTP-date falls back to exponential backoff)."""
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return None


def error_messages(response_body: Optional[str]) -> List[str]:
    """``errors[].message`` values from an ingestor response, as ``[index] message``."""
    try:
        payload = _unwrap_envelope(json.loads(response_body) if response_body else None)
    except (TypeError, ValueError):
        return []
    if not isinstance(payload, dict) or not isinstance(payload.get("errors"), list):
        return []
    return [
        f"[{e.get('index')}] {e.get('message')}"
        for e in payload["errors"]
        if isinstance(e, dict)
    ]


def parse_partial_failure(
    response_body: Optional[str], count: int
) -> Optional[Tuple[int, Optional[List[int]]]]:
    """Per-event rejections reported in a 2xx batch response.

    Returns ``(failed, indices)`` when ``failed`` > 0 — ``indices`` lists the
    rejected batch positions when ``errors[].index`` accounts for every failed
    event, else ``None`` — or ``None`` when nothing was rejected.
    """
    try:
        payload = _unwrap_envelope(json.loads(response_body) if response_body else None)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    failed = payload.get("failed")
    if not isinstance(failed, int) or isinstance(failed, bool) or failed <= 0:
        return None
    failed = min(failed, count)
    indices: List[int] = []
    errors = payload.get("errors")
    if isinstance(errors, list):
        for e in errors:
            idx = e.get("index") if isinstance(e, dict) else None
            if (
                isinstance(idx, int)
                and not isinstance(idx, bool)
                and 0 <= idx < count
                and idx not in indices
            ):
                indices.append(idx)
    return failed, (sorted(indices) if len(indices) == failed else None)


@dataclass
class PostResult:
    """Outcome of a retry-wrapped POST."""

    status_code: int
    response_body: str
    #: One of ``"success"``, ``"rejected"``, ``"retry_exhausted"``. Callers
    #: use this to decide whether to invoke the on-drop hook and which
    #: reason string to hand it.
    reason: str
    attempts: int


async def _default_post(
    url: str, headers: Dict[str, str], body: str
) -> Tuple[int, str, Optional[str]]:
    """Best-available async HTTP POST. Returns
    (status_code, response_body, retry_after_header).

    aiohttp > httpx > urllib. urllib is sync so we push it to a thread so
    the surrounding asyncio loop isn't blocked while it does DNS + TCP.
    """
    if HAS_AIOHTTP:
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url, headers=headers, data=body, timeout=timeout
            ) as resp:
                resp_body = await resp.text()
                return resp.status, resp_body, resp.headers.get("Retry-After")
    if HAS_HTTPX:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(url, headers=headers, content=body)
            return resp.status_code, resp.text, resp.headers.get("Retry-After")
    # Last-resort urllib fallback — pushed to a thread so the loop keeps
    # running while the socket work happens.
    import urllib.error
    import urllib.request

    def _sync_post() -> Tuple[int, str, Optional[str]]:
        req = urllib.request.Request(
            url, data=body.encode(), headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.read().decode(), resp.headers.get("Retry-After")
        except urllib.error.HTTPError as e:
            # HTTPError IS a response — capture its status + body so 4xx
            # returns cleanly instead of propagating as a network error.
            retry_after = e.headers.get("Retry-After") if e.headers else None
            try:
                return e.code, e.read().decode(), retry_after
            except Exception:
                return e.code, "", retry_after

    # get_running_loop() (not get_event_loop()) — we're always inside an
    # async function here, and get_event_loop() emits a DeprecationWarning
    # on 3.10+ when no loop is running.
    return await asyncio.get_running_loop().run_in_executor(None, _sync_post)


async def post_batch_with_retry(
    url: str,
    headers: Dict[str, str],
    body: str,
    *,
    post_fn: Optional[PostFn] = None,
    sleep_fn: Optional[Callable[[float], Awaitable[None]]] = None,
    max_retries: int = 3,
) -> PostResult:
    """POST ``body`` to ``url`` with 3× retry (exponential backoff on
    transient failures).

    ``post_fn`` and ``sleep_fn`` are pluggable so tests can drive the
    retry loop deterministically without a real HTTP server or wall
    clock. Defaults use :func:`_default_post` and :func:`asyncio.sleep`.
    """
    post = post_fn or _default_post
    sleep = sleep_fn or asyncio.sleep

    last_status = 0
    last_body = ""
    last_error: Optional[Exception] = None

    for attempt in range(1, max_retries + 1):
        delay: float = 2 ** (attempt - 1)
        try:
            result = await post(url, headers, body)
            status, resp_body = result[0], result[1]
            retry_after = result[2] if len(result) > 2 else None
            last_status, last_body = status, resp_body
            if 200 <= status < 300:
                return PostResult(status, resp_body, "success", attempt)
            if 400 <= status < 500 and status not in (408, 429):
                # Terminal — payload is malformed; a retry can't fix it.
                return PostResult(status, resp_body, "rejected", attempt)
            if status == 429:
                wait = retry_after_seconds(retry_after)
                if wait is not None:
                    delay = wait
            # 408 / 429 / 5xx or unexpected code → retry.
            logger.warning(
                "[aforo-agent] attempt %d/%d failed: HTTP %d",
                attempt,
                max_retries,
                status,
            )
        except Exception as e:  # network / DNS / timeout
            last_error = e
            logger.warning(
                "[aforo-agent] attempt %d/%d failed: %s",
                attempt,
                max_retries,
                e,
            )

        if attempt < max_retries:
            await sleep(delay)

    # Exhausted all attempts — network error or persistent 5xx.
    return PostResult(
        status_code=last_status,
        response_body=last_body or (str(last_error) if last_error else ""),
        reason="retry_exhausted",
        attempts=max_retries,
    )
