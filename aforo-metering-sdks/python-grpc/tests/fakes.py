"""Deterministic clock / sleep / random and a scripted HTTP transport for core tests."""

from __future__ import annotations

import json
import threading
from typing import Any, Callable, Dict, List, Optional

import httpx
from gzip_body import request_bytes


class FakeClock:
    """Monotonic clock that only moves when the code under test sleeps."""

    def __init__(self, start: float = 1000.0) -> None:
        self.now = start
        self.sleeps: List[float] = []
        self._lock = threading.Lock()

    def __call__(self) -> float:
        with self._lock:
            return self.now

    def sleep(self, seconds: float) -> None:
        with self._lock:
            self.sleeps.append(seconds)
            self.now += seconds


class ScriptedServer:
    """httpx transport answering from a script: each entry is a status, a
    (status, headers) pair, an exception instance, or a callable(request) -> Response."""

    def __init__(self, script: Optional[List[Any]] = None, default: int = 202) -> None:
        self.script = list(script or [])
        self.default = default
        self.requests: List[Dict[str, Any]] = []
        self.threads: set = set()
        self._lock = threading.Lock()

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request_bytes(request).decode("utf-8"))
        with self._lock:
            self.requests.append({"headers": dict(request.headers), "body": body,
                                  "keys": [e.get("idempotencyKey") for e in body.get("events", [])]})
            self.threads.add(threading.current_thread().name)
            step = self.script.pop(0) if self.script else self.default
        if isinstance(step, BaseException):
            raise step
        if callable(step):
            return step(request)
        headers: Dict[str, str] = {}
        if isinstance(step, tuple):
            step, headers = step
        if 200 <= step < 300:
            n = len(body.get("events", []))
            return httpx.Response(step, json={"success": True, "data": {"accepted": n, "failed": 0, "errors": []}},
                                  headers=headers)
        return httpx.Response(step, json={"title": "err", "status": step}, headers=headers)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    @property
    def keys(self) -> List[str]:
        return [k for r in self.requests for k in r["keys"]]


def event(i: int, **extra: Any) -> Dict[str, Any]:
    e = {"customerId": f"c{i}", "metricName": "api_calls", "quantity": 1,
         "occurredAt": "2026-10-26T00:00:00Z", "idempotencyKey": f"k{i}"}
    e.update(extra)
    return e


def wait_until(predicate: Callable[[], bool], timeout: float = 5.0) -> None:
    import time

    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("condition not met in time")
