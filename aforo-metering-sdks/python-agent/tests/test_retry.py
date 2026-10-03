"""Retry semantics — the transport retries 5xx / network up to 3 times
with exponential backoff, and treats 4xx as terminal."""

from __future__ import annotations

from typing import Dict, List, Tuple

import pytest

from aforo_agent_metering.transport import PostResult, post_batch_with_retry


async def _immediate_sleep(_: float) -> None:
    return None


@pytest.mark.asyncio
async def test_2xx_returns_success_after_one_attempt() -> None:
    calls: List[int] = []

    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        calls.append(1)
        return 202, ""

    r = await post_batch_with_retry(
        "http://x/y", {}, "{}", post_fn=post, sleep_fn=_immediate_sleep
    )
    assert isinstance(r, PostResult)
    assert r.reason == "success"
    assert r.attempts == 1
    assert r.status_code == 202
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_4xx_returns_rejected_no_retry() -> None:
    calls: List[int] = []

    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        calls.append(1)
        return 400, "bad"

    r = await post_batch_with_retry(
        "http://x/y", {}, "{}", post_fn=post, sleep_fn=_immediate_sleep
    )
    assert r.reason == "rejected"
    assert r.attempts == 1
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_5xx_retries_three_times_then_exhausts() -> None:
    calls: List[int] = []

    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        calls.append(1)
        return 503, ""

    r = await post_batch_with_retry(
        "http://x/y", {}, "{}", post_fn=post, sleep_fn=_immediate_sleep
    )
    assert r.reason == "retry_exhausted"
    assert r.attempts == 3
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_network_error_retries_three_times_then_exhausts() -> None:
    calls: List[int] = []

    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        calls.append(1)
        raise OSError("network unreachable")

    r = await post_batch_with_retry(
        "http://x/y", {}, "{}", post_fn=post, sleep_fn=_immediate_sleep
    )
    assert r.reason == "retry_exhausted"
    assert r.attempts == 3
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_transient_5xx_then_2xx_returns_success() -> None:
    """The whole point of retries — a broker blip should NOT drop the batch."""
    counter = {"n": 0}

    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        counter["n"] += 1
        if counter["n"] == 1:
            return 503, ""
        return 202, ""

    r = await post_batch_with_retry(
        "http://x/y", {}, "{}", post_fn=post, sleep_fn=_immediate_sleep
    )
    assert r.reason == "success"
    assert r.attempts == 2


@pytest.mark.asyncio
async def test_backoff_delays_are_exponential() -> None:
    """1s, 2s between attempts 1→2 and 2→3 (no sleep after the final)."""
    delays: List[float] = []

    async def spy_sleep(d: float) -> None:
        delays.append(d)

    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        return 503, ""

    await post_batch_with_retry(
        "http://x/y", {}, "{}", post_fn=post, sleep_fn=spy_sleep
    )
    assert delays == [1.0, 2.0]  # after attempts 1 and 2 only


@pytest.mark.asyncio
async def test_max_retries_is_configurable() -> None:
    calls: List[int] = []

    async def post(url: str, headers: Dict[str, str], body: str) -> Tuple[int, str]:
        calls.append(1)
        return 503, ""

    r = await post_batch_with_retry(
        "http://x/y",
        {},
        "{}",
        post_fn=post,
        sleep_fn=_immediate_sleep,
        max_retries=5,
    )
    assert r.attempts == 5
    assert len(calls) == 5


@pytest.mark.asyncio
async def test_408_and_429_are_retried_and_429_honours_retry_after() -> None:
    responses = [(429, "", "7"), (408, ""), (429, "", "Wed, 21 Oct 2026 07:28:00 GMT"), (202, "")]
    delays: List[float] = []

    async def post(url: str, headers: Dict[str, str], body: str):
        return responses.pop(0)

    async def spy_sleep(seconds: float) -> None:
        delays.append(seconds)

    r = await post_batch_with_retry(
        "http://x/y", {}, "{}", post_fn=post, sleep_fn=spy_sleep, max_retries=4
    )
    assert r.reason == "success" and r.attempts == 4
    # Retry-After: 7 honoured; 408 and an HTTP-date Retry-After use backoff.
    assert delays == [7.0, 2, 4]


@pytest.mark.asyncio
async def test_429_until_exhausted_is_retry_exhausted_not_rejected() -> None:
    async def post(url: str, headers: Dict[str, str], body: str):
        return 429, "slow down"

    r = await post_batch_with_retry(
        "http://x/y", {}, "{}", post_fn=post, sleep_fn=_immediate_sleep
    )
    assert r.reason == "retry_exhausted" and r.attempts == 3
