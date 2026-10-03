"""executionStatus on GraphQL events (P6 item 15).

Checks the wire body: explicit values are trimmed + upper-cased and always
win, the GraphQL result decides SUCCESS / PARTIAL / ERROR, the HTTP status
is the fallback, and the key is left off when nothing applies.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
from unittest import mock

import pytest

from aforo_graphql_metering import client as mod
from aforo_graphql_metering import (
    AforoGraphQlBilling,
    asgi_middleware,
    outcome_from_graphql_result,
    outcome_from_http_status,
)


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


def _billing() -> AforoGraphQlBilling:
    return AforoGraphQlBilling(
        tenant_id="tenant-001",
        product_id="prod-gql-001",
        api_key="sk_gql_abc",
        ingestor_url="https://api.aforo.ai",
        flush_count=1000,
        flush_interval_sec=60,
    )


def _events(http: _FakeHttp) -> List[Dict[str, Any]]:
    return [e for body in http.bodies for e in body["events"]]


def _record(b: AforoGraphQlBilling, **kwargs: Any) -> None:
    b.record("cust_001", "query Q { ping }", "Q", 5, False, **kwargs)


# ── Helpers ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("result,expected", [
    ({"data": {"ping": "pong"}}, "SUCCESS"),
    ({"data": {"ping": "pong"}, "errors": []}, "SUCCESS"),
    ({"data": {"ping": None}, "errors": [{"message": "x"}]}, "PARTIAL"),
    ({"data": {}, "errors": [{"message": "x"}]}, "PARTIAL"),
    ({"data": None, "errors": [{"message": "x"}]}, "ERROR"),
    ({"errors": [{"message": "x"}]}, "VALIDATION_FAILED"),
    ({"errors": [{"message": "x"}], "extensions": {}}, "VALIDATION_FAILED"),
    ({"errors": None}, "SUCCESS"),
    (SimpleNamespace(data={"a": 1}, errors=None), "SUCCESS"),
    (SimpleNamespace(errors=["x"]), "VALIDATION_FAILED"),
    (SimpleNamespace(data={"a": 1}, errors=["x"]), "PARTIAL"),
    (SimpleNamespace(data=None, errors=["x"]), "ERROR"),
    # errors present = not None and not an empty list (non-list values count)
    ({"data": {"a": 1}, "errors": {}}, "PARTIAL"),
    ({"data": {"a": 1}, "errors": "boom"}, "PARTIAL"),
    ({"data": None, "errors": {"message": "x"}}, "ERROR"),
    ({"errors": "boom"}, "VALIDATION_FAILED"),
    ({"data": {"a": 1}, "errors": ()}, "PARTIAL"),
    (SimpleNamespace(data={"a": 1}, errors={}), "PARTIAL"),
    (SimpleNamespace(data={"a": 1}, errors=[]), "SUCCESS"),
    (None, None),
    ({"somethingElse": 1}, None),
    ([{"data": {}}], None),
    ("not a result", None),
    (object(), None),
])
def test_outcome_from_graphql_result(result, expected):
    assert outcome_from_graphql_result(result) == expected


@pytest.mark.parametrize("status,expected", [
    (200, "SUCCESS"), (204, "SUCCESS"), (302, "SUCCESS"),
    (408, "TIMEOUT"), (504, "TIMEOUT"),
    (499, "CANCELLED"),
    (400, "VALIDATION_FAILED"), (422, "VALIDATION_FAILED"),
    (401, "BLOCKED"), (403, "BLOCKED"), (429, "BLOCKED"),
    (404, "ERROR"), (409, "ERROR"), (500, "ERROR"), (502, "ERROR"), (503, "ERROR"),
    (100, None), (600, None), (None, None), (True, None), ("200", None),
])
def test_outcome_from_http_status(status, expected):
    assert outcome_from_http_status(status) == expected


def test_graphql_executionresult_is_supported():
    from graphql import ExecutionResult, GraphQLError

    assert outcome_from_graphql_result(ExecutionResult(data={"a": 1})) == "SUCCESS"
    assert outcome_from_graphql_result(ExecutionResult(data={"a": None}, errors=[GraphQLError("x")])) == "PARTIAL"
    # Field execution errors carry a path; data null -> ERROR.
    assert outcome_from_graphql_result(
        ExecutionResult(data=None, errors=[GraphQLError("x", path=["ping"])])
    ) == "ERROR"
    # Parse / validation errors carry no path and data is null: the request
    # never executed -> VALIDATION_FAILED (ExecutionResult always has .data).
    assert outcome_from_graphql_result(ExecutionResult(data=None, errors=[GraphQLError("x")])) == "VALIDATION_FAILED"
    # A mix (one error with a path) means execution ran.
    assert outcome_from_graphql_result(
        ExecutionResult(data=None, errors=[GraphQLError("x"), GraphQLError("y", path=["a"])])
    ) == "ERROR"
    # Dict responses keep the data-key rule: data null -> ERROR even without paths.
    assert outcome_from_graphql_result({"data": None, "errors": [{"message": "x"}]}) == "ERROR"


def test_graphql_errors_present():
    from aforo_graphql_metering.client import graphql_errors_present

    assert graphql_errors_present(None) is False
    assert graphql_errors_present([]) is False
    assert graphql_errors_present([{"message": "x"}]) is True
    assert graphql_errors_present({}) is True
    assert graphql_errors_present("boom") is True
    assert graphql_errors_present(()) is True


# ── record() wire body ───────────────────────────────────────────────────


def test_explicit_status_trimmed_and_upper_cased(http):
    b = _billing()
    _record(b, execution_status=" timeout ")
    b.shutdown()
    assert _events(http)[0]["executionStatus"] == "TIMEOUT"


def test_derived_from_result_then_http_status(http):
    b = _billing()
    _record(b, result={"data": {"ping": "pong"}})
    _record(b, result={"data": {"ping": None}, "errors": [{"message": "x"}]})
    _record(b, result={"data": None, "errors": [{"message": "x"}]}, http_status=400)
    _record(b, http_status=429)
    _record(b, result={"notGraphQL": True}, http_status=504)
    b.shutdown()
    assert [e["executionStatus"] for e in _events(http)] == [
        "SUCCESS", "PARTIAL", "ERROR", "BLOCKED", "TIMEOUT",
    ]


def test_explicit_beats_derived(http):
    b = _billing()
    _record(b, execution_status="hitl_required", result={"data": None, "errors": ["x"]}, http_status=500)
    b.shutdown()
    assert _events(http)[0]["executionStatus"] == "HITL_REQUIRED"


def test_unknown_explicit_status_is_omitted_and_event_still_sent(http, caplog):
    b = _billing()
    with caplog.at_level("WARNING", logger="aforo_graphql_metering"):
        _record(b, execution_status="bogus_status")
        _record(b, execution_status="X" * 25)
        # An invalid explicit status doesn't block the derived one.
        _record(b, execution_status="nope", result={"data": {"ping": "pong"}})
    b.shutdown()
    events = _events(http)
    assert len(events) == 3
    assert "executionStatus" not in events[0]
    assert "executionStatus" not in events[1]
    assert events[2]["executionStatus"] == "SUCCESS"
    assert events[0]["customerId"] == "cust_001" and events[0]["gqlOperationName"] == "Q"
    assert "Ignoring unknown executionStatus" in caplog.text


def test_blank_or_unset_is_omitted(http):
    b = _billing()
    _record(b)
    _record(b, execution_status="   ")
    _record(b, execution_status="", http_status=101)
    b.shutdown()
    events = _events(http)
    assert len(events) == 3
    assert all("executionStatus" not in e for e in events)


def test_has_errors_alone_does_not_derive_a_status(http):
    b = _billing()
    b.record("cust_001", "query Q { ping }", "Q", 5, True)
    b.shutdown()
    assert "executionStatus" not in _events(http)[0]


def test_outcome_inputs_are_keyword_only():
    b = _billing()
    try:
        with pytest.raises(TypeError):
            b.record("cust_001", "{ ping }", None, 5, False, 0, "SUCCESS")  # type: ignore[misc]
        with pytest.raises(TypeError):
            asgi_middleware(b, "/graphql")  # type: ignore[misc]
    finally:
        b.shutdown()


# ── ASGI middleware ──────────────────────────────────────────────────────


def _graphql_app(status: int, body: bytes, headers: Optional[List] = None):
    async def app(scope, receive, send):
        while True:
            msg = await receive()
            if not msg.get("more_body"):
                break
        await send({"type": "http.response.start", "status": status, "headers": headers or []})
        await send({"type": "http.response.body", "body": body})
    return app


def _call(app, query: str = "query Q { ping }") -> None:
    request_body = json.dumps({"query": query, "operationName": "Q"}).encode()
    sent: List[Dict[str, Any]] = []
    received = [False]

    async def receive():
        if received[0]:
            return {"type": "http.disconnect"}
        received[0] = True
        return {"type": "http.request", "body": request_body, "more_body": False}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http", "path": "/graphql", "method": "POST",
        "headers": [(b"x-customer-id", b"cust_001")],
    }
    asyncio.run(app(scope, receive, send))
    assert sent[-1]["type"] == "http.response.body"  # response still delivered


def _middleware_status(http, status: int, body: bytes, headers=None, **mw_kwargs) -> Optional[str]:
    b = _billing()
    app = asgi_middleware(b, path="/graphql", **mw_kwargs)(_graphql_app(status, body, headers))
    _call(app)
    b.shutdown()
    ev = _events(http)[-1]
    return ev.get("executionStatus")


def test_middleware_reads_result_body(http):
    assert _middleware_status(http, 200, b'{"data":{"ping":"pong"}}') == "SUCCESS"
    assert _middleware_status(http, 200, b'{"data":{"ping":null},"errors":[{"message":"x"}]}') == "PARTIAL"
    assert _middleware_status(http, 200, b'{"data":null,"errors":[{"message":"x"}]}') == "ERROR"
    # data key absent: failed before execution (parse / validation)
    assert _middleware_status(http, 200, b'{"errors":[{"message":"x"}]}') == "VALIDATION_FAILED"


def test_middleware_non_object_body_falls_back_to_http_status(http):
    # Batched queries return a JSON array: not a single result, use the HTTP status.
    assert _middleware_status(http, 200, b'[{"data":{"ping":"pong"}}]') == "SUCCESS"
    assert _middleware_status(http, 422, b'[{"errors":[{"message":"x"}]}]') == "VALIDATION_FAILED"
    # JSON object with neither key
    assert _middleware_status(http, 503, b'{"message":"down"}') == "ERROR"


def test_middleware_falls_back_to_http_status(http):
    # Not JSON
    assert _middleware_status(http, 429, b"slow down") == "BLOCKED"
    # Compressed body is not parsed
    assert _middleware_status(
        http, 504, b'{"data":{"ping":"pong"}}', headers=[(b"content-encoding", b"gzip")],
    ) == "TIMEOUT"
    # Over the 1 MiB cap
    big = b'{"data":{"ping":"' + b"x" * (1024 * 1024) + b'"}}'
    assert _middleware_status(http, 500, big) == "ERROR"


def test_middleware_resolver_wins_and_errors_are_ignored(http):
    assert _middleware_status(
        http, 200, b'{"data":{"ping":"pong"}}', execution_status_resolver=lambda scope: "partial",
    ) == "PARTIAL"

    def boom(_scope):
        raise RuntimeError("resolver bug")

    assert _middleware_status(
        http, 200, b'{"data":{"ping":"pong"}}', execution_status_resolver=boom,
    ) == "SUCCESS"


# ── Strawberry extension ─────────────────────────────────────────────────


def _run_strawberry_hooks(billing, result, resolver=None):
    """Drive the extension's on_operation hook directly with a fake execution
    context."""
    pytest.importorskip("strawberry")
    ext_cls = mod.strawberry_extension(billing, execution_status_resolver=resolver)
    ext = ext_cls.__new__(ext_cls)
    ext.execution_context = SimpleNamespace(
        context={"customer_id": "cust_001"},
        query="query Q { ping }",
        operation_name="Q",
        result=result,
    )
    hook = ext.on_operation()
    next(hook)
    with pytest.raises(StopIteration):
        next(hook)


def test_strawberry_extension_derives_from_result(http):
    from graphql import ExecutionResult, GraphQLError

    b = _billing()
    _run_strawberry_hooks(b, ExecutionResult(data={"ping": "pong"}))
    _run_strawberry_hooks(b, ExecutionResult(data={"ping": None}, errors=[GraphQLError("x")]))
    _run_strawberry_hooks(b, ExecutionResult(data=None, errors=[GraphQLError("x", path=["ping"])]))
    _run_strawberry_hooks(b, ExecutionResult(data=None, errors=[GraphQLError("x")]))
    _run_strawberry_hooks(b, None)
    _run_strawberry_hooks(b, ExecutionResult(data={"ping": "pong"}), resolver=lambda ctx: "pending")
    b.shutdown()
    assert [e.get("executionStatus") for e in _events(http)] == [
        "SUCCESS", "PARTIAL", "ERROR", "VALIDATION_FAILED", None, "PENDING",
    ]


def _strawberry_schema(billing):
    strawberry = pytest.importorskip("strawberry")

    @strawberry.type
    class Query:
        @strawberry.field
        def ping(self) -> str:
            return "pong"

        @strawberry.field
        def boom(self) -> str:
            raise ValueError("boom")

        @strawberry.field
        def maybe(self) -> Optional[str]:
            raise ValueError("maybe")

    return strawberry.Schema(query=Query, extensions=[mod.strawberry_extension(billing)])


_STRAWBERRY_CASES = [
    ("{ ping }", "SUCCESS", False),
    ("{ ping maybe }", "PARTIAL", True),
    ("{ boom }", "ERROR", True),
    ("{ nope }", "VALIDATION_FAILED", True),
]
# (A query that doesn't parse is not recorded at all: record() needs the
# parsed operation for the complexity score.)


def test_strawberry_real_schema_sync(http):
    # Real Strawberry calls on_operation; the removed on_request_* hooks never fire.
    b = _billing()
    schema = _strawberry_schema(b)
    for query, _, _ in _STRAWBERRY_CASES:
        schema.execute_sync(query, context_value={"customer_id": "cust_sb"})
    b.shutdown()
    events = _events(http)
    assert [e.get("executionStatus") for e in events] == [c[1] for c in _STRAWBERRY_CASES]
    assert [e["gqlHasErrors"] for e in events] == [c[2] for c in _STRAWBERRY_CASES]
    assert all(e["customerId"] == "cust_sb" for e in events)
    assert all(e["executionDurationMs"] >= 0 for e in events)


def test_strawberry_real_schema_async(http):
    b = _billing()
    schema = _strawberry_schema(b)

    async def run():
        for query, _, _ in _STRAWBERRY_CASES:
            await schema.execute(query, context_value={"customer_id": "cust_sb"})

    asyncio.run(run())
    b.shutdown()
    assert [e.get("executionStatus") for e in _events(http)] == [c[1] for c in _STRAWBERRY_CASES]


def test_strawberry_real_schema_without_customer_records_nothing(http):
    b = _billing()
    _strawberry_schema(b).execute_sync("{ ping }", context_value={})
    b.shutdown()
    assert _events(http) == []


def test_strawberry_object_context_reads_the_header(http):
    # Strawberry's ASGI/Starlette integrations pass an object context with a
    # .request; the default extractor used to skip it (precedence bug), so
    # every such event went out with no customer and was dropped.
    from types import SimpleNamespace
    b = _billing()
    ctx = SimpleNamespace(request=SimpleNamespace(headers={"x-customer-id": "cust_hdr"}))
    _strawberry_schema(b).execute_sync("{ ping }", context_value=ctx)
    b.shutdown()
    assert [e["customerId"] for e in _events(http)] == ["cust_hdr"]


def test_default_extractor_handles_dict_and_object_contexts():
    from types import SimpleNamespace
    ex = mod._default_customer_extractor
    hdrs = SimpleNamespace(headers={"x-customer-id": "c1"})
    assert ex(SimpleNamespace(request=hdrs)) == "c1"
    assert ex({"request": hdrs}) == "c1"
    assert ex({"customer_id": "c2"}) == "c2"
    assert ex(SimpleNamespace()) is None
    assert ex(None) is None


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
