"""productType option + batch response handling: every event carries a
top-level productType (client default, per-event override, trimmed and
upper-cased, unknown values passed through); 4xx other than 408/429 is not
retried, 429 honours Retry-After, and errors[].message from the batch
response reaches on_error."""

from __future__ import annotations

import io
import json
import urllib.error
from typing import List
from unittest import mock

import pytest

from aforo_grpc_metering import client as mod
from aforo_grpc_metering.client import AforoGrpcBilling


class _Http:
    """urlopen fake. Each response is (status, body_dict_or_None, headers)."""

    def __init__(self, responses=None):
        self.responses = list(responses or [])
        self.requests: List[dict] = []

    def urlopen(self, req, timeout=None):
        self.requests.append({
            "url": req.full_url,
            "headers": {k.lower(): v for k, v in req.header_items()},
            "body": json.loads(req.data.decode("utf-8")),
        })
        code, body, headers = self.responses.pop(0) if self.responses else (202, None, {})
        raw = json.dumps(body).encode("utf-8") if body is not None else b""
        if code >= 400:
            raise urllib.error.HTTPError(req.full_url, code, "err", headers, io.BytesIO(raw))

        class _R:
            status = code

            def __init__(self_i):
                self_i.headers = headers

            def __enter__(self_i): return self_i
            def __exit__(self_i, *_a): return False
            def read(self_i): return raw

        return _R()


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setattr(mod, "HAS_HTTPX", False, raising=False)
    sleeps: List[float] = []
    monkeypatch.setattr(mod.time, "sleep", lambda s: sleeps.append(s))
    h = _Http()
    errors: List[Exception] = []
    with mock.patch("urllib.request.urlopen", side_effect=h.urlopen):
        yield h, sleeps, errors


def _events(h):
    return [e for r in h.requests for e in r["body"]["events"]]


def test_default_product_type(env):
    h, _s, errors = env
    b = _make(errors)
    _emit(b)
    b.shutdown()
    assert [e["productType"] for e in _events(h)] == ['GRPC_API']
    assert errors == []


def test_client_product_type_and_per_event_override(env):
    h, _s, errors = env
    b = _make(errors, product_type="  agentic_api ")
    _emit(b)
    _emit(b, product_type=" api ")
    _emit(b, product_type="custom_thing")  # unknown values pass through, no hard failure
    _emit(b, product_type="   ")  # blank override falls back to the client value
    b.shutdown()
    assert [e["productType"] for e in _events(h)] == ["AGENTIC_API", "API", "CUSTOM_THING", "AGENTIC_API"]


def test_blank_client_product_type_uses_package_default(env):
    h, _s, errors = env
    b = _make(errors, product_type="")
    _emit(b)
    b.shutdown()
    assert _events(h)[0]["productType"] == 'GRPC_API'


@pytest.mark.parametrize("status", [400, 401, 403, 422])
def test_4xx_is_not_retried_and_reports_error_messages(env, status):
    h, sleeps, errors = env
    h.responses = [(status, {"accepted": 0, "failed": 1,
                             "errors": [{"index": 0, "message": "unknown metric"}]}, {})]
    b = _make(errors)
    _emit(b)
    b.shutdown()
    assert len(h.requests) == 1
    assert sleeps == []
    assert len(errors) == 1
    assert f"HTTP {status}" in str(errors[0])
    assert "unknown metric" in str(errors[0])


@pytest.mark.parametrize("status", [408, 500, 503])
def test_408_and_5xx_are_retried(env, status):
    h, _s, errors = env
    h.responses = [(status, None, {}), (202, {"accepted": 1, "failed": 0, "errors": []}, {})]
    b = _make(errors)
    _emit(b)
    b.shutdown()
    assert len(h.requests) == 2
    assert h.requests[0]["body"] == h.requests[1]["body"]
    assert errors == []


def test_429_honours_retry_after(env):
    h, sleeps, errors = env
    h.responses = [(429, None, {"Retry-After": "7"}), (202, None, {})]
    b = _make(errors)
    _emit(b)
    b.shutdown()
    assert len(h.requests) == 2
    assert sleeps == [7.0]
    assert errors == []


def test_exhausted_retries_report_once_without_trailing_sleep(env):
    h, sleeps, errors = env
    h.responses = [(503, None, {})] * 3
    b = _make(errors)
    _emit(b)
    b.shutdown()
    assert len(h.requests) == 3
    assert sleeps == [1.0, 2.0]
    assert len(errors) == 1 and "after 3 attempts" in str(errors[0])


def test_accepted_response_with_failed_events_reports_errors_message(env):
    h, _s, errors = env
    h.responses = [(202, {"accepted": 0, "duplicates": 0, "failed": 1,
                          "errors": [{"index": 0, "message": "customer not found"}]}, {})]
    b = _make(errors)
    _emit(b)
    b.shutdown()
    assert len(h.requests) == 1
    assert len(errors) == 1 and "customer not found" in str(errors[0])


def _make(errors, **kw):
    return AforoGrpcBilling(tenant_id="t", product_id="p", api_key="k",
                            ingestor_url="https://api.aforo.ai", service_name="acme.v1.Svc",
                            flush_count=10_000, flush_interval_sec=3600, on_error=errors.append, **kw)


def _emit(b, method="Get", **kw):
    b.record(method=method, call_type="UNARY", customer_id="c1", status="OK",
             message_count=1, duration_ms=1, **kw)


@pytest.mark.parametrize("method", ["", "   ", None])
def test_blank_grpc_method_is_dropped(env, method):
    h, _s, errors = env
    b = _make(errors)
    _emit(b, method=method)
    _emit(b)
    b.shutdown()
    events = _events(h)
    assert len(events) == 1
    assert events[0]["grpcService"] == "acme.v1.Svc" and events[0]["grpcMethod"] == "Get"
