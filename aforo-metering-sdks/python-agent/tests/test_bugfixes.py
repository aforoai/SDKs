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
        ingestor_url="https://ingest.example.test",
        flush_interval_sec=3600.0,
        **{"default_customer_id": "cust_default", **overrides},
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
    assert reason == "invalid", (
        "an event that cannot be encoded never reaches the wire — reason 'invalid'"
    )
    assert len(events) == 1
    # The original event survives the drop path — the operator can
    # inspect / fix the metadata and re-submit under the SAME
    # idempotency key (dedup-safe replay).
    assert events[0]["metadata"]["cost_estimate"] == Decimal("0.42")
    assert events[0]["idempotencyKey"].startswith("agent:")
    # Wave 5 (TRANSPORT-SPEC "Unserializable event"): caught when the event is
    # recorded and reported through on_drop("invalid") only; on_error kinds
    # are about delivery (outage/auth/rejected/shutdown/closed).
    assert errors == []


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
    # Wave 5: rejected when recorded, so it never enters the queue at all.
    assert len(client) == 0, "bad event must not linger in the buffer"
    await client.flush()
    assert len(client) == 0


# ─────────────────────────── Bug 2 ───────────────────────────
# Wave 5: sending moved to one background thread (the transport core), so
# there is no fire-and-forget asyncio task left to leak an exception, and a
# record_* call made where no event loop runs is still sent (G292).


@pytest.mark.asyncio
async def test_failing_custom_transport_never_leaks_an_unretrieved_exception(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A post_fn that raises is a network failure for the sender thread:
    the event stays queued, nothing escapes into the application's loop."""
    from .mock_ingestor import wait_until

    calls: List[int] = []

    async def raising_post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        calls.append(1)
        raise RuntimeError("simulated transport bug")

    client = _client(flush_count=1, post_fn=raising_post, transport_options={"rand": lambda: 0.0})
    asyncio.get_running_loop().set_exception_handler(
        lambda loop, ctx: logging.getLogger("asyncio-test").warning("unhandled: %s", ctx.get("message"))
    )
    try:
        with caplog.at_level("WARNING"):
            client.record_capability(capability_name="x", agent_id="a")
            await asyncio.get_running_loop().run_in_executor(None, wait_until, lambda: len(calls) >= 4)
            for _ in range(5):
                await asyncio.sleep(0)
    finally:
        asyncio.get_running_loop().set_exception_handler(None)
    assert client.dropped_count == 0, "an outage keeps the event queued"
    assert not [r for r in caplog.records
                if "never retrieved" in r.getMessage() or "unhandled" in r.getMessage().lower()]
    client.shutdown_sync(timeout=0)


def test_record_without_a_running_loop_is_still_sent() -> None:
    """G292: no event loop, no manual flush() -- the sender thread delivers."""
    from .mock_ingestor import wait_until

    posted: List[str] = []

    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        posted.append(body)
        return 202, ""

    client = _client(flush_count=1, post_fn=post)
    client.record_capability(capability_name="x", agent_id="a")  # plain sync context
    wait_until(lambda: len(posted) == 1)
    assert len(client) == 0
    client.shutdown_sync()


def test_record_without_a_running_loop_leaks_no_coroutine_warning(
    recwarn: pytest.WarningsRecorder,
) -> None:
    """record_* never creates a coroutine, so nothing can be left un-awaited."""
    client = _client(flush_count=1)
    client.record_capability(capability_name="x", agent_id="a")
    client.shutdown_sync(timeout=0)

    import gc

    gc.collect()

    unawaited = [w for w in recwarn.list if "never awaited" in str(w.message)]
    assert not unawaited, f"coroutine leak: {[str(w.message) for w in unawaited]}"


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
