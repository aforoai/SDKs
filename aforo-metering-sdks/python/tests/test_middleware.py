"""Tests for the Flask, Django and FastAPI middlewares.

Covers the rules the ingestor imposes on every event: a catalog metric name
(default ``api_calls``, not ``"METHOD /path"``), a real customer id (never the
caller's ``X-Api-Key`` secret), and no events for CORS preflights.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from aforo.middleware._common import (
    DEFAULT_METRIC_NAME,
    http_fields,
    is_billable_quantity,
    is_preflight,
    resolve_customer_id,
    resolve_metric_name,
    resolve_product_type,
)


def _tracked(client: MagicMock) -> list[dict]:
    return [c.kwargs for c in client.track.call_args_list]


_CORE = ("customer_id", "metric_name", "quantity")


def _core(client: MagicMock) -> list[dict]:
    """The customer/metric/quantity part of each track() call."""
    return [{k: kw[k] for k in _CORE if k in kw} for kw in _tracked(client)]


def _assert_http_fields(kwargs: dict, path: str, method: str, status: int = 200) -> None:
    fields = kwargs["extra_fields"]
    assert fields["endpointPath"] == path
    assert fields["httpMethod"] == method
    assert fields["statusCode"] == status
    assert isinstance(fields["responseTimeMs"], int) and fields["responseTimeMs"] >= 0


# ─── shared helpers ──────────────────────────────────────────────────────────

def test_common_helpers():
    assert DEFAULT_METRIC_NAME == "api_calls"
    assert resolve_metric_name(None) == "api_calls"
    assert resolve_metric_name("sms_sent") == "sms_sent"
    assert resolve_metric_name(lambda r: "otp", object()) == "otp"
    assert resolve_metric_name(lambda r: "", object()) == "api_calls"
    assert is_preflight("OPTIONS") and is_preflight("options")
    assert not is_preflight("GET") and not is_preflight(None)
    assert resolve_customer_id(None, object()) is None
    assert resolve_customer_id("  ", object()) is None
    assert resolve_customer_id(lambda r: 42, object()) == "42"
    assert resolve_product_type(None) == "API"
    assert resolve_product_type("  graphql_api ") == "GRAPHQL_API"
    assert resolve_product_type("custom") == "CUSTOM"
    assert http_fields("/a/b?x=1", "get", 201, 5) == {
        "endpointPath": "/a/b", "httpMethod": "GET", "statusCode": 201, "responseTimeMs": 5,
    }
    assert len(http_fields("/" + "p" * 600, "GET", 200, None)["endpointPath"]) == 512
    assert not is_billable_quantity(0) and not is_billable_quantity(-1)
    assert not is_billable_quantity(None) and is_billable_quantity(0.5)


# ─── Flask ───────────────────────────────────────────────────────────────────

flask = pytest.importorskip("flask")


def _flask_app(**kwargs):
    from aforo.middleware.flask import AforoMetering

    app = flask.Flask(__name__)

    @app.route("/users/<int:uid>", methods=["GET", "POST", "OPTIONS"])
    def user(uid):  # noqa: ANN001
        return "ok"

    ext = AforoMetering(app, api_key="k", **kwargs)
    ext._client = MagicMock()
    return app, ext._client


def test_flask_default_metric_and_customer_header():
    app, client = _flask_app()
    app.test_client().get("/users/7?page=2", headers={"X-Customer-Id": "cust_1"})
    assert _core(client) == [{"customer_id": "cust_1", "metric_name": "api_calls", "quantity": 1}]
    assert _tracked(client)[0]["product_type"] == "API"
    _assert_http_fields(_tracked(client)[0], "/users/7", "GET")


def test_flask_product_type_option_and_app_config():
    app, client = _flask_app(product_type=" agentic_api ")
    app.test_client().get("/users/7", headers={"X-Customer-Id": "c"})
    assert _tracked(client)[0]["product_type"] == "AGENTIC_API"

    from aforo.middleware.flask import AforoMetering

    app2 = flask.Flask(__name__)
    app2.config["AFORO_PRODUCT_TYPE"] = "GRAPHQL_API"
    app2.add_url_rule("/x", "x", lambda: "ok")
    ext = AforoMetering(app2, api_key="k")
    assert ext._client.product_type == "GRAPHQL_API"


def test_flask_never_uses_x_api_key_as_customer():
    app, client = _flask_app()
    app.test_client().get("/users/7", headers={"X-Api-Key": "secret"})
    client.track.assert_not_called()


def test_flask_skips_options_preflight():
    app, client = _flask_app()
    app.test_client().options(
        "/users/7", headers={"X-Customer-Id": "cust_1", "Access-Control-Request-Method": "POST"}
    )
    client.track.assert_not_called()


def test_flask_metric_and_customer_resolvers():
    app, client = _flask_app(
        metric_name=lambda req, resp: f"calls_{req.method.lower()}",
        customer_id=lambda req: req.headers.get("X-Tenant-Customer"),
    )
    app.test_client().post("/users/7", headers={"X-Tenant-Customer": "cust_9"})
    assert _tracked(client)[0]["metric_name"] == "calls_post"
    assert _tracked(client)[0]["customer_id"] == "cust_9"


def test_flask_fixed_metric_from_app_config():
    from aforo.middleware.flask import AforoMetering

    app = flask.Flask(__name__)
    app.config["AFORO_METRIC_NAME"] = "sms_sent"
    app.add_url_rule("/x", "x", lambda: "ok")
    ext = AforoMetering(app, api_key="k")
    ext._client = MagicMock()
    app.test_client().get("/x", headers={"X-Customer-Id": "c"})
    assert _tracked(ext._client)[0]["metric_name"] == "sms_sent"


# ─── Django ──────────────────────────────────────────────────────────────────

django = pytest.importorskip("django")


@pytest.fixture
def django_settings():
    from django.conf import settings

    if not settings.configured:
        settings.configure(DEBUG=True, ALLOWED_HOSTS=["*"], USE_TZ=True, AFORO_API_KEY="k")
        django.setup()
    for name in ("AFORO_METRIC_NAME", "AFORO_CUSTOMER_ID", "AFORO_PRODUCT_TYPE"):
        if hasattr(settings, name):
            delattr(settings, name)
    yield settings
    for name in ("AFORO_METRIC_NAME", "AFORO_CUSTOMER_ID", "AFORO_PRODUCT_TYPE"):
        if hasattr(settings, name):
            delattr(settings, name)


def _django_mw():
    from django.http import HttpResponse
    from aforo.middleware.django import AforoMeteringMiddleware

    mw = AforoMeteringMiddleware(lambda request: HttpResponse("ok"))
    mw._client = MagicMock()
    return mw


def test_django_default_metric_and_customer_header(django_settings):
    from django.test import RequestFactory

    mw = _django_mw()
    mw(RequestFactory().get("/users/7?q=1", HTTP_X_CUSTOMER_ID="cust_1"))
    assert _core(mw._client) == [{"customer_id": "cust_1", "metric_name": "api_calls", "quantity": 1}]
    assert _tracked(mw._client)[0]["product_type"] == "API"
    _assert_http_fields(_tracked(mw._client)[0], "/users/7", "GET")


def test_django_product_type_setting(django_settings):
    from django.test import RequestFactory

    django_settings.AFORO_PRODUCT_TYPE = "agentic_api"
    mw = _django_mw()
    mw(RequestFactory().post("/users/7", HTTP_X_CUSTOMER_ID="c"))
    assert _tracked(mw._client)[0]["product_type"] == "AGENTIC_API"
    _assert_http_fields(_tracked(mw._client)[0], "/users/7", "POST")


def test_django_never_uses_x_api_key_and_skips_options(django_settings):
    from django.test import RequestFactory

    mw = _django_mw()
    mw(RequestFactory().get("/users/7", HTTP_X_API_KEY="secret"))
    mw(RequestFactory().options("/users/7", HTTP_X_CUSTOMER_ID="cust_1"))
    mw._client.track.assert_not_called()


def test_django_settings_resolvers(django_settings):
    from django.test import RequestFactory

    django_settings.AFORO_METRIC_NAME = lambda request, response: "otp_delivered"
    django_settings.AFORO_CUSTOMER_ID = lambda request: "cust_resolved"
    mw = _django_mw()
    mw(RequestFactory().get("/users/7"))
    assert _core(mw._client) == [
        {"customer_id": "cust_resolved", "metric_name": "otp_delivered", "quantity": 1}
    ]


# ─── FastAPI / ASGI ──────────────────────────────────────────────────────────

pytest.importorskip("starlette")


def _asgi_app(**kwargs):
    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route
    from aforo.middleware.fastapi import AforoMeteringMiddleware

    async def endpoint(request):  # noqa: ANN001
        return PlainTextResponse("ok")

    inner = Starlette(routes=[Route("/users/{uid}", endpoint, methods=["GET", "OPTIONS"])])
    mw = AforoMeteringMiddleware(inner, api_key="k", **kwargs)
    mw._client = MagicMock()
    return mw


def test_asgi_default_metric_customer_and_exclusions():
    from starlette.testclient import TestClient

    mw = _asgi_app()
    tc = TestClient(mw)
    tc.get("/users/7", headers={"X-Customer-Id": "cust_1"})
    tc.get("/users/7", headers={"X-Api-Key": "secret"})
    tc.options("/users/7", headers={"X-Customer-Id": "cust_1"})
    calls = _tracked(mw._client)
    assert len(calls) == 1
    assert calls[0]["customer_id"] == "cust_1"
    assert calls[0]["metric_name"] == "api_calls"
    assert calls[0]["product_type"] == "API"
    _assert_http_fields(calls[0], "/users/7", "GET")


def test_asgi_product_type_option_and_skips_non_positive_quantity():
    from starlette.testclient import TestClient

    mw = _asgi_app(product_type="agentic_api", quantity=lambda scope: 0)
    TestClient(mw).get("/users/7", headers={"X-Customer-Id": "c"})
    mw._client.track.assert_not_called()

    mw = _asgi_app(product_type="agentic_api")
    TestClient(mw).get("/users/7?x=1", headers={"X-Customer-Id": "c"})
    assert _tracked(mw._client)[0]["product_type"] == "AGENTIC_API"
    _assert_http_fields(_tracked(mw._client)[0], "/users/7", "GET")


def test_asgi_metric_name_option():
    from starlette.testclient import TestClient

    mw = _asgi_app(metric_name="sms_sent")
    TestClient(mw).get("/users/7", headers={"X-Customer-Id": "c"})
    assert _tracked(mw._client)[0]["metric_name"] == "sms_sent"
