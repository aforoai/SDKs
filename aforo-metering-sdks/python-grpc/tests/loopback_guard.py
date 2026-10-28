"""Keeps every test in this suite on the local machine.

The SDK sends from a background thread and flushes at interpreter exit, so a
client a test forgot to shut down could otherwise reach a real host (older
tests use api.aforo.ai as a placeholder URL). Name resolution is limited to
loopback for the whole test process, including atexit.
"""

import socket

_LOOPBACK = {"localhost", "127.0.0.1", "::1", "0.0.0.0", "ip6-localhost"}
_real_getaddrinfo = socket.getaddrinfo


def _loopback_only(host, *args, **kwargs):
    name = host.decode() if isinstance(host, bytes) else host
    if name is not None and name not in _LOOPBACK and not str(name).startswith("127."):
        raise socket.gaierror(socket.EAI_NONAME, f"tests may not resolve {name!r} (loopback only)")
    return _real_getaddrinfo(host, *args, **kwargs)


def install() -> None:
    socket.getaddrinfo = _loopback_only
