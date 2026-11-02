"""Base URL checks."""

from __future__ import annotations

from urllib.parse import urlsplit

from .policy import PLAIN_HTTP_HOSTS


def validate_base_url(base_url: str, allow_insecure_http: bool = False) -> str:
    """Return ``base_url`` without a trailing slash, or raise ValueError.

    ``https://`` is required. Plain ``http://`` is allowed for localhost,
    127.0.0.1 and ::1, or anywhere when ``allow_insecure_http`` is True: the API
    key travels in a header, and over plain HTTP anyone on the path can read it.
    """
    if not isinstance(base_url, str) or not base_url.strip():
        raise ValueError("base_url is required (for example https://api.aforo.ai)")
    url = base_url.strip().rstrip("/")
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
    except ValueError as exc:
        raise ValueError(f"base_url is not a valid URL: {url!r}") from exc
    if not host:
        raise ValueError(f"base_url has no host: {url!r}")
    if parts.username or parts.password:
        raise ValueError("base_url must not carry credentials; the API key goes in X-API-Key")
    scheme = parts.scheme.lower()
    if scheme == "https":
        return url
    if scheme == "http":
        if host in PLAIN_HTTP_HOSTS or allow_insecure_http:
            return url
        raise ValueError(
            f"base_url must use https:// (got {url!r}). Plain http:// is allowed only for "
            "localhost, 127.0.0.1 and ::1, or with allow_insecure_http=True."
        )
    raise ValueError(f"base_url must start with https:// (got {url!r})")
