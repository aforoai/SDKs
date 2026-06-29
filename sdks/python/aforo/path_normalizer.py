"""URL path normalization — replaces dynamic segments with :id placeholders."""

from __future__ import annotations

import re
from typing import Optional

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)
_NUMERIC_RE = re.compile(r"^\d+$")
_MONGO_RE = re.compile(r"^[0-9a-f]{24}$", re.I)
_VERSION_RE = re.compile(r"^v\d+$", re.I)


def normalize_path(actual_path: str, route_template: Optional[str] = None) -> str:
    """Normalize a URL path by replacing dynamic segments with ``:id``.

    If *route_template* is provided (e.g. from the framework router),
    it is returned directly.
    """
    if route_template:
        return route_template

    segments = actual_path.split("/")
    normalized = []
    for seg in segments:
        if not seg:
            normalized.append(seg)
            continue
        if _VERSION_RE.match(seg):
            normalized.append(seg)
        elif _UUID_RE.match(seg) or _NUMERIC_RE.match(seg) or _MONGO_RE.match(seg):
            normalized.append(":id")
        elif (
            len(seg) > 4
            and len(seg) <= 12
            and re.match(r"^[a-zA-Z0-9_-]+$", seg)
            and re.search(r"\d", seg)
            and re.search(r"[a-zA-Z]", seg)
        ):
            normalized.append(":id")
        else:
            normalized.append(seg)

    return "/".join(normalized)
