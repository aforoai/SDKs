"""Routes the transport core's HTTP through ``urllib.request.urlopen`` in tests.

Many tests in this suite script the ingestor by patching
``urllib.request.urlopen`` (the SDK used urllib before it moved to the shared
transport core). This bridge keeps them working: the core's httpx client gets
a transport that builds a real ``urllib.request.Request`` and hands it to
``urlopen`` -- patched in those tests, real in tests that run a local server.
Retry jitter is fixed at 0 so a retry does not wait, and the core's sleeps go
through the client module's ``time.sleep`` so tests can record them.

Tests marked ``@pytest.mark.real_transport`` (the mock-ingestor tests) use the
core's own httpx transport instead.
"""

from __future__ import annotations

import functools
import urllib.error
import urllib.request

import httpx
from gzip_body import plain_headers, request_bytes


def install(monkeypatch, client_module) -> None:
    core_cls = client_module.TransportCore

    def handle(request: httpx.Request) -> httpx.Response:
        req = urllib.request.Request(str(request.url), data=request_bytes(request),
                                     headers=plain_headers(request), method=request.method)
        try:
            resp = urllib.request.urlopen(req, timeout=10)
        except urllib.error.HTTPError as err:
            body = b""
            try:
                body = err.read() or b""
            except Exception:
                body = b""
            return httpx.Response(err.code, headers=dict(err.headers or {}), content=body)
        except urllib.error.URLError as err:
            raise httpx.ConnectError(str(err.reason), request=request)
        except OSError as err:
            raise httpx.ConnectError(str(err), request=request)
        status = getattr(resp, "status", None) or getattr(resp, "code", None) or 200
        headers = getattr(resp, "headers", None) or {}
        try:
            headers = {str(k): str(v) for k, v in dict(headers).items()}
        except Exception:
            headers = {}
        read = getattr(resp, "read", None)
        data = (read() if callable(read) else b"") or b""
        close = getattr(resp, "close", None)
        if callable(close):
            close()
        return httpx.Response(int(status), headers=headers, content=data)

    def sleep(seconds: float) -> None:
        client_module.time.sleep(seconds)

    def factory(*args, **kwargs):
        if kwargs.get("http_transport") is None:
            kwargs["http_transport"] = httpx.MockTransport(handle)
        kwargs.setdefault("rand", lambda: 0.0)
        kwargs.setdefault("sleep", sleep)
        kwargs.setdefault("register_atexit", False)
        return core_cls(*args, **kwargs)

    monkeypatch.setattr(client_module, "TransportCore", factory)
