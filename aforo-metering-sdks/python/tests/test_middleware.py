"""Tests for the Flask, Django and FastAPI middlewares.

Covers the rules the ingestor imposes on every event: a catalog metric name
(default ``api_calls``, not ``"METHOD /path"``), a real customer id (never the
caller's ``X-Api-Key`` secret), and no events for CORS preflights. Wave 5
(G265): every middleware needs a customer resolver, or the explicit
``trust_customer_header`` opt-in to read ``X-Customer-Id``.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from aforo.middleware._common import (
    DEFAULT_METRIC_NAME,
    http_fields,
    is_billable_quantity,
    is_preflight,
    customer_lookup,
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
    header = lambda req: req.get("h")  # noqa: E731
    assert customer_lookup(lambda r: 42, False, header, integration="t")({}) == "42"
    assert customer_lookup(lambda r: "  ", False, header, integration="t")({}) is None
    assert customer_lookup("cust_fixed", False, header, integration="t")({}) == "cust_fixed"
    assert customer_lookup(None, True, header, integration="t")({"h": " c1 "}) == "c1"
    assert customer_lookup(lambda r: "from-resolver", True, header, integration="t")({"h": "x"}) == "from-resolver"
    with pytest.raises(ValueError, match="customer_resolver"):
        customer_lookup(None, False, header, integration="t")
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

    if "customer_resolver" not in kwargs and "customer_id" not in kwargs:
        kwargs.setdefault("trust_customer_header", True)
    ext = AforoMetering(app, api_key="k", **kwargs)
    ext._client.shutdown(timeout=0)
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
    app2.config["AFORO_TRUST_CUSTOMER_HEADER"] = True
    app2.add_url_rule("/x", "x", lambda: "ok")
    ext = AforoMetering(app2, api_key="k")
    assert ext._client.product_type == "GRAPHQL_API"
    ext._client.shutdown(timeout=0)


def test_flask_never_uses_x_api_key_as_customer():
    app, client = _flask_app()
    app.test_client().get("/users/7", headers={"X-Api-Key": "secret"})
    client.track.assert_not_called()
    client.report_invalid.assert_called_once()


def test_flask_without_resolver_or_trust_refuses_to_start():
    from aforo.middleware.flask import AforoMetering

    app = flask.Flask(__name__)
    with pytest.raises(ValueError, match="trust_customer_header"):
        AforoMetering(app, api_key="k")


def test_flask_header_is_ignored_when_a_resolver_is_set():
    app, client = _flask_app(customer_resolver=lambda req: None)
    app.test_client().get("/users/7", headers={"X-Customer-Id": "spoofed"})
    client.track.assert_not_called()
    client.report_invalid.assert_called_once()


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
    app.config["AFORO_CUSTOMER_RESOLVER"] = lambda req: req.headers.get("X-Customer-Id")
    app.add_url_rule("/x", "x", lambda: "ok")
    ext = AforoMetering(app, api_key="k")
    ext._client.shutdown(timeout=0)
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
    names = ("AFORO_METRIC_NAME", "AFORO_CUSTOMER_ID", "AFORO_PRODUCT_TYPE",
             "AFORO_CUSTOMER_RESOLVER", "AFORO_TRUST_CUSTOMER_HEADER")
    for name in names:
        if hasattr(settings, name):
            delattr(settings, name)
    settings.AFORO_TRUST_CUSTOMER_HEADER = True
    yield settings
    for name in names:
        if hasattr(settings, name):
            delattr(settings, name)


def _django_mw():
    from django.http import HttpResponse
    from aforo.middleware.django import AforoMeteringMiddleware

    mw = AforoMeteringMiddleware(lambda request: HttpResponse("ok"))
    mw._client.shutdown(timeout=0)
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


def test_django_without_resolver_or_trust_refuses_to_start(django_settings):
    from django.http import HttpResponse
    from aforo.middleware.django import AforoMeteringMiddleware

    del django_settings.AFORO_TRUST_CUSTOMER_HEADER
    with pytest.raises(ValueError, match="AFORO_CUSTOMER_RESOLVER"):
        AforoMeteringMiddleware(lambda request: HttpResponse("ok"))


def test_django_user_id_resolver_and_dotted_path(django_settings):
    from types import SimpleNamespace
    from django.test import RequestFactory

    from aforo.middleware.django import user_id_resolver

    del django_settings.AFORO_TRUST_CUSTOMER_HEADER
    django_settings.AFORO_CUSTOMER_RESOLVER = "aforo.middleware.django.user_id_resolver"
    mw = _django_mw()
    request = RequestFactory().get("/users/7", HTTP_X_CUSTOMER_ID="spoofed")
    request.user = SimpleNamespace(is_authenticated=True, id=55)
    mw(request)
    anonymous = RequestFactory().get("/users/7", HTTP_X_CUSTOMER_ID="spoofed")
    anonymous.user = SimpleNamespace(is_authenticated=False, id=None)
    mw(anonymous)
    assert [c["customer_id"] for c in _tracked(mw._client)] == ["55"]
    mw._client.report_invalid.assert_called_once()
    assert user_id_resolver(SimpleNamespace()) is None


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
    if "customer_resolver" not in kwargs and "customer_id" not in kwargs:
        kwargs.setdefault("trust_customer_header", True)
    mw = AforoMeteringMiddleware(inner, api_key="k", **kwargs)
    mw._client.shutdown(timeout=0)
    mw._client = MagicMock()
    return mw


def test_asgi_without_resolver_or_trust_refuses_to_start():
    from aforo.middleware.fastapi import AforoMeteringMiddleware

    with pytest.raises(ValueError, match="customer_resolver"):
        AforoMeteringMiddleware(object(), api_key="k")


def test_asgi_resolver_reads_the_scope_and_ignores_the_header():
    from starlette.testclient import TestClient

    mw = _asgi_app(customer_resolver=lambda scope: "cust_" + scope["path_params"].get("uid", "")
                   if "path_params" in scope else None)
    TestClient(mw).get("/users/7", headers={"X-Customer-Id": "spoofed"})
    calls = _tracked(mw._client)
    assert [c["customer_id"] for c in calls] == ["cust_7"]


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
