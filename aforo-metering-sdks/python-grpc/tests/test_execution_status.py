"""executionStatus on gRPC events (P6 item 15).

Checks the wire body: explicit values are trimmed + upper-cased, blank or
underivable values leave the key off, the gRPC status code is mapped with
the gateway-plugin table, and an explicit value beats the derived one.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List
from unittest import mock

import grpc
import pytest

from aforo_grpc_metering import client as mod
from aforo_grpc_metering import outcome_from_grpc_status
from aforo_grpc_metering.client import AforoGrpcBilling, AforoGrpcInterceptor


class _FakeHttp:
    def __init__(self) -> None:
        self.bodies: List[Dict[str, Any]] = []

    def urlopen(self, req, timeout=None):  # noqa: ARG002
        self.bodies.append(json.loads(req.data.decode("utf-8")))

        class _R:
            status = 202

            def __enter__(self_i):
                return self_i

            def __exit__(self_i, *_a):
                return False

        return _R()


@pytest.fixture
def http(monkeypatch):
    monkeypatch.setattr(mod, "HAS_HTTPX", False, raising=False)
    fake = _FakeHttp()
    with mock.patch("urllib.request.urlopen", side_effect=fake.urlopen):
        yield fake


def _billing() -> AforoGrpcBilling:
    return AforoGrpcBilling(
        tenant_id="tenant-001",
        product_id="prod-001",
        api_key="sk_test_abc",
        ingestor_url="https://api.aforo.ai",
        service_name="acme.v1.UserService",
        flush_count=1000,
        flush_interval_sec=60,
    )


def _wire_events(http: _FakeHttp) -> List[Dict[str, Any]]:
    return [e for body in http.bodies for e in body["events"]]


def _record(b: AforoGrpcBilling, status: Any = "OK", **kwargs: Any) -> None:
    b.record("GetUser", "UNARY", "cust_001", status, 1, 5, **kwargs)


# ── Mapping table ────────────────────────────────────────────────────────

EXPECTED = {
    grpc.StatusCode.OK: "SUCCESS",
    grpc.StatusCode.CANCELLED: "CANCELLED",
    grpc.StatusCode.UNKNOWN: "ERROR",
    grpc.StatusCode.INVALID_ARGUMENT: "VALIDATION_FAILED",
    grpc.StatusCode.DEADLINE_EXCEEDED: "TIMEOUT",
    grpc.StatusCode.NOT_FOUND: "ERROR",
    grpc.StatusCode.ALREADY_EXISTS: "ERROR",
    grpc.StatusCode.PERMISSION_DENIED: "BLOCKED",
    grpc.StatusCode.RESOURCE_EXHAUSTED: "BLOCKED",
    grpc.StatusCode.FAILED_PRECONDITION: "VALIDATION_FAILED",
    grpc.StatusCode.ABORTED: "ERROR",
    grpc.StatusCode.OUT_OF_RANGE: "VALIDATION_FAILED",
    grpc.StatusCode.UNIMPLEMENTED: "ERROR",
    grpc.StatusCode.INTERNAL: "ERROR",
    grpc.StatusCode.UNAVAILABLE: "ERROR",
    grpc.StatusCode.DATA_LOSS: "ERROR",
    grpc.StatusCode.UNAUTHENTICATED: "BLOCKED",
}


@pytest.mark.parametrize("code,outcome", list(EXPECTED.items()), ids=lambda v: getattr(v, "name", v))
def test_mapping_accepts_enum_int_and_name(code, outcome):
    assert outcome_from_grpc_status(code) == outcome
    assert outcome_from_grpc_status(code.value[0]) == outcome
    assert outcome_from_grpc_status(code.name) == outcome
    assert outcome_from_grpc_status(code.name.lower()) == outcome


def test_mapping_unknown_code_is_error_unrecognized_input_is_none():
    assert outcome_from_grpc_status(99) == "ERROR"
    assert outcome_from_grpc_status("99") == "ERROR"
    assert outcome_from_grpc_status("NOT_A_STATUS") is None
    assert outcome_from_grpc_status(None) is None
    assert outcome_from_grpc_status(True) is None


def test_mapping_covers_every_code_listed_in_the_sdk():
    assert set(EXPECTED) == set(grpc.StatusCode)


# ── Wire body ────────────────────────────────────────────────────────────


def test_explicit_status_trimmed_and_upper_cased(http):
    b = _billing()
    _record(b, execution_status=" partial ")
    b.shutdown()
    assert _wire_events(http)[0]["executionStatus"] == "PARTIAL"


def test_derived_from_status_label(http):
    b = _billing()
    _record(b, "OK")
    _record(b, "DEADLINE_EXCEEDED")
    _record(b, "INVALID_ARGUMENT")
    _record(b, "UNAUTHENTICATED")
    _record(b, "INTERNAL")
    _record(b, "cancelled")
    b.shutdown()
    assert [e["executionStatus"] for e in _wire_events(http)] == [
        "SUCCESS", "TIMEOUT", "VALIDATION_FAILED", "BLOCKED", "ERROR", "CANCELLED",
    ]


def test_explicit_beats_derived(http):
    b = _billing()
    _record(b, "INTERNAL", execution_status="hitl_required")
    b.shutdown()
    ev = _wire_events(http)[0]
    assert ev["executionStatus"] == "HITL_REQUIRED"
    assert ev["grpcStatusCode"] == "INTERNAL"  # the status label itself is unchanged


def test_blank_explicit_falls_back_to_derived(http):
    b = _billing()
    _record(b, "OK", execution_status="   ")
    b.shutdown()
    assert _wire_events(http)[0]["executionStatus"] == "SUCCESS"


def test_omitted_when_nothing_to_derive(http):
    b = _billing()
    _record(b, "SOMETHING_CUSTOM")
    _record(b, "SOMETHING_CUSTOM", execution_status="")
    b.shutdown()
    events = _wire_events(http)
    assert len(events) == 2
    assert all("executionStatus" not in e for e in events)


def test_execution_status_is_keyword_only():
    b = _billing()
    try:
        with pytest.raises(TypeError):
            b.record("GetUser", "UNARY", "cust_001", "OK", 1, 5, 0, "SUCCESS")  # type: ignore[misc]
        with pytest.raises(TypeError):
            AforoGrpcInterceptor(b, lambda ctx: "PARTIAL")  # type: ignore[misc]
    finally:
        b.shutdown()


# ── Interceptor resolver ─────────────────────────────────────────────────


class _Handler:
    unary_unary = staticmethod(lambda request, context: {"ok": True})
    request_deserializer = None
    response_serializer = None


class _CallDetails:
    method = "/acme.v1.UserService/GetUser"


class _Ctx:
    def invocation_metadata(self):
        return (("x-customer-id", "cust_001"),)


def _run_interceptor(http, resolver):
    b = _billing()
    interceptor = AforoGrpcInterceptor(b, execution_status_resolver=resolver)
    wrapped = interceptor.intercept_service(lambda _d: _Handler(), _CallDetails())
    wrapped.unary_unary({}, _Ctx())
    b.shutdown()
    return _wire_events(http)[0]


def test_interceptor_resolver_value_wins(http):
    ev = _run_interceptor(http, lambda ctx: " partial ")
    assert ev["executionStatus"] == "PARTIAL"
    assert ev["grpcStatusCode"] == "OK"


def test_interceptor_resolver_none_or_error_keeps_derived(http):
    assert _run_interceptor(http, lambda ctx: None)["executionStatus"] == "SUCCESS"

    def boom(_ctx):
        raise RuntimeError("resolver bug")

    http.bodies.clear()
    assert _run_interceptor(http, boom)["executionStatus"] == "SUCCESS"


def _contract_statuses():
    from pathlib import Path
    here = Path(__file__).resolve()
    fixture = json.loads((here.parents[2] / "contract" / "ingest-contract.json").read_text())
    endpoint = fixture["sdks"][here.parents[1].name]["endpoint"]
    spec = fixture["endpoints"][endpoint]["eventOptionalFields"]["executionStatus"]
    return spec["values"], spec["maxLength"]


def test_canonical_statuses_match_contract():
    values, max_len = _contract_statuses()
    assert mod.EXECUTION_STATUSES == frozenset(values)
    assert all(len(v) <= max_len for v in values)
    for v in values:
        assert mod.normalize_execution_status(v.lower()) == v


def test_unknown_explicit_status_is_omitted_and_event_still_sent(http, caplog):
    b = _billing()
    with caplog.at_level("WARNING", logger="aforo_grpc_metering"):
        # Unknown explicit value: left off, the derived status is used instead.
        _record(b, "NOT_FOUND", execution_status="bogus")
        # Unknown explicit value and nothing derivable: no status at all.
        _record(b, "NOT_A_CODE", execution_status="X" * 25)
    b.shutdown()
    events = _wire_events(http)
    assert len(events) == 2
    assert events[0]["executionStatus"] == "ERROR"
    assert "executionStatus" not in events[1]
    assert events[1]["customerId"] == "cust_001" and events[1]["grpcMethod"] == "GetUser"
    assert "Ignoring unknown executionStatus" in caplog.text


def test_context_status_label_is_defensive():
    from types import SimpleNamespace

    label = mod._context_status_label
    assert label(SimpleNamespace(code=lambda: grpc.StatusCode.PERMISSION_DENIED)) == "PERMISSION_DENIED"
    assert label(SimpleNamespace(code=lambda: None)) is None
    assert label(SimpleNamespace()) is None  # grpcio < 1.38: no code() getter

    def raises():
        raise NotImplementedError

    assert label(SimpleNamespace(code=raises)) is None
    assert label(mock.MagicMock()) is None  # not a grpc.StatusCode


def test_status_code_enum_is_sent_as_its_name(http):
    # A grpc.StatusCode isn't JSON-serializable; it used to fail the flush
    # and drop every event in the batch.
    grpc = pytest.importorskip("grpc")
    b = _billing()
    _record(b, grpc.StatusCode.PERMISSION_DENIED)
    _record(b, "OK")
    b.shutdown()
    events = _wire_events(http)
    assert [e["grpcStatusCode"] for e in events] == ["PERMISSION_DENIED", "OK"]
    assert [e["executionStatus"] for e in events] == ["BLOCKED", "SUCCESS"]
