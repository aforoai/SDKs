"""The transport core: one bounded queue and one flusher thread per client.

Implements ``contract/TRANSPORT-SPEC.md``. In short:

* ``enqueue()`` never starts a thread or sends. It serializes the event (an
  event that cannot be turned into JSON is dropped as ``"invalid"`` there and
  then), appends it to a bounded FIFO queue (overflow evicts the oldest event,
  reported as ``"overflow"``) and, at the flush threshold, wakes the flusher.
* One long-lived daemon thread sends batches: every ``flush_interval`` seconds,
  when the queue reaches ``flush_count``, or when ``flush()`` asks it to.
* Every request has a total deadline that also covers reading the response
  body, so a server that stalls or drips its answer is cut off on time.
* Retries use full jitter; ``Retry-After`` is read in both forms and capped.
  No lock that ``enqueue()`` needs is held while sleeping or sending.
* After the last retry (or on 401/403, or a redirect) the batch goes back to
  the front of the queue with the same idempotency keys and the flusher pauses
  (breaker). An explicit ``flush()`` makes one attempt even while it is open.
* ``close()`` stops intake, keeps retrying until ``shutdown_timeout``, and
  reports whatever is still queued (or was cut off in flight) as
  ``"shutdown"``. Every event taken off the queue is accounted for once.
* Fork-safe: a child process gets a fresh lock, queue, HTTP client and flusher.

Queue items are opaque to the core. ``serialize(item)`` turns one into the wire
dict (default: the item itself if it is a dict, else ``item.to_dict()``), and
``on_drop(items, reason)`` receives the original items. ``on_error`` receives a
:class:`TransportError` whose ``kind`` says what happened; ``on_accepted(body,
items)`` receives the unwrapped body of every accepted batch.
"""

from __future__ import annotations

import atexit
import gzip
import json
import logging
import os
import random
import threading
import time
import weakref
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Deque, Dict, List, Optional, Sequence
from urllib.parse import urlsplit

import httpx

from .backoff import breaker_cooldown, full_jitter, parse_retry_after, retry_delay
from .policy import (
    AUTH_FAILURE_STATUSES,
    BREAKER_FLOOR_S,
    BREAKER_INITIAL_S,
    BREAKER_MAX_S,
    COMPRESSION_MIN_BYTES,
    CONNECT_TIMEOUT_S,
    DEFAULT_FLUSH_COUNT,
    DEFAULT_FLUSH_INTERVAL_S,
    DEFAULT_QUEUE_CAPACITY,
    INGEST_PATH,
    MAX_BATCH_EVENTS,
    MAX_RESPONSE_BODY_BYTES,
    MAX_RETRIES,
    REQUEST_TIMEOUT_S,
    RETRY_BASE_S,
    RETRY_MAX_DELAY_S,
    SHUTDOWN_TIMEOUT_S,
    SPLIT_STATUSES,
    TARGET_REQUEST_BODY_BYTES,
    is_retry_status,
)
from .urls import validate_base_url

DropHook = Callable[[List[Any], str], None]

_THROTTLED_REASONS = ("overflow", "invalid", "closed")

#: ``TransportError.kind`` values.
ERROR_KINDS = ("outage", "auth", "rejected", "shutdown", "closed")


class TransportError(RuntimeError):
    """What ``on_error`` receives. Branch on ``kind``, never on the message.

    * ``outage``: network errors, timeouts, 408/429/5xx after every retry, a
      redirect, or per-event ``retryable`` failures that never cleared. The
      events are still queued (``will_retry`` is True).
    * ``auth``: HTTP 401/403, the API key is wrong or revoked. Still queued.
    * ``rejected``: the ingestor refused these events; they are gone.
    * ``shutdown``: still queued (or in flight) at the shutdown deadline.
    * ``closed``: tracked after ``close()``.

    ``events`` are the events concerned (empty when the ingestor did not name
    them); ``status`` is the HTTP status when there was one.
    """

    def __init__(self, kind: str, message: str, events: Sequence[Any] = (),
                 status: Optional[int] = None) -> None:
        super().__init__(message)
        self.kind = kind
        self.events: List[Any] = list(events)
        self.status = status
        self.will_retry = kind in ("outage", "auth")


@dataclass
class FlushOutcome:
    """What one ``flush()`` call saw."""

    sent: int = 0
    """Events the ingestor accepted while this flush ran."""
    dropped: int = 0
    """Events permanently dropped while this flush ran."""
    pending: int = 0
    """Events still queued afterwards (for example while the breaker is open)."""


class _Entry:
    """A queued event: the caller's item and its JSON, made at ``enqueue()``."""

    __slots__ = ("item", "wire")

    def __init__(self, item: Any, wire: str) -> None:
        self.item = item
        self.wire = wire


class _Answer:
    """One HTTP exchange: a status with headers and body, or a failure text."""

    __slots__ = ("status", "headers", "body", "failure")

    def __init__(self, status: Optional[int] = None, headers: Optional[httpx.Headers] = None,
                 body: bytes = b"", failure: str = "") -> None:
        self.status = status
        self.headers = headers if headers is not None else httpx.Headers()
        self.body = body
        self.failure = failure

    def json(self) -> Any:
        if not self.body:
            return None
        try:
            return json.loads(self.body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None


def unwrap_envelope(payload: Any) -> Any:
    """The ingestor wraps 2xx JSON in ``{success, data, meta}``; return ``data``."""
    if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
        return payload["data"]
    return payload


def _default_serialize(item: Any) -> Dict[str, Any]:
    if isinstance(item, dict):
        return item
    to_dict = getattr(item, "to_dict", None)
    if callable(to_dict):
        return to_dict()
    raise TypeError(f"cannot serialize queue item of type {type(item).__name__}")


_INSTANCES: "weakref.WeakSet[TransportCore]" = weakref.WeakSet()


def _after_fork_in_child() -> None:
    for core in list(_INSTANCES):
        try:
            core._reinit_after_fork()
        except Exception:  # never break the child process over metering
            logging.getLogger("aforo.transport").debug("re-init after fork failed", exc_info=True)


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_after_fork_in_child)


class TransportCore:
    """Bounded queue + single flusher + pooled HTTP client for one SDK client."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        user_agent: str,
        name: str = "aforo",
        logger: Optional[logging.Logger] = None,
        path: str = INGEST_PATH,
        flush_count: int = DEFAULT_FLUSH_COUNT,
        flush_interval: float = DEFAULT_FLUSH_INTERVAL_S,
        max_queue_size: int = DEFAULT_QUEUE_CAPACITY,
        timeout: float = REQUEST_TIMEOUT_S,
        connect_timeout: float = CONNECT_TIMEOUT_S,
        max_retries: int = MAX_RETRIES,
        retry_base: float = RETRY_BASE_S,
        retry_max_delay: float = RETRY_MAX_DELAY_S,
        shutdown_timeout: float = SHUTDOWN_TIMEOUT_S,
        breaker_initial: float = BREAKER_INITIAL_S,
        breaker_max: float = BREAKER_MAX_S,
        breaker_floor: float = BREAKER_FLOOR_S,
        target_body_bytes: int = TARGET_REQUEST_BODY_BYTES,
        allow_insecure_http: bool = False,
        on_drop: Optional[DropHook] = None,
        on_error: Optional[Callable[[Exception], None]] = None,
        on_accepted: Optional[Callable[[Any, List[Any]], None]] = None,
        serialize: Optional[Callable[[Any], Dict[str, Any]]] = None,
        extra_headers: Optional[Dict[str, str]] = None,
        clock: Optional[Callable[[], float]] = None,
        wall_clock: Optional[Callable[[], float]] = None,
        sleep: Optional[Callable[[float], None]] = None,
        rand: Optional[Callable[[], float]] = None,
        http_transport: Optional[httpx.BaseTransport] = None,
        register_atexit: bool = True,
        compression: str = "gzip",
    ) -> None:
        if not isinstance(api_key, str) or not api_key.strip():
            raise ValueError("api_key is required")
        if compression not in ("gzip", "none"):
            raise ValueError('compression must be "gzip" or "none"')
        self._gzip = compression == "gzip"
        self._url = validate_base_url(base_url, allow_insecure_http) + path
        self._name = name
        self._log = logger or logging.getLogger("aforo.transport")
        self._api_key = api_key
        extra = {k: v for k, v in (extra_headers or {}).items() if k.lower() != "content-encoding"}
        self._headers = {
            "Content-Type": "application/json",
            "User-Agent": user_agent,
            **extra,
            "X-API-Key": api_key,
        }
        self._gzip_headers = {**self._headers, "Content-Encoding": "gzip"}
        try:
            count = int(flush_count)
        except (TypeError, ValueError):
            count = DEFAULT_FLUSH_COUNT
        self._flush_count = max(1, min(count, MAX_BATCH_EVENTS))
        self._flush_interval = max(0.01, float(flush_interval))
        if int(max_queue_size) < 1:
            raise ValueError("max_queue_size must be >= 1")
        self._capacity = int(max_queue_size)
        self._timeout = float(timeout)
        self._connect_timeout = min(float(connect_timeout), self._timeout)
        self._max_retries = max(0, int(max_retries))
        self._retry_base = float(retry_base)
        self._retry_max_delay = float(retry_max_delay)
        self._shutdown_timeout = max(0.0, float(shutdown_timeout))
        self._breaker_initial = float(breaker_initial)
        self._breaker_max = float(breaker_max)
        self._breaker_floor = max(0.0, float(breaker_floor))
        self._target_body_bytes = int(target_body_bytes)
        self._on_drop = on_drop
        self._on_error = on_error
        self._on_accepted = on_accepted
        self._serialize = serialize or _default_serialize
        self._clock = clock or time.monotonic
        self._wall_clock = wall_clock or time.time
        self._custom_sleep = sleep
        self._rand = rand or random.random
        self._http_transport = http_transport
        self._register_atexit = register_atexit
        self._init_runtime_state()
        # Resolved once, in the process that builds the client: on macOS the
        # system proxy lookup crashes in a forked child, so the child reuses it.
        self._proxy_url = None if http_transport is not None else _proxy_for(self._url, self._log)
        self._http = self._new_http_client()
        _INSTANCES.add(self)
        self._start_flusher()
        if register_atexit:
            atexit.register(self._atexit_close)

    # ── state ────────────────────────────────────────────────────────

    def _init_runtime_state(self) -> None:
        self._lock = threading.Lock()
        self._done = threading.Condition(self._lock)
        self._wake = threading.Event()
        self._kick = threading.Event()  # flush() / close(): ends a breaker pause
        self._interrupt = threading.Event()
        self._queue: Deque[_Entry] = deque()
        self._closed = False
        self._deadline: Optional[float] = None
        # Real (time.monotonic) deadline close() puts on requests already in flight.
        self._close_hard_deadline: Optional[float] = None
        self._close_done = threading.Event()
        self._flush_requested = 0
        self._flush_completed = 0
        self._breaker_until = 0.0
        self._breaker_openings = 0
        self._breaker_is_open = False
        self._loud_logged_for_opening = False
        self._sent = 0
        self._dropped = 0
        self._throttle_counts = {reason: 0 for reason in _THROTTLED_REASONS}
        self._thread: Optional[threading.Thread] = None
        self._thread_exited = threading.Event()
        self._http_closed = False
        self._in_flight: Optional[List[_Entry]] = None
        self._abandoned = False
        self._pid = os.getpid()

    def _new_http_client(self) -> httpx.Client:
        limits = httpx.Limits(max_connections=4, max_keepalive_connections=2)
        transport = self._http_transport
        if transport is None:
            # An explicit transport keeps httpx from looking up proxies itself;
            # the proxy for our one URL was resolved at construction.
            transport = httpx.HTTPTransport(proxy=self._proxy_url, limits=limits, trust_env=True)
        return httpx.Client(
            timeout=httpx.Timeout(self._timeout, connect=self._connect_timeout),
            transport=transport,
            follow_redirects=False,
            limits=limits,
        )

    def _start_flusher(self) -> None:
        thread = threading.Thread(target=self._run, name=f"{self._name}-flusher", daemon=True)
        self._thread = thread
        thread.start()

    def _reinit_after_fork(self) -> None:
        """Called in a forked child. The parent keeps (and sends) the events
        queued before the fork; the child starts empty with its own flusher.
        The parent's HTTP connections are not closed from here, because closing
        a shared TLS socket would also affect the parent."""
        was_closed = self._closed
        self._init_runtime_state()
        self._closed = was_closed
        if was_closed:
            self._close_done.set()
        self._http = self._new_http_client()
        if not was_closed:
            self._start_flusher()

    def __repr__(self) -> str:
        return f"TransportCore(name={self._name!r}, url={self._url!r})"

    # ── public API ───────────────────────────────────────────────────

    @property
    def url(self) -> str:
        return self._url

    @property
    def flush_count(self) -> int:
        return self._flush_count

    @property
    def capacity(self) -> int:
        return self._capacity

    @property
    def queue_size(self) -> int:
        with self._lock:
            return len(self._queue)

    def queued_items(self) -> List[Any]:
        """A snapshot of the events waiting to be sent, oldest first."""
        with self._lock:
            return [e.item for e in self._queue]

    @property
    def dropped_count(self) -> int:
        with self._lock:
            return self._dropped

    @property
    def sent_count(self) -> int:
        with self._lock:
            return self._sent

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def breaker_open(self) -> bool:
        with self._lock:
            return self._breaker_until > self._clock()

    def enqueue(self, item: Any) -> bool:
        """Queue one event. Never sends, never starts a thread, never raises.

        The event is turned into JSON here, so one that cannot be (a cycle, a
        NaN, an object JSON does not know) is dropped as ``"invalid"`` now and
        never reaches a batch. An event tracked after ``close()`` is reported
        as ``"closed"``. Both return False."""
        if self._closed:
            self._drop_closed(item)
            return False
        try:
            wire = json.dumps(self._serialize(item), separators=(",", ":"),
                              ensure_ascii=False, allow_nan=False)
        except Exception as exc:  # ValueError (cycle, NaN), TypeError, a to_dict() that raised
            self.report_drop([item], "invalid", detail=f"event is not JSON-serializable: {exc}")
            return False
        entry = _Entry(item, wire)
        evicted = None
        with self._lock:
            if self._closed:
                closed = True
                size = 0
            else:
                closed = False
                self._queue.append(entry)
                if len(self._queue) > self._capacity:
                    evicted = self._queue.popleft()
                size = len(self._queue)
        if closed:
            self._drop_closed(item)
            return False
        if evicted is not None:
            self.report_drop([evicted.item], "overflow")
        if size >= self._flush_count and not self._wake.is_set():
            self._wake.set()
        return True

    def _drop_closed(self, item: Any) -> None:
        if self._drop([item], "closed", None, None):
            self._notify_error(TransportError(
                "closed", f"[{self._name}] event tracked after shutdown was not sent "
                          f"({self.dropped_count} total dropped)", [item]))

    def report_drop(self, items: Sequence[Any], reason: str, *, count: Optional[int] = None,
                    detail: Optional[str] = None) -> None:
        """Count, log and hand dropped events to ``on_drop``.

        ``count`` overrides ``len(items)`` when the ingestor rejected events
        without saying which: they are counted, but no event is passed to the
        hook that may in fact have been accepted.
        """
        self._drop(items, reason, count, detail)

    def _drop(self, items: Sequence[Any], reason: str, count: Optional[int],
              detail: Optional[str]) -> bool:
        """``report_drop``; True when this drop was logged (throttled reasons log
        the first one and then every 1000th)."""
        n = len(items) if count is None else count
        if n <= 0:
            return False
        with self._lock:
            self._dropped += n
            total = self._dropped
            if reason in self._throttle_counts:
                before = self._throttle_counts[reason]
                self._throttle_counts[reason] = before + n
                should_log = before == 0 or (before // 1000) != ((before + n) // 1000)
            else:
                should_log = True
        if should_log:
            if reason == "invalid":
                self._log.warning("[%s] Invalid event not sent: %s (%d total dropped).",
                                  self._name, detail or "failed a client-side check", total)
            elif reason == "overflow":
                self._log.warning("[%s] Queue full (%d events): oldest event dropped (%d total dropped). "
                                  "Raise max_queue_size or check connectivity to the ingestor.",
                                  self._name, self._capacity, total)
            elif reason == "closed":
                self._log.warning("[%s] Event tracked after shutdown was not sent (%d total dropped).",
                                  self._name, total)
            else:
                self._log.warning("[%s] Dropped %d event(s): %s%s (%d total dropped).",
                                  self._name, n, reason, f" ({detail})" if detail else "", total)
        if self._on_drop is not None and items:
            try:
                self._on_drop(list(items), reason)
            except Exception:
                self._log.debug("[%s] on_drop hook raised", self._name, exc_info=True)
        return should_log

    def flush(self, timeout: Optional[float] = None) -> FlushOutcome:
        """Ask the flusher to send everything queued and wait for it.

        Never sends on the calling thread. While the breaker is open the
        flusher makes one attempt now (an outage reopens the breaker and the
        events stay queued). Returns after ``timeout`` seconds when given.
        """
        if threading.current_thread() is self._thread:
            # Called from a hook on the flusher itself: waiting would deadlock.
            return FlushOutcome(pending=self.queue_size)
        with self._lock:
            sent0, dropped0 = self._sent, self._dropped
            if self._closed or self._thread is None or not self._thread.is_alive():
                return FlushOutcome(pending=len(self._queue))
            self._flush_requested += 1
            ticket = self._flush_requested
        self._kick.set()
        self._wake.set()
        wait_until = None if timeout is None else time.monotonic() + max(0.0, timeout)
        with self._done:
            while self._flush_completed < ticket and not self._thread_exited.is_set():
                remaining = None if wait_until is None else wait_until - time.monotonic()
                if remaining is not None and remaining <= 0:
                    break
                self._done.wait(remaining if remaining is not None else 0.5)
            return FlushOutcome(sent=self._sent - sent0, dropped=self._dropped - dropped0,
                                pending=len(self._queue))

    def close(self, timeout: Optional[float] = None) -> None:
        """Stop intake, keep sending until the shutdown deadline, report
        leftovers as ``"shutdown"`` and close the HTTP client.

        A second call does not drain again: it waits for the first one to
        finish and returns."""
        budget = self._shutdown_timeout if timeout is None else max(0.0, float(timeout))
        with self._lock:
            if self._closed:
                already = True
            else:
                already = False
                self._closed = True
                self._deadline = self._clock() + budget
                self._close_hard_deadline = time.monotonic() + budget
        if self._register_atexit:
            atexit.unregister(self._atexit_close)
        thread = self._thread
        if already:
            if thread is not threading.current_thread():
                self._close_done.wait(budget + 2.0)
            return
        self._wake.set()
        self._kick.set()
        self._interrupt.set()
        if thread is threading.current_thread():
            return  # close() from a hook on the flusher: it drains when the hook returns
        try:
            if thread is not None and thread.is_alive():
                # The flusher stops sending at the deadline; every request it
                # starts in the window, and the one in flight, ends by then.
                thread.join(budget)
                if thread.is_alive():
                    # A request is still running. Do not wait for it: report it
                    # with the queue and abort the connection.
                    with self._lock:
                        self._abandoned = True
                        stuck = list(self._in_flight or [])
                        self._in_flight = None
                    if stuck:
                        self._report_shutdown([e.item for e in stuck],
                                              "request still in flight when the shutdown deadline passed")
                    self._report_leftovers()
                    self._close_http()
                    thread.join(1.0)
            self._report_leftovers()
            self._close_http()
        finally:
            with self._done:
                self._flush_completed = self._flush_requested
                self._done.notify_all()
            self._close_done.set()

    def _close_http(self) -> None:
        with self._lock:
            if self._http_closed:
                return
            self._http_closed = True
        try:
            self._http.close()
        except Exception:
            self._log.debug("[%s] closing the HTTP client failed", self._name, exc_info=True)

    def post_single(self, payload: Dict[str, Any], timeout: Optional[float] = None) -> Optional[Dict[str, Any]]:
        """One POST of ``payload`` on the pooled client, no retry, no queue.

        For session heartbeats, which must travel alone. Returns the response
        ``data`` object on 2xx, else None. Never raises.
        """
        try:
            body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        except Exception as exc:
            self._log.debug("[%s] single post not JSON-serializable: %s", self._name, type(exc).__name__)
            return None
        answer = self._exchange(body.encode("utf-8"), None, timeout)
        if answer.status is not None and 200 <= answer.status < 300:
            data = unwrap_envelope(answer.json())
            return data if isinstance(data, dict) else {}
        if answer.status is not None:
            self._log.debug("[%s] single post answered HTTP %d", self._name, answer.status)
        else:
            self._log.debug("[%s] single post failed: %s", self._name, answer.failure.split(":")[0])
        return None

    # ── flusher ──────────────────────────────────────────────────────

    def _sleep(self, seconds: float) -> None:
        if seconds <= 0:
            return
        if self._custom_sleep is not None:
            self._custom_sleep(seconds)
        else:
            self._interrupt.wait(seconds)

    def _breaker_sleep(self, seconds: float) -> None:
        """The breaker pause; flush() and close() end it early."""
        if seconds <= 0:
            return
        if self._custom_sleep is not None:
            self._custom_sleep(seconds)
        else:
            self._kick.wait(seconds)

    def _run(self) -> None:
        try:
            next_due = self._clock() + self._flush_interval
            resume = False  # set after a breaker pause: retry the requeued events right away
            while True:
                # Cleared before the state is read, so a flush()/close() that
                # lands after the read still ends the breaker pause below.
                self._kick.clear()
                with self._lock:
                    closing = self._closed
                    requested = self._flush_requested
                    size = len(self._queue)
                    breaker_wait = self._breaker_until - self._clock()
                if closing:
                    self._shutdown_drain()
                    return
                if breaker_wait > 0:
                    if requested > self._flush_completed:
                        # flush() while the breaker is open: one attempt now.
                        self._wake.clear()
                        self._drain(None, single_attempt=True)
                        self._complete_flushes(requested)
                        continue
                    self._breaker_sleep(breaker_wait)
                    resume = True
                    continue
                now = self._clock()
                due = now >= next_due
                if not (due or resume or size >= self._flush_count or requested > self._flush_completed):
                    self._wake.wait(max(0.0, next_due - now))
                    self._wake.clear()
                    continue
                self._wake.clear()
                resume = False
                if due:
                    next_due = now + self._flush_interval
                self._drain(None)
                self._complete_flushes(requested)
        except Exception:
            self._log.exception("[%s] flusher stopped unexpectedly", self._name)
        finally:
            self._thread_exited.set()
            with self._done:
                self._done.notify_all()

    def _complete_flushes(self, ticket: int) -> None:
        with self._done:
            if ticket > self._flush_completed:
                self._flush_completed = ticket
            self._done.notify_all()

    def _take_batch(self) -> List[_Entry]:
        with self._lock:
            take = min(self._flush_count, len(self._queue))
            return [self._queue.popleft() for _ in range(take)]

    def _drain(self, deadline: Optional[float], single_attempt: bool = False) -> bool:
        """Send batches until the queue is empty. False when a batch could not
        be delivered (it was requeued)."""
        while True:
            if deadline is not None and self._clock() >= deadline:
                return False
            if deadline is None and self._closed:
                return False
            if self._abandoned:
                return False
            batch = self._take_batch()
            if not batch:
                return True
            if not self._send_group(batch, deadline, split_for_size=True, single_attempt=single_attempt):
                return False

    def _shutdown_drain(self) -> None:
        """After close(): keep sending, with jittered backoff between rounds,
        until the queue is empty or the deadline passes."""
        self._interrupt.clear()
        deadline = self._deadline if self._deadline is not None else self._clock()
        rounds = 0
        while not self._abandoned:
            if self._drain(deadline):
                break
            if self._abandoned or self._clock() >= deadline:
                break
            delay = max(self._breaker_floor,
                        full_jitter(rounds, self._rand, self._retry_base, self._retry_max_delay))
            if self._clock() + delay >= deadline:
                break
            self._log.debug("[%s] shutdown: ingestor not reachable; trying again in %.2fs", self._name, delay)
            self._sleep(delay)
            rounds += 1
        if not self._abandoned:
            self._report_leftovers()
            self._close_http()
            # close() called from a hook on the flusher returned at once; a
            # later close() from another thread waits for this.
            self._close_done.set()
        with self._done:
            self._flush_completed = self._flush_requested
            self._done.notify_all()

    def _report_leftovers(self) -> None:
        with self._lock:
            leftovers = [e.item for e in self._queue]
            self._queue.clear()
        if leftovers:
            self._report_shutdown(leftovers, "still queued when the shutdown deadline passed")

    def _report_shutdown(self, items: List[Any], detail: str) -> None:
        self.report_drop(items, "shutdown", detail=detail)
        self._notify_error(TransportError(
            "shutdown", f"[{self._name}] {len(items)} event(s) not sent: {detail}", items))

    # ── delivery ─────────────────────────────────────────────────────

    @staticmethod
    def _body(entries: Sequence[_Entry]) -> bytes:
        return ('{"events":[' + ",".join(e.wire for e in entries) + "]}").encode("utf-8")

    def _send_group(self, entries: List[_Entry], deadline: Optional[float], split_for_size: bool,
                    single_attempt: bool = False) -> bool:
        body = self._body(entries)
        if split_for_size and len(entries) > 1 and len(body) > self._target_body_bytes:
            return self._send_halves(entries, deadline, True, single_attempt)
        return self._post(entries, body, deadline, single_attempt)

    def _send_halves(self, entries: List[_Entry], deadline: Optional[float], split_for_size: bool,
                     single_attempt: bool) -> bool:
        mid = len(entries) // 2
        if not self._send_group(entries[:mid], deadline, split_for_size, single_attempt):
            self._requeue_front(entries[mid:])
            return False
        return self._send_group(entries[mid:], deadline, split_for_size, single_attempt)

    def _request_seconds(self, deadline: Optional[float], override: Optional[float]) -> float:
        total = self._timeout if override is None else min(self._timeout, override)
        if deadline is not None:
            total = min(total, max(0.0, deadline - self._clock()))
        return max(total, 0.001)

    def _encode(self, body: bytes) -> "tuple[bytes, bool]":
        """gzip ``body`` when compression is on and it is at least COMPRESSION_MIN_BYTES
        (wave 8, G269). A compression failure sends the JSON as it is."""
        if not self._gzip or len(body) < COMPRESSION_MIN_BYTES:
            return body, False
        try:
            return gzip.compress(body, compresslevel=6), True
        except Exception:
            self._log.debug("[%s] gzip failed, sending uncompressed", self._name, exc_info=True)
            return body, False

    def _exchange(self, body: bytes, deadline: Optional[float], override: Optional[float] = None,
                  gzipped: bool = False) -> _Answer:
        """One POST. ``timeout`` is a total deadline for the whole exchange:
        connecting, sending, the response headers and reading the body. Every
        phase gets only the time that is left, and the body is read in pieces
        so a server that drips it one byte at a time is cut off on time."""
        total = self._request_seconds(deadline, override)
        hard = time.monotonic() + total

        def left() -> float:
            end = hard
            close_hard = self._close_hard_deadline
            if close_hard is not None and close_hard < end:
                end = close_hard
            return end - time.monotonic()

        timeouts: Dict[str, Any] = {}

        def trace(event: str, info: Any) -> None:
            # httpcore reads its timeouts when each phase starts; give every
            # phase only what is left of the total.
            if not event.endswith(".started"):
                return
            remaining = max(0.001, left())
            limits = timeouts.get("timeout")
            if isinstance(limits, dict):
                limits["connect"] = min(self._connect_timeout, remaining)
                limits["read"] = remaining
                limits["write"] = remaining
                limits["pool"] = remaining

        resp: Optional[httpx.Response] = None
        try:
            request = self._http.build_request(
                "POST", self._url, content=body, headers=self._gzip_headers if gzipped else self._headers,
                timeout=httpx.Timeout(total, connect=min(self._connect_timeout, total)),
                extensions={"trace": trace})
            timeouts["timeout"] = request.extensions.get("timeout")
            resp = self._http.send(request, stream=True)
            chunks: List[bytes] = []
            size = 0
            for chunk in resp.iter_bytes():
                if left() <= 0:
                    raise httpx.ReadTimeout("the response body was not complete within the request timeout",
                                            request=request)
                size += len(chunk)
                if size > MAX_RESPONSE_BODY_BYTES:
                    break  # the ingestor's bodies are small; stop reading a runaway one
                chunks.append(chunk)
            return _Answer(resp.status_code, resp.headers, b"".join(chunks))
        except Exception as exc:  # httpx.HTTPError, OSError, or a client closed under us
            return _Answer(failure=f"{type(exc).__name__}: {exc}")
        finally:
            if resp is not None:
                try:
                    resp.close()
                except Exception:
                    self._log.debug("[%s] closing a response failed", self._name, exc_info=True)

    def _post(self, entries: List[_Entry], body: bytes, deadline: Optional[float],
              single_attempt: bool = False) -> bool:
        # Compressed once; every retry sends the same bytes.
        body, gzipped = self._encode(body)
        attempt = 0
        while True:
            if deadline is None and self._closed:
                # close() started during this send: adopt its deadline, and let
                # the remaining retry waits really wait (close() interrupted them).
                deadline = self._deadline
                self._interrupt.clear()
            if deadline is not None and self._clock() >= deadline:
                self._requeue_front(entries)
                return False
            retry_after: Optional[float] = None
            with self._lock:
                self._in_flight = entries
            answer = self._exchange(body, deadline, gzipped=gzipped)
            with self._lock:
                self._in_flight = None
                abandoned = self._abandoned
            if abandoned:
                return False  # close() already reported this batch as "shutdown"
            status = answer.status
            failure = answer.failure
            if status is not None:
                if 200 <= status < 300:
                    again = self._accepted(entries, answer)
                    if not again:
                        return True
                    # Per-event retryable: re-send those (same keys) after the
                    # normal backoff, at most max_retries times.
                    entries = again
                    body = self._body(entries)
                    failure = f"{len(entries)} event(s) answered retryable"
                    status = None
                elif status in SPLIT_STATUSES:
                    if len(entries) > 1:
                        return self._send_halves(entries, deadline, False, single_attempt)
                    detail = f"HTTP {status}: one event is larger than the ingestor accepts"
                    self.report_drop([e.item for e in entries], "rejected", detail=detail)
                    self._notify_error(TransportError("rejected", f"ingestor rejected an event: {detail}",
                                                      [e.item for e in entries], status))
                    return True
                elif status in AUTH_FAILURE_STATUSES:
                    self._outage(entries, f"HTTP {status}", status=status, auth=True)
                    return False
                elif 300 <= status < 400:
                    location = answer.headers.get("location") or ""
                    self._outage(entries, f"HTTP {status} redirect", status=status, redirect_to=location)
                    return False
                elif is_retry_status(status):
                    retry_after = parse_retry_after(answer.headers.get("retry-after"), self._wall_clock())
                    failure = f"HTTP {status}"
                else:
                    detail = f"HTTP {status}{_error_summary(answer)}"
                    items = [e.item for e in entries]
                    self.report_drop(items, "rejected", detail=detail)
                    self._notify_error(TransportError("rejected", f"ingestor rejected a batch: {detail}",
                                                      items, status))
                    return True
            if single_attempt or attempt >= self._max_retries:
                self._outage(entries, failure, status=answer.status)
                return False
            delay = retry_delay(attempt, retry_after, self._rand, self._retry_base, self._retry_max_delay)
            if deadline is not None and self._clock() + delay >= deadline:
                self._requeue_front(entries)
                return False
            self._log.debug("[%s] send failed (%s); retry %d/%d in %.2fs",
                            self._name, failure, attempt + 1, self._max_retries, delay)
            self._sleep(delay)
            attempt += 1

    def _accepted(self, entries: List[_Entry], answer: _Answer) -> List[_Entry]:
        """2xx. Returns the events the ingestor answered ``retryable`` (to be
        re-sent); the other named failures are dropped as rejected. ``errors[]``
        is authoritative even when ``failed`` is missing or 0."""
        payload = unwrap_envelope(answer.json())
        count = len(entries)
        failed = 0
        retryable: List[int] = []
        rejected: List[int] = []
        messages: List[str] = []
        if isinstance(payload, dict):
            raw_failed = payload.get("failed")
            if isinstance(raw_failed, int) and not isinstance(raw_failed, bool) and raw_failed > 0:
                failed = min(raw_failed, count)
            errors = payload.get("errors")
            if isinstance(errors, list):
                seen = set()
                for err in errors:
                    if not isinstance(err, dict):
                        continue
                    idx = err.get("index")
                    if len(messages) < 10:
                        messages.append(f"[{idx}] {err.get('message')}")
                    if not isinstance(idx, int) or isinstance(idx, bool) or not 0 <= idx < count or idx in seen:
                        continue
                    seen.add(idx)
                    (retryable if err.get("retryable") is True else rejected).append(idx)
                failed = max(failed, len(seen))
        unidentified = max(0, failed - len(retryable) - len(rejected))
        with self._lock:
            self._sent += count - failed
            if not retryable:
                # A send that went through closes the breaker. A batch still
                # answering "retryable" does not: its cap may open it again.
                self._breaker_until = 0.0
                self._breaker_openings = 0
                self._breaker_is_open = False
                self._loud_logged_for_opening = False
        for message in messages:
            self._log.warning("[%s] Ingestor did not accept event %s", self._name, message)
        if rejected:
            items = [entries[i].item for i in rejected]
            self.report_drop(items, "rejected")
            self._notify_error(TransportError(
                "rejected", f"ingestor did not accept {len(rejected)} event(s)"
                            + (": " + "; ".join(messages[:5]) if messages else ""), items, answer.status))
        if unidentified:
            self.report_drop([], "rejected", count=unidentified, detail="the response did not say which events")
            self._notify_error(TransportError(
                "rejected", f"ingestor did not accept {unidentified} event(s) and did not say which",
                [], answer.status))
        if self._on_accepted is not None:
            try:
                self._on_accepted(payload, [e.item for e in entries])
            except Exception:
                self._log.debug("[%s] on_accepted hook raised", self._name, exc_info=True)
        return [entries[i] for i in retryable]

    def _requeue_front(self, entries: Sequence[_Entry]) -> None:
        if not entries:
            return
        evicted: List[_Entry] = []
        with self._lock:
            abandoned = self._abandoned
            if not abandoned:
                self._queue.extendleft(reversed(list(entries)))
                while len(self._queue) > self._capacity:
                    evicted.append(self._queue.popleft())
        if abandoned:
            # close() gave up on the flusher; these were taken off the queue and
            # not sent, so they are reported here rather than lost.
            self._report_shutdown([e.item for e in entries], "not sent before the shutdown deadline")
            return
        if evicted:
            self.report_drop([e.item for e in evicted], "overflow")

    def _outage(self, entries: List[_Entry], failure: str, status: Optional[int] = None,
                auth: bool = False, redirect_to: Optional[str] = None) -> None:
        self._requeue_front(entries)
        loud = auth or redirect_to is not None
        with self._lock:
            cooldown = breaker_cooldown(self._breaker_openings, self._rand, self._breaker_initial,
                                        self._breaker_max, floor=self._breaker_floor)
            first = not self._breaker_is_open
            self._breaker_is_open = True
            self._breaker_openings += 1
            self._breaker_until = self._clock() + cooldown
            log_loud = loud and not self._loud_logged_for_opening
            if loud:
                self._loud_logged_for_opening = True
            pending = len(self._queue)
        kept = [e.item for e in entries]
        if log_loud and auth:
            self._log.error("[%s] Ingestor answered HTTP %d: the API key is wrong or revoked. %d event(s) "
                            "stay queued and are retried in %.0fs.", self._name, status, pending, cooldown)
            self._notify_error(TransportError(
                "auth", f"ingestor answered HTTP {status}: the API key is wrong or revoked; events requeued",
                kept, status))
        elif log_loud:
            host = _host_of(redirect_to)
            self._log.error("[%s] Ingestor answered HTTP %d with a redirect to %s. Redirects are not "
                            "followed (the API key would go to another host): check base_url. %d event(s) "
                            "stay queued and are retried in %.1fs.", self._name, status,
                            host or "an unnamed location", pending, cooldown)
            self._notify_error(TransportError(
                "outage", f"ingestor answered HTTP {status} redirecting to {host or 'an unnamed location'}; "
                          "redirects are not followed; events requeued", kept, status))
        elif first:
            self._log.warning("[%s] Ingestor unreachable (%s). %d event(s) stay queued; retrying in %.1fs.",
                              self._name, failure, pending, cooldown)
            self._notify_error(TransportError(
                "outage", f"ingestor unreachable ({failure}); events requeued", kept, status))
        else:
            self._log.debug("[%s] Ingestor still unreachable (%s); retrying in %.1fs.",
                            self._name, failure, cooldown)

    def _notify_error(self, exc: Exception) -> None:
        if self._on_error is None:
            return
        try:
            self._on_error(exc)
        except Exception:
            self._log.debug("[%s] on_error hook raised", self._name, exc_info=True)

    def _atexit_close(self) -> None:
        try:
            if os.getpid() == self._pid:
                self.close()
        except Exception:
            self._log.debug("[%s] close at exit failed", self._name, exc_info=True)


def _proxy_for(url: str, log: logging.Logger) -> Optional[str]:
    """The proxy (HTTPS_PROXY / ALL_PROXY / system settings, minus NO_PROXY)
    that applies to ``url``, or None."""
    import urllib.request

    try:
        parsed = httpx.URL(url)
        proxies = urllib.request.getproxies()
        if not proxies or urllib.request.proxy_bypass(parsed.host):
            return None
        proxy = proxies.get(parsed.scheme) or proxies.get("all")
    except Exception:
        log.debug("proxy lookup failed; connecting directly", exc_info=True)
        return None
    if not proxy:
        return None
    return proxy if "://" in proxy else f"http://{proxy}"


def _host_of(location: Optional[str]) -> str:
    """The host a redirect points at (never the path or query)."""
    if not location:
        return ""
    try:
        return urlsplit(location).hostname or "a relative location"
    except ValueError:
        return "an unreadable location"


def _error_summary(answer: _Answer) -> str:
    payload = unwrap_envelope(answer.json())
    if not isinstance(payload, dict):
        return ""
    parts: List[str] = []
    detail = payload.get("detail") or payload.get("title")
    if isinstance(detail, str):
        parts.append(detail[:200])
    errors = payload.get("errors")
    if isinstance(errors, list):
        for err in errors[:5]:
            if isinstance(err, dict):
                parts.append(f"[{err.get('index')}] {err.get('message')}")
    return (": " + "; ".join(parts)) if parts else ""
