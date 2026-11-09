"""R5 against the repo's mock ingestor: a 429 whose X-RateLimit-Limit is below the
batch size splits the batch into parts of at most that size, in order, and
nothing is lost or sent twice. Also: a retryable partial failure on a gzip-sized
batch is re-sent with a body the server can decode (finding 2)."""

from __future__ import annotations

from aforo._transport import TransportCore

from .fakes import event


def _core(url, drops, **kw):
    params = dict(api_key="test-key", base_url=url, user_agent="aforo-python-test/0", name="it",
                  flush_interval=3600, retry_base=0.01, breaker_initial=0.05, breaker_max=0.2,
                  timeout=2.0, shutdown_timeout=2.0, register_atexit=False,
                  on_drop=lambda items, reason: drops.append((reason, [i["idempotencyKey"] for i in items])))
    params.update(kw)
    return TransportCore(**params)


def test_rate_limit_below_batch_size_splits_in_order(mock_ingestor):
    mock_ingestor.faults({"rateLimit": 2, "times": -1, "retryAfter": "0"})
    drops = []
    c = _core(mock_ingestor.url, drops)
    for i in range(5):
        c.enqueue(event(i))
    c.flush(10)
    state = mock_ingestor.state()
    c.close()
    assert [r["eventCount"] for r in state["requests"]] == [5, 2, 2, 1]
    assert [r["status"] for r in state["requests"]] == [429, 202, 202, 202]
    assert [e["idempotencyKey"] for e in state["events"]] == [f"k{i}" for i in range(5)]
    assert drops == []


def test_retryable_partial_failure_on_a_gzipped_batch_is_delivered(mock_ingestor):
    mock_ingestor.faults({"perEvent": [{"index": 0, "message": "busy", "retryable": True}]})
    drops = []
    c = _core(mock_ingestor.url, drops)
    for i in range(5):
        c.enqueue(event(i, metadata={"pad": "x" * 300}))
    c.flush(10)
    state = mock_ingestor.state()
    c.close()
    assert [r["status"] for r in state["requests"]] == [202, 202]
    assert sorted(e["idempotencyKey"] for e in state["events"]) == [f"k{i}" for i in range(5)]
    assert drops == []
