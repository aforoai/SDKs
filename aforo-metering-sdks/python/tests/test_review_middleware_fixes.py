"""Regression tests for the 2026-11-09 review: framework middlewares.

* exclude_paths match on path-segment boundaries (finding 8)
* FastAPI: /docs and /openapi.json excluded by default, [] excludes nothing,
  a handler that raises is metered as 500 (finding 9)
* Django: a mistyped dotted resolver path fails at start-up (finding 7)
* Flask: quantity, metadata, flush_count, flush_interval, max_queue_size (finding 12)
* a customer resolver that raises is counted as an invalid drop (R7)
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from aforo.middleware._common import is_excluded


def _tracked(client: MagicMock) -> list:
    return [call.kwargs for call in client.track.call_args_list]


@pytest.mark.parametrize("path,excluded", [
    ("/health", True), ("/health/db", True), ("/healthcare/patients", False),
    ("/metrics-api/report", False), ("/static/app.js", True), ("/static-maps/tile", False),
])
def test_exclusion_matches_on_segment_boundaries(path, excluded):
    assert is_excluded(path, ["/health", "/metrics", "/static/"]) is excluded


def test_exclusion_root_prefix_excludes_everything_and_empty_list_nothing():
    assert is_excluded("/anything", ["/"])
    assert not is_excluded("/health", [])
    assert not is_excluded("/health", None)


# ── FastAPI / Starlette ──────────────────────────────────────────────────

starlette = pytest.importorskip("starlette")


def _asgi(inner, **kwargs):
    from aforo.middleware.fastapi import AforoMeteringMiddleware

    kwargs.setdefault("customer_resolver", lambda scope: "cust_1")
    mw = AforoMeteringMiddleware(inner, api_key="k", **kwargs)
    mw._client.shutdown(timeout=0)
    mw._client = MagicMock()
    return mw


def _ok_app():
    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route

    async def endpoint(request):  # noqa: ANN001
        return PlainTextResponse("ok")

    async def boom(request):  # noqa: ANN001
        raise RuntimeError("handler bug")

    return Starlette(routes=[Route("/{path:path}", endpoint), Route("/boom", boom)][::-1])


def _get(mw, path):
    from starlette.testclient import TestClient

    return TestClient(mw, raise_server_exceptions=False).get(path)


def test_asgi_default_exclusions_include_docs_and_openapi():
    mw = _asgi(_ok_app())
    for path in ("/docs", "/openapi.json", "/health", "/healthcare/patients", "/metrics-api/report"):
        _get(mw, path)
    assert [t["extra_fields"]["endpointPath"] for t in _tracked(mw._client)] == [
        "/healthcare/patients", "/metrics-api/report"]


def test_asgi_empty_exclude_list_meters_everything():
    mw = _asgi(_ok_app(), exclude_paths=[])
    _get(mw, "/health")
    assert [t["extra_fields"]["endpointPath"] for t in _tracked(mw._client)] == ["/health"]


def test_asgi_handler_that_raises_is_metered_as_500_and_still_raises():
    mw = _asgi(_ok_app())
    assert _get(mw, "/boom").status_code == 500
    assert [t["extra_fields"]["statusCode"] for t in _tracked(mw._client)] == [500]


def test_asgi_app_that_raises_before_responding_is_metered_as_500():
    async def raw_app(scope, receive, send):
        raise RuntimeError("before any response")

    mw = _asgi(raw_app)
    with pytest.raises(RuntimeError):
        _get_raising(mw, "/v1/orders")
    assert [t["extra_fields"]["statusCode"] for t in _tracked(mw._client)] == [500]


def _get_raising(mw, path):
    from starlette.testclient import TestClient

    return TestClient(mw).get(path)


def test_asgi_resolver_that_raises_is_counted_invalid():
    def resolver(scope):
        raise KeyError("user")

    mw = _asgi(_ok_app(), customer_resolver=resolver)
    assert _get(mw, "/v1/orders").status_code == 200
    assert mw._client.track.call_count == 0
    assert mw._client.report_invalid.call_count == 1


# ── Flask ────────────────────────────────────────────────────────────────

flask = pytest.importorskip("flask")


def _flask(**kwargs):
    from aforo.middleware.flask import AforoMetering

    app = flask.Flask(__name__)

    @app.get("/<path:p>")
    def page(p):  # noqa: ANN001
        return "ok"

    kwargs.setdefault("customer_resolver", lambda request: "cust_1")
    ext = AforoMetering(app, api_key="k", **kwargs)
    return app, ext


def test_flask_honours_client_options_quantity_and_metadata():
    app, ext = _flask(flush_count=7, flush_interval=60, max_queue_size=50,
                      quantity=lambda request, response: 3, metadata={"plan": "pro"})
    assert ext.client._core.flush_count == 7
    assert ext.client._core.capacity == 50
    ext.client.shutdown(timeout=0)
    ext._client = MagicMock()
    app.test_client().get("/v1/orders")
    (call,) = _tracked(ext._client)
    assert call["quantity"] == 3 and call["metadata"] == {"plan": "pro"}


def test_flask_quantity_callable_with_one_argument_and_non_positive_quantity():
    app, ext = _flask(quantity=lambda request: 0)
    ext.client.shutdown(timeout=0)
    ext._client = MagicMock()
    app.test_client().get("/v1/orders")
    assert ext._client.track.call_count == 0


def test_flask_exclusion_uses_segment_boundaries():
    app, ext = _flask()
    ext.client.shutdown(timeout=0)
    ext._client = MagicMock()
    for path in ("/health", "/healthcare/x", "/static-maps/tile", "/static/a.js"):
        app.test_client().get(path)
    assert [t["extra_fields"]["endpointPath"] for t in _tracked(ext._client)] == [
        "/healthcare/x", "/static-maps/tile"]


def test_flask_resolver_that_raises_is_counted_invalid():
    def resolver(request):
        raise AttributeError("no user")

    app, ext = _flask(customer_resolver=resolver)
    ext.client.shutdown(timeout=0)
    ext._client = MagicMock()
    assert app.test_client().get("/v1/orders").status_code == 200
    assert ext._client.track.call_count == 0 and ext._client.report_invalid.call_count == 1


# ── Django ───────────────────────────────────────────────────────────────

django = pytest.importorskip("django")

_NAMES = ("AFORO_METRIC_NAME", "AFORO_CUSTOMER_ID", "AFORO_PRODUCT_TYPE", "AFORO_CUSTOMER_RESOLVER",
          "AFORO_TRUST_CUSTOMER_HEADER", "AFORO_EXCLUDE_PATHS")


@pytest.fixture
def django_settings():
    from django.conf import settings

    if not settings.configured:
        settings.configure(DEBUG=True, ALLOWED_HOSTS=["*"], USE_TZ=True, AFORO_API_KEY="k")
        django.setup()
    for name in _NAMES:
        if hasattr(settings, name):
            delattr(settings, name)
    yield settings
    for name in _NAMES:
        if hasattr(settings, name):
            delattr(settings, name)


def _django_mw():
    from django.http import HttpResponse
    from aforo.middleware.django import AforoMeteringMiddleware

    mw = AforoMeteringMiddleware(lambda request: HttpResponse("ok"))
    mw._client.shutdown(timeout=0)
    mw._client = MagicMock()
    return mw


@pytest.mark.parametrize("setting", ["AFORO_CUSTOMER_RESOLVER", "AFORO_CUSTOMER_ID"])
def test_django_mistyped_resolver_path_fails_at_start_up(django_settings, setting):
    setattr(django_settings, setting, "aforo.middleware.django.user_id_resolvr")
    with pytest.raises(ValueError, match="does not import"):
        _django_mw()


def test_django_plain_string_is_still_one_fixed_customer(django_settings):
    from django.test import RequestFactory

    django_settings.AFORO_CUSTOMER_ID = "cust_42"
    mw = _django_mw()
    mw(RequestFactory().get("/v1/orders"))
    assert [t["customer_id"] for t in _tracked(mw._client)] == ["cust_42"]


def test_django_exclusion_uses_segment_boundaries(django_settings):
    from django.test import RequestFactory

    django_settings.AFORO_CUSTOMER_ID = "cust_42"
    mw = _django_mw()
    for path in ("/admin/login", "/administrators", "/health"):
        mw(RequestFactory().get(path))
    assert [t["extra_fields"]["endpointPath"] for t in _tracked(mw._client)] == ["/administrators"]


def test_django_resolver_that_raises_is_counted_invalid(django_settings):
    from django.test import RequestFactory

    def resolver(request):
        raise RuntimeError("auth backend down")

    django_settings.AFORO_CUSTOMER_RESOLVER = resolver
    mw = _django_mw()
    assert mw(RequestFactory().get("/v1/orders")).status_code == 200
    assert mw._client.track.call_count == 0 and mw._client.report_invalid.call_count == 1
