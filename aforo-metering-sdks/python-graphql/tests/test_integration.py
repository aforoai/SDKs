"""
Real-server integration test for aforo-graphql-metering.

Where test_client.py mocks the request/response, this file:
  - builds a real graphql-core schema
  - wraps a minimal ASGI GraphQL handler with asgi_middleware(billing)
  - drives real HTTP round-trips through httpx.ASGITransport (no
    uvicorn server needed — httpx has first-class ASGI support that
    invokes the app through the full HTTP stack)
  - asserts the metering event reaches a real localhost HTTP capture
    server via billing's outbound flush

Catches what mock-based tests can't:
  - real ASGI scope/receive/send wiring with real body streams
  - real graphql-core AST complexity scoring on real documents
  - the middleware's status extraction works on real response.start
  - customer ID extraction from real ASGI header bytes

Self-contained — skipped when httpx or graphql-core isn't installed.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, List, Optional, Tuple

import pytest

from aforo_graphql_metering import AforoGraphQlBilling, asgi_middleware

try:
    import httpx  # type: ignore
    HAS_HTTPX = True
except ImportError:  # pragma: no cover
    HAS_HTTPX = False

try:
    import graphql as gql_core  # type: ignore
    HAS_GRAPHQL = True
except ImportError:  # pragma: no cover
    HAS_GRAPHQL = False


pytestmark = pytest.mark.skipif(
    not (HAS_HTTPX and HAS_GRAPHQL),
    reason="httpx and graphql-core are both required for the integration test",
)


# ── HTTP capture for the ingestor ─────────────────────────────────────

class _CaptureHandler(BaseHTTPRequestHandler):
    captured: List[Dict[str, Any]] = []

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else None
        except Exception:
            body = None
        type(self).captured.append(
            {"url": self.path, "body": body, "headers": dict(self.headers)}
        )
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_args: Any) -> None:
        pass


def _start_capture() -> Tuple[HTTPServer, threading.Thread, List[Dict[str, Any]]]:
    captured: List[Dict[str, Any]] = []

    class _Handler(_CaptureHandler):
        pass

    _Handler.captured = captured
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server, t, captured


# ── Minimal ASGI GraphQL server (real graphql-core execution) ─────────

def _build_schema() -> Any:
    return gql_core.build_schema(
        """
        type User { id: ID!, name: String! }
        type Query { user(id: ID!): User, ping: String }
        type Mutation { rename(id: ID!, name: String!): User }
        """
    )


# graphql-core's default_field_resolver calls callable(info, **args), so
# each resolver accepts `info` first, then the GraphQL arg names.
_ROOT_VALUE = {
    "user": lambda info, id: {"id": id, "name": f"user-{id}"},
    "ping": lambda info: "pong",
    "rename": lambda info, id, name: {"id": id, "name": name},
}


def _make_asgi_graphql_app(schema: Any) -> Any:
    """Minimal ASGI app that executes GraphQL POST bodies against the schema."""

    async def app(scope: Dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            raise NotImplementedError
        method = scope["method"]
        if method != "POST":
            await send({"type": "http.response.start", "status": 405, "headers": []})
            await send({"type": "http.response.body", "body": b""})
            return

        # Assemble body
        chunks: List[bytes] = []
        more = True
        while more:
            msg = await receive()
            if msg["type"] == "http.request":
                chunks.append(msg.get("body", b""))
                more = msg.get("more_body", False)
        body_raw = b"".join(chunks)
        try:
            body = json.loads(body_raw.decode("utf-8")) if body_raw else {}
        except json.JSONDecodeError:
            body = {}

        query = body.get("query", "")
        op_name = body.get("operationName")
        variables = body.get("variables") or {}

        # Real graphql-core execution
        try:
            doc = gql_core.parse(query)
            errors = gql_core.validate(schema, doc)
            if errors:
                result = {"data": None, "errors": [str(e) for e in errors]}
                status = 400
            else:
                exec_result = gql_core.execute(
                    schema,
                    doc,
                    root_value=_ROOT_VALUE,
                    operation_name=op_name,
                    variable_values=variables,
                )
                result = {}
                if exec_result.data is not None:
                    result["data"] = exec_result.data
                if exec_result.errors:
                    result["errors"] = [str(e) for e in exec_result.errors]
                status = 400 if exec_result.errors else 200
        except Exception as e:  # parse errors, etc.
            result = {"errors": [str(e)]}
            status = 400

        body_bytes = json.dumps(result).encode("utf-8")
        headers = [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body_bytes)).encode("ascii")),
        ]
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body_bytes})

    return app


# ── Fixtures ──────────────────────────────────────────────────────────

@pytest.fixture
def fixture():
    capture_server, capture_thread, captured = _start_capture()
    port = capture_server.server_address[1]

    billing = AforoGraphQlBilling(
        tenant_id="tenant-int-gql",
        product_id="prod-int-gql",
        api_key="sk_int_gql",
        ingestor_url=f"http://127.0.0.1:{port}",
        schema_version="v-test",
        flush_count=1,
        flush_interval_sec=60.0,
    )

    schema = _build_schema()
    app = _make_asgi_graphql_app(schema)
    wrapped_app = asgi_middleware(billing, path="/graphql")(app)

    yield {
        "billing": billing,
        "app": wrapped_app,
        "captured": captured,
    }

    billing.shutdown()
    capture_server.shutdown()
    capture_thread.join(timeout=2)


def _wait_for_events(captured: List[Dict[str, Any]],
                     predicate, timeout_sec: float = 2.0) -> List[Dict[str, Any]]:
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        events = [e for r in captured for e in (r.get("body") or {}).get("events", [])]
        if predicate(events):
            return events
        time.sleep(0.025)
    raise AssertionError(f"timed out; captured={captured!r}")


async def _post_graphql(app: Any, body: Dict[str, Any],
                        customer_id: Optional[str] = None) -> Dict[str, Any]:
    headers = {}
    if customer_id:
        headers["X-Customer-Id"] = customer_id
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        resp = await client.post("/graphql", json=body, headers=headers)
        return {"status": resp.status_code, "json": resp.json()}


# ── Tests ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_QUERY_against_real_schema_emits_event(fixture):
    result = await _post_graphql(
        fixture["app"],
        {"query": "query GetUser($id: ID!) { user(id: $id) { id name } }",
         "operationName": "GetUser", "variables": {"id": "u1"}},
        customer_id="cust_query_001",
    )
    assert result["status"] == 200
    assert result["json"]["data"]["user"] == {"id": "u1", "name": "user-u1"}

    events = _wait_for_events(fixture["captured"], lambda evs: len(evs) >= 1)
    ev = events[0]
    assert ev["productType"] == "GRAPHQL_API"
    assert ev["gqlOperationType"] == "QUERY"
    assert ev["gqlOperationName"] == "GetUser"
    assert ev["gqlComplexity"] > 0  # real AST scoring ran
    assert ev["gqlFieldCount"] > 0
    assert ev["gqlHasErrors"] is False
    assert ev["customerId"] == "cust_query_001"
    assert ev["metadata"]["schemaVersion"] == "v-test"


@pytest.mark.asyncio
async def test_MUTATION_classification(fixture):
    result = await _post_graphql(
        fixture["app"],
        {"query": "mutation Rename($id: ID!, $n: String!) { rename(id: $id, name: $n) { id name } }",
         "operationName": "Rename", "variables": {"id": "u1", "n": "updated"}},
        customer_id="cust_mut_001",
    )
    assert result["status"] == 200

    events = _wait_for_events(fixture["captured"], lambda evs: len(evs) >= 1)
    ev = events[0]
    assert ev["gqlOperationType"] == "MUTATION"
    assert ev["gqlOperationName"] == "Rename"
    assert ev["customerId"] == "cust_mut_001"


@pytest.mark.asyncio
async def test_no_customer_id_is_skipped(fixture):
    result = await _post_graphql(fixture["app"], {"query": "{ ping }"})
    assert result["status"] == 200

    time.sleep(0.2)
    fixture["billing"].shutdown()

    events = [e for r in fixture["captured"] for e in (r.get("body") or {}).get("events", [])]
    assert events == []


@pytest.mark.asyncio
async def test_schema_errors_are_flagged(fixture):
    result = await _post_graphql(
        fixture["app"],
        {"query": "{ thisFieldDoesNotExist }"},
        customer_id="cust_err_001",
    )
    assert result["status"] == 400

    events = _wait_for_events(fixture["captured"], lambda evs: len(evs) >= 1)
    ev = events[0]
    assert ev["gqlHasErrors"] is True
    assert ev["customerId"] == "cust_err_001"
