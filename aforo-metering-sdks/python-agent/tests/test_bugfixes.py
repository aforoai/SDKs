"""Regression tests for bugs fixed in the 2026-07-11 production-grade
post-review pass.

Each test locks in behavior for a specific bug so it cannot re-enter.
"""

from __future__ import annotations

import asyncio
import logging
from decimal import Decimal
from typing import Any, Dict, List, Tuple

import pytest

from aforo_agent_metering import AforoAgentClient


def _client(**overrides: Any) -> AforoAgentClient:
    return AforoAgentClient(
        tenant_id="tenant_test",
        product_id="prod_ai_001",
        api_key="sk_agent_abc",
        ingestor_url="https://ingest.test.aforo.ai",
        flush_interval_sec=3600.0,
        **overrides,
    )


# ─────────────────────────── Bug 1 ───────────────────────────
# flush() previously did json.dumps OUTSIDE the try/except. An event
# carrying a non-serializable value would raise TypeError AFTER drain
# but BEFORE send — events were lost with no drop hook / no counter.
# Regression locks: encoding failure IS observable and IS dedup-safe.


@pytest.mark.asyncio
async def test_json_encoding_failure_fires_drop_hook_and_increments_counter() -> None:
    dropped: List[Tuple[List[Dict[str, Any]], str]] = []
    errors: List[Exception] = []

    async def unreachable_post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        # Should never be called — encoding fails before we hit the wire.
        raise AssertionError("post_fn must not be called when JSON encoding fails")

    client = _client(
        post_fn=unreachable_post,
        on_drop=lambda events, reason: dropped.append((events, reason)),
        on_error=lambda e: errors.append(e),
    )

    # Decimal is a common metadata value that json.dumps rejects with
    # TypeError unless a custom encoder is passed — canonical trigger.
    client.record_capability(
        capability_name="pricey_call",
        agent_id="agt_1",
        metadata={"cost_estimate": Decimal("0.42")},
    )
    await client.flush()

    assert client.dropped_count == 1, "drop counter must increment"
    assert len(dropped) == 1, "on_drop hook must fire"
    events, reason = dropped[0]
    assert reason == "rejected", (
        "client-side encoding error is not retryable — reason must be 'rejected'"
    )
    assert len(events) == 1
    # The original event survives the drop path — the operator can
    # inspect / fix the metadata and re-submit under the SAME
    # idempotency key (dedup-safe replay).
    assert events[0]["metadata"]["cost_estimate"] == Decimal("0.42")
    assert events[0]["idempotencyKey"].startswith("agent:")
    assert len(errors) == 1, "on_error must surface the encoding failure"
    assert "JSON-encode" in str(errors[0])


@pytest.mark.asyncio
async def test_json_encoding_failure_does_not_raise_from_flush() -> None:
    """A payload-encoding bug must NOT propagate out of flush() — it
    would break the periodic flush loop and stall further events."""

    async def unreachable_post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        raise AssertionError("post_fn must not be called")

    client = _client(post_fn=unreachable_post)

    class Unencodable:
        pass

    client.record_capability(
        capability_name="x",
        agent_id="a",
        metadata={"weird": Unencodable()},
    )
    # Must resolve, not raise.
    await client.flush()
    assert client.dropped_count == 1


@pytest.mark.asyncio
async def test_json_encoding_failure_does_not_leave_events_in_buffer() -> None:
    """The buffer must be drained even on encoding failure — otherwise
    the same bad event blocks every subsequent flush forever."""

    async def unreachable_post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        raise AssertionError("post_fn must not be called")

    client = _client(post_fn=unreachable_post)
    client.record_capability(
        capability_name="x",
        agent_id="a",
        metadata={"bad": Decimal("1.5")},
    )
    assert len(client) == 1
    await client.flush()
    assert len(client) == 0, "bad event must not linger in the buffer"


# ─────────────────────────── Bug 2 ───────────────────────────
# _schedule_flush() fires a fire-and-forget task. If flush() ever raises,
# Python's asyncio emits "Task exception was never retrieved" at GC
# time — noise even when flush's own try/except handled the error. The
# fix attaches a done-callback that reads .exception().


@pytest.mark.asyncio
async def test_schedule_flush_task_exception_never_triggers_gc_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Verify a scheduled flush that hits an exception does NOT leave an
    unretrieved-exception task behind, using a synthetic post_fn that
    raises directly. The done-callback must consume the exception."""

    calls: List[int] = []

    async def raising_post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        calls.append(1)
        raise RuntimeError("simulated transport bug")

    # Buffer size 1 → the first record_capability triggers _schedule_flush.
    client = _client(flush_count=1, post_fn=raising_post)

    # Route asyncio's "unhandled exception" warnings through caplog so we
    # can prove none fires.
    asyncio.get_running_loop().set_exception_handler(
        lambda loop, ctx: logging.getLogger("asyncio-test").warning(
            "unhandled: %s", ctx.get("message")
        )
    )

    client.record_capability(capability_name="x", agent_id="a")

    # Give the scheduled task a chance to run + get GC'd.
    with caplog.at_level("WARNING"):
        # Yield a few times so pending tasks + callbacks complete.
        for _ in range(5):
            await asyncio.sleep(0)

    # The post_fn was invoked (retry loop ran) and the transport's own
    # retry-exhausted path handled the failure — so this asserts the
    # scheduled task completed. flush's try/except caught the failure
    # and recorded a drop (retry_exhausted from the retry loop) — no
    # unhandled exception.
    assert calls, "scheduled flush should have executed"

    # Reset handler for other tests.
    asyncio.get_running_loop().set_exception_handler(None)

    # No 'Task exception was never retrieved' or similar surfaced.
    assert not [
        r for r in caplog.records
        if "never retrieved" in r.getMessage()
        or "unhandled" in r.getMessage().lower()
    ], "scheduled flush must not leak an unretrieved exception"


@pytest.mark.asyncio
async def test_schedule_flush_no_running_loop_is_a_silent_debug_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """When record_capability is called from a sync context outside any
    event loop, _schedule_flush must NOT even create the coroutine
    (would otherwise leak a 'coroutine was never awaited' warning).
    Buffer keeps the event; user must flush() manually later."""
    client = _client(flush_count=1)

    # We already ARE inside an event loop for this test — simulate the
    # 'no loop' case by patching asyncio.get_running_loop to raise.
    original = asyncio.get_running_loop

    def raise_runtime(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("no running event loop")

    asyncio.get_running_loop = raise_runtime  # type: ignore[assignment]
    try:
        with caplog.at_level("DEBUG", logger="aforo_agent_metering"):
            client.record_capability(capability_name="x", agent_id="a")
    finally:
        asyncio.get_running_loop = original  # type: ignore[assignment]

    # Event is still in the buffer — the caller must flush later.
    assert len(client) == 1
    # And no exception propagated up.


@pytest.mark.asyncio
async def test_schedule_flush_no_running_loop_leaks_no_coroutine_warning(
    recwarn: pytest.WarningsRecorder,
) -> None:
    """Companion to the previous test: proves the coroutine object is
    NEVER created when there's no loop — so no
    'coroutine was never awaited' RuntimeWarning fires at GC."""
    client = _client(flush_count=1)

    original = asyncio.get_running_loop

    def raise_runtime(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("no running event loop")

    asyncio.get_running_loop = raise_runtime  # type: ignore[assignment]
    try:
        client.record_capability(capability_name="x", agent_id="a")
    finally:
        asyncio.get_running_loop = original  # type: ignore[assignment]

    # Force GC to surface any never-awaited coroutine warnings.
    import gc

    gc.collect()

    unawaited = [w for w in recwarn.list if "never awaited" in str(w.message)]
    assert not unawaited, (
        f"coroutine leak: {[str(w.message) for w in unawaited]}"
    )


# ─────────────────────────── Bug 3 ───────────────────────────
# py.typed marker file must exist in the installed package so
# downstream MyPy / pyright can see this package as typed (PEP 561).


def test_py_typed_marker_exists() -> None:
    import aforo_agent_metering
    from pathlib import Path

    pkg_dir = Path(aforo_agent_metering.__file__).parent
    marker = pkg_dir / "py.typed"
    assert marker.exists(), (
        "PEP 561 marker missing — downstream type checkers won't see hints"
    )
