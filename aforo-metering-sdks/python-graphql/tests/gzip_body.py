"""Request bodies as the ingestor reads them (wave 8, G269).

The transport core gzips batch bodies of 1 KiB or more and sets
Content-Encoding: gzip; usage-ingestor decodes them. Test fakes call these
helpers so they see the same JSON whatever the encoding.
"""

import gzip


def request_bytes(request) -> bytes:
    """The decoded body of an httpx.Request."""
    raw = request.content
    if request.headers.get("content-encoding", "").strip().lower() == "gzip":
        return gzip.decompress(raw)
    return raw


def plain_headers(request) -> dict:
    """The request headers without the transfer details of the encoded body."""
    return {k: v for k, v in request.headers.items() if k.lower() not in ("content-encoding", "content-length")}
