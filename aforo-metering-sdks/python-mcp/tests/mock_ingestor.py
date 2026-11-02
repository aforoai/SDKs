"""Starts the repo's fault-injecting mock ingestor (``mock-ingestor/``) for tests.

The mock is a zero-dependency Node script. Each test gets a fresh process on a
free port; faults are scripted over its control API. Tests are skipped when
``node`` is not on PATH.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "mock-ingestor" / "bin" / "mock-ingestor.mjs"
NODE = shutil.which("node")


class MockIngestor:
    def __init__(self, api_key: Optional[str] = None) -> None:
        if NODE is None:
            raise RuntimeError("node is not installed")
        args = [NODE, str(SCRIPT), "--port", "0"]
        if api_key:
            args += ["--api-key", api_key]
        self._proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.DEVNULL, text=True)
        line = self._proc.stdout.readline()
        info = json.loads(line)
        self.url: str = info["url"]
        self.port: int = info["port"]

    def _call(self, method: str, path: str, body: Any = None) -> Any:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.url + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read() or b"null")

    def faults(self, *faults: Dict[str, Any]) -> None:
        self._call("POST", "/__control/faults", {"faults": list(faults)})

    def clear_faults(self) -> None:
        self._call("DELETE", "/__control/faults")

    def state(self) -> Dict[str, Any]:
        return self._call("GET", "/__control/state")

    def ingest_requests(self) -> List[Dict[str, Any]]:
        return self.state()["requests"]

    def wait_for(self, predicate: Callable[[Dict[str, Any]], bool], timeout: float = 10.0) -> Dict[str, Any]:
        """Poll the mock's state until ``predicate(state)`` holds."""
        end = time.monotonic() + timeout
        last: Dict[str, Any] = {}
        while time.monotonic() < end:
            last = self.state()
            if predicate(last):
                return last
            time.sleep(0.02)
        raise AssertionError(f"condition not met within {timeout}s; last state: "
                             f"accepted={last.get('acceptedCount')} requests={len(last.get('requests', []))}")

    def close(self) -> None:
        if self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        for stream in (self._proc.stdin, self._proc.stdout):
            try:
                stream.close()
            except Exception:
                pass


def wait_until(predicate: Callable[[], bool], timeout: float = 10.0) -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(f"condition not met within {timeout}s")
