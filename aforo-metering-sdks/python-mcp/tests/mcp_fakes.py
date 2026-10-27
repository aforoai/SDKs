"""Lets the older tests script the ingestor with an async ``fake_post(url,
headers, body)`` (the SDK's pre-2.0 HTTP seam): it is wired into the transport
core's HTTP client as an httpx transport. Retry jitter is set to 0."""

from __future__ import annotations

import asyncio

import httpx


def use_fake_post(billing, fake_post) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        headers = {k.decode(): v.decode() for k, v in request.headers.raw}
        try:
            result = asyncio.run(fake_post(str(request.url), headers, request.content.decode("utf-8")))
        except (OSError, ConnectionError) as exc:
            raise httpx.ConnectError(str(exc), request=request)
        status, body = result[0], result[1]
        extra = {"Retry-After": result[2]} if len(result) > 2 and result[2] is not None else {}
        return httpx.Response(status, content=(body or "").encode("utf-8"), headers=extra)

    core = billing._core
    old = core._http
    core._http = httpx.Client(transport=httpx.MockTransport(handle))
    core._rand = lambda: 0.0
    old.close()
