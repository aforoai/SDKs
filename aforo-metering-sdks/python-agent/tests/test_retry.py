"""Retry semantics of the agent client (wave 5: the shared transport core).

1 attempt + 3 retries on network errors, timeouts, 408, 429 and 5xx, with
full-jitter backoff; Retry-After honoured in both forms and capped at 60 s;
other 4xx are terminal. After the last retry the batch stays queued.
Waits go through an injected sleep, so nothing here waits on the clock.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from typing import Dict, List, Tuple

import pytest

from aforo_agent_metering import AforoAgentClient

NOW = 1_800_000_000.0


def _client(script, waits: List[float], rand: float = 0.0, **kw) -> Tuple[AforoAgentClient, List[int]]:
    calls: List[int] = []

    async def post(url: str, headers: Dict[str, str], body: str):
        calls.append(1)
        step = script.pop(0) if script else (202, "")
        if isinstance(step, BaseException):
            raise step
        return step

    client = AforoAgentClient(
        tenant_id="t", product_id="p", api_key="k", ingestor_url="https://ingest.example.test",
        default_customer_id="cust_1", flush_interval_sec=3600, post_fn=post,
        transport_options={"rand": lambda: rand, "sleep": waits.append, "wall_clock": lambda: NOW,
                           "breaker_initial": 3600, "breaker_max": 3600},
        **kw,
    )
    client.record_capability(capability_name="c", agent_id="a")
    return client, calls


def test_2xx_returns_success_after_one_attempt() -> None:
    waits: List[float] = []
    client, calls = _client([(202, "")], waits)
    assert client.flush_sync() == 0
    assert len(calls) == 1 and waits == []
    client.shutdown_sync()


def test_4xx_returns_rejected_no_retry() -> None:
    waits: List[float] = []
    client, calls = _client([(400, "bad")], waits)
    client.flush_sync()
    assert len(calls) == 1 and client.dropped_count == 1
    client.shutdown_sync()


def test_5xx_retries_three_times_then_keeps_the_batch() -> None:
    waits: List[float] = []
    client, calls = _client([(503, "")] * 4, waits)
    assert client.flush_sync() == 1
    assert len(calls) == 4 and client.dropped_count == 0
    client.shutdown_sync(timeout=0)


def test_network_error_is_retried() -> None:
    waits: List[float] = []
    client, calls = _client([OSError("refused"), (202, "")], waits)
    assert client.flush_sync() == 0
    assert len(calls) == 2
    client.shutdown_sync()


def test_408_is_retried() -> None:
    waits: List[float] = []
    client, calls = _client([(408, ""), (202, "")], waits)
    assert client.flush_sync() == 0 and len(calls) == 2
    client.shutdown_sync()


def test_backoff_is_full_jitter_from_the_injected_random() -> None:
    waits: List[float] = []
    client, _ = _client([(500, ""), (502, ""), (504, ""), (202, "")], waits, rand=0.5)
    client.flush_sync()
    assert waits == [0.25, 0.5, 1.0]  # 0.5 * min(30, 0.5 * 2**n)
    client.shutdown_sync()


def test_429_retry_after_delta_seconds() -> None:
    waits: List[float] = []
    client, calls = _client([(429, "", "7"), (202, "")], waits)
    client.flush_sync()
    assert waits == [7.0] and len(calls) == 2
    client.shutdown_sync()


def test_429_retry_after_http_date() -> None:
    waits: List[float] = []
    date = format_datetime(datetime.fromtimestamp(NOW, timezone.utc) + timedelta(seconds=9), usegmt=True)
    client, _ = _client([(429, "", date), (202, "")], waits)
    client.flush_sync()
    assert waits == [pytest.approx(9.0)]
    client.shutdown_sync()


def test_retry_after_is_capped_at_60_seconds() -> None:
    waits: List[float] = []
    client, _ = _client([(503, "", "86400"), (202, "")], waits)
    client.flush_sync()
    assert waits == [60.0]
    client.shutdown_sync()
