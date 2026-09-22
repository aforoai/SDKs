package wsmetering

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ── Ingest contract helpers ──

const (
	// DefaultProductType is stamped on every event as the top-level
	// productType unless Config.ProductType or a per-event EventOptions
	// overrides it.
	DefaultProductType = "WEBSOCKET_API"

	maxSendAttempts = 3
	maxRetryAfter   = 60 * time.Second
)

// EventOptions carries optional per-event overrides.
type EventOptions struct {
	// ProductType overrides Config.ProductType for this event. It is trimmed
	// and upper-cased; unknown values are passed through unchanged.
	ProductType string
}

func normalizeProductType(s string) string {
	return strings.ToUpper(strings.TrimSpace(s))
}

// productTypeFor returns the last non-blank per-event override, else the
// configured default.
func (b *Billing) productTypeFor(opts []EventOptions) string {
	for i := len(opts) - 1; i >= 0; i-- {
		if pt := normalizeProductType(opts[i].ProductType); pt != "" {
			return pt
		}
	}
	return b.cfg.ProductType
}

// batchResponse is the 202 body returned by POST /v1/ingest/batch.
type batchResponse struct {
	Accepted   int `json:"accepted"`
	Duplicates int `json:"duplicates"`
	Failed     int `json:"failed"`
	Errors     []struct {
		Index   int    `json:"index"`
		Message string `json:"message"`
	} `json:"errors"`
}

// send POSTs one chunk of at most maxBatchSize events. The body is marshalled
// once, so every retry carries the same idempotencyKeys. Transport errors,
// 408, 429 (honouring Retry-After) and 5xx are retried; any other 4xx is
// reported via OnError and dropped (retrying cannot fix it).
func (b *Billing) send(chunk []map[string]any) {
	body, err := json.Marshal(map[string]any{"events": chunk})
	if err != nil {
		b.cfg.OnError(err)
		return
	}
	var lastErr error
	for attempt := 1; attempt <= maxSendAttempts; attempt++ {
		req, err := http.NewRequest(http.MethodPost, b.url, bytes.NewReader(body))
		if err != nil {
			b.cfg.OnError(err)
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", b.cfg.APIKey)
		req.Header.Set("X-Tenant-Id", b.cfg.TenantID)
		delay := time.Duration(1<<(attempt-1)) * time.Second
		resp, err := b.client.Do(req)
		if err != nil {
			lastErr = err
		} else {
			respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			code := resp.StatusCode
			switch {
			case code >= 200 && code < 300:
				b.reportPartialFailure(respBody, len(chunk))
				return
			case code == http.StatusRequestTimeout || code == http.StatusTooManyRequests || code >= 500:
				lastErr = fmt.Errorf("ingestor returned HTTP %d", code)
				if code == http.StatusTooManyRequests {
					if secs, perr := strconv.Atoi(strings.TrimSpace(resp.Header.Get("Retry-After"))); perr == nil && secs >= 0 {
						delay = time.Duration(secs) * time.Second
						if delay > maxRetryAfter {
							delay = maxRetryAfter
						}
					}
				}
			default:
				b.cfg.OnError(fmt.Errorf("wsmetering: ingestor rejected batch of %d events with HTTP %d: %s",
					len(chunk), code, errorMessages(respBody)))
				return
			}
		}
		if attempt < maxSendAttempts {
			time.Sleep(delay)
		}
	}
	b.cfg.OnError(fmt.Errorf("wsmetering: flush exhausted retries (dropped %d events): %v", len(chunk), lastErr))
}

// reportPartialFailure surfaces errors[].message from a 2xx body whose
// "failed" count is non-zero.
func (b *Billing) reportPartialFailure(respBody []byte, n int) {
	var br batchResponse
	if json.Unmarshal(respBody, &br) != nil || br.Failed <= 0 {
		return
	}
	b.cfg.OnError(fmt.Errorf("wsmetering: ingestor rejected %d of %d events: %s",
		br.Failed, n, errorMessages(respBody)))
}

// errorMessages renders errors[].message ("[index] message; ...") from an
// ingestor response, falling back to the raw body.
func errorMessages(respBody []byte) string {
	var br batchResponse
	if json.Unmarshal(respBody, &br) == nil && len(br.Errors) > 0 {
		msgs := make([]string, 0, len(br.Errors))
		for _, e := range br.Errors {
			msgs = append(msgs, fmt.Sprintf("[%d] %s", e.Index, e.Message))
		}
		return truncate(strings.Join(msgs, "; "), 1024)
	}
	return truncate(string(respBody), 512)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
