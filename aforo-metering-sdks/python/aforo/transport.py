"""HTTP transport — sends batched events to the Aforo ingestor with retry."""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

import httpx

from .types import FlushResult, ResolvedEvent

logger = logging.getLogger("aforo.transport")


class Transport:
    """Sends batched usage events to POST /v1/ingest/batch.

    * Retry on 5xx, 408, 429 with exponential backoff
    * Respects ``Retry-After`` header on 429
    * No retry on other 4xx
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = 10.0,
        max_retries: int = 3,
        retry_base_s: float = 1.0,
    ) -> None:
        self._url = base_url.rstrip("/") + "/v1/ingest/batch"
        self._api_key = api_key
        self._timeout = timeout
        self._max_retries = max_retries
        self._retry_base_s = retry_base_s

    def send_sync(self, events: list[ResolvedEvent]) -> FlushResult:
        """Synchronous send (used by the background flush thread)."""
        if not events:
            return FlushResult()

        body = {"events": [e.to_dict() for e in events]}
        headers = {
            "Content-Type": "application/json",
            "X-API-Key": self._api_key,
        }

        for attempt in range(self._max_retries + 1):
            try:
                with httpx.Client(timeout=self._timeout) as client:
                    resp = client.post(self._url, json=body, headers=headers)

                if 200 <= resp.status_code < 300:
                    return _result_from_response(resp, len(events))

                # 4xx except 408/429 — don't retry
                if 400 <= resp.status_code < 500 and resp.status_code not in (408, 429):
                    logger.warning(
                        "Ingestor returned %d — not retrying%s",
                        resp.status_code, _error_summary(resp),
                    )
                    return FlushResult(failed=len(events))

                # 429 — respect Retry-After
                if resp.status_code == 429:
                    delay = _retry_after_s(resp.headers.get("Retry-After"))
                    if delay is None:
                        delay = self._retry_base_s * (2 ** attempt)
                else:
                    delay = self._retry_base_s * (2 ** attempt)

                if attempt < self._max_retries:
                    logger.debug("Retrying in %.1fs (attempt %d/%d)", delay, attempt + 1, self._max_retries)
                    import time
                    time.sleep(delay)
                    continue

                return FlushResult(failed=len(events))

            except (httpx.HTTPError, OSError) as exc:
                logger.debug("Request failed: %s (attempt %d/%d)", exc, attempt + 1, self._max_retries)
                if attempt < self._max_retries:
                    import time
                    time.sleep(self._retry_base_s * (2 ** attempt))
                    continue
                return FlushResult(failed=len(events))

        return FlushResult(failed=len(events))

    def send_heartbeat(self, event: ResolvedEvent) -> Optional[dict]:
        """POST one session heartbeat in its own ``{"events": [hb]}`` request.

        Never batched with usage: a batch above the ingestor's sync threshold goes
        to the high-throughput engine, which does not intercept heartbeats. One
        attempt, no retry; any failure is logged and swallowed. Returns the parsed
        2xx response body (for ``killedSessionIds``), else ``None``.
        """
        headers = {
            "Content-Type": "application/json",
            "X-API-Key": self._api_key,
        }
        try:
            with httpx.Client(timeout=self._timeout) as client:
                resp = client.post(self._url, json={"events": [event.to_dict()]}, headers=headers)
            if 200 <= resp.status_code < 300:
                try:
                    payload = resp.json()
                except Exception:
                    return {}
                return payload if isinstance(payload, dict) else {}
            logger.debug("Heartbeat rejected with %d%s", resp.status_code, _error_summary(resp))
        except Exception as exc:  # best-effort: never affects usage delivery
            logger.debug("Heartbeat failed: %s", exc)
        return None


def _retry_after_s(value: Optional[str]) -> Optional[float]:
    """``Retry-After`` in seconds (delta-seconds form); ``None`` if absent/unparseable."""
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return None


def _error_summary(resp) -> str:
    """First few ``errors[].message`` values from an ingestor response, for logs."""
    try:
        payload = resp.json()
    except Exception:
        return ""
    if not isinstance(payload, dict):
        return ""
    errors = payload.get("errors")
    if not isinstance(errors, list):
        return ""
    msgs = [
        f"[{e.get('index')}] {e.get('message')}"
        for e in errors[:5]
        if isinstance(e, dict)
    ]
    return (": " + "; ".join(msgs)) if msgs else ""


def _result_from_response(resp, count: int) -> FlushResult:
    """Build a FlushResult from a 2xx batch response.

    The ingestor answers ``202 {accepted, duplicates, failed, errors:[{index, message}]}``;
    per-event rejections are reported in ``failed`` / ``errors[].message``.
    """
    failed = 0
    try:
        payload = resp.json()
        if isinstance(payload, dict):
            raw_failed = payload.get("failed")
            if isinstance(raw_failed, int) and not isinstance(raw_failed, bool) and raw_failed > 0:
                failed = min(raw_failed, count)
                errors = payload.get("errors")
                if isinstance(errors, list):
                    for err in errors[:10]:
                        if isinstance(err, dict):
                            logger.warning(
                                "Ingestor rejected event %s: %s",
                                err.get("index"), err.get("message"),
                            )
    except Exception:
        pass  # empty / non-JSON body — treat the whole batch as accepted
    return FlushResult(sent=count - failed, failed=failed)
