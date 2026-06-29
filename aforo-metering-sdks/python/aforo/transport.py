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
            "Authorization": f"Bearer {self._api_key}",
        }

        for attempt in range(self._max_retries + 1):
            try:
                with httpx.Client(timeout=self._timeout) as client:
                    resp = client.post(self._url, json=body, headers=headers)

                if 200 <= resp.status_code < 300:
                    return FlushResult(sent=len(events))

                # 4xx except 408/429 — don't retry
                if 400 <= resp.status_code < 500 and resp.status_code not in (408, 429):
                    logger.warning("Ingestor returned %d — not retrying", resp.status_code)
                    return FlushResult(failed=len(events))

                # 429 — respect Retry-After
                if resp.status_code == 429:
                    retry_after = resp.headers.get("Retry-After")
                    delay = float(retry_after) if retry_after else self._retry_base_s * (2 ** attempt)
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
