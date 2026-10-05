package grpcmetering

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
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
	DefaultProductType = "GRPC_API"

	// maxBatchSize is the ingestor's per-request cap on POST /v1/ingest/batch.
	maxBatchSize = 1000

	maxSendAttempts = 3
	maxRetryAfter   = 60 * time.Second

	// Field limits mirror the ingestor's IngestUsageEventRequest @Size
	// constraints. The SDK never truncates an id: an over-limit event is
	// dropped with DropInvalid instead.
	maxCustomerIDLen  = 64
	maxProductTypeLen = 20
)

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

// executionStatusFor returns the last non-blank per-event ExecutionStatus
// (raw; the caller normalizes it).
func executionStatusFor(opts []EventOptions) string {
	for i := len(opts) - 1; i >= 0; i-- {
		if strings.TrimSpace(opts[i].ExecutionStatus) != "" {
			return opts[i].ExecutionStatus
		}
	}
	return ""
}

// charLen counts UTF-16 code units, which is what the server's @Size counts
// (Java String.length()). Counting bytes would refuse multi-byte values the
// ingestor accepts.
func charLen(value string) int {
	n := 0
	for _, r := range value {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// tooLong returns a message naming the field, the limit and the (truncated)
// value when value exceeds max characters, else "".
func tooLong(field, value string, max int) string {
	if n := charLen(value); n > max {
		return fmt.Sprintf("%s is %d characters, exceeding the ingestor's %d-character limit (value %q)",
			field, n, max, truncate(value, 80))
	}
	return ""
}

// dropInvalid accounts for an event refused client-side. It is never buffered
// or sent: it is counted in DroppedCount(), WARN-logged (first occurrence,
// then every 1000th, so a tight loop cannot storm the log), reported through
// OnError and handed to the opt-in OnDrop hook with DropInvalid. The event is
// the best-effort resolved event, with its idempotency key when one was minted.
func (b *Billing) dropInvalid(event map[string]any, msg string) {
	total := b.dropped.Add(1)
	if n := b.invalidDrops.Add(1); n == 1 || n%1000 == 0 {
		log.Printf("[grpcmetering] WARN: invalid event dropped, not sent — %s (%d invalid, %d total dropped).", msg, n, total)
	}
	b.cfg.OnError(fmt.Errorf("grpcmetering: invalid event dropped: %s", msg))
	b.callOnDrop([]map[string]any{event}, DropInvalid)
}

// callOnDrop invokes the opt-in hook. A hook bug must never break
// recording or flushing.
func (b *Billing) callOnDrop(events []map[string]any, reason DropReason) {
	if b.cfg.OnDrop == nil || len(events) == 0 {
		return
	}
	defer func() { _ = recover() }()
	b.cfg.OnDrop(events, reason)
}

// DroppedCount returns the total events permanently dropped since this
// Billing instance was created (failed batches, events the ingestor rejected,
// and events refused client-side).
func (b *Billing) DroppedCount() int64 {
	return b.dropped.Load()
}

// recordDrop accounts for permanently lost events: bumps the counter,
// WARN-logs, and invokes the opt-in OnDrop hook. The buffer is drained at
// flush start, so drops here are bounded by flush cadence — no log throttle
// needed.
func (b *Billing) recordDrop(events []map[string]any, reason DropReason) {
	if len(events) == 0 {
		return
	}
	total := b.dropped.Add(int64(len(events)))
	log.Printf("[grpcmetering] WARN: dropped %d event(s) — %s (%d total dropped).", len(events), reason, total)
	b.callOnDrop(events, reason)
}

// batchResponse is the 202 body returned by POST /v1/ingest/batch.
type batchResponse struct {
	Accepted   int `json:"accepted"`
	Duplicates int `json:"duplicates"`
	Failed     int `json:"failed"`
	Errors     []struct {
		Index   *int   `json:"index"`
		Message string `json:"message"`
	} `json:"errors"`
}

// flush drains the buffer and sends it in chunks of at most maxBatchSize.
func (b *Billing) flush() {
	b.mu.Lock()
	if len(b.buffer) == 0 {
		b.mu.Unlock()
		return
	}
	batch := b.buffer
	b.buffer = nil
	b.mu.Unlock()

	for start := 0; start < len(batch); start += maxBatchSize {
		end := start + maxBatchSize
		if end > len(batch) {
			end = len(batch)
		}
		b.send(batch[start:end])
	}
}

// send POSTs one chunk of at most maxBatchSize events. The body is marshalled
// once, so every retry carries the same idempotencyKeys. Transport errors,
// 408, 429 (honouring Retry-After) and 5xx are retried; exhausting the
// retries drops the chunk with DropRetryExhausted. Any other 4xx is not
// retried (retrying cannot fix it) and drops the chunk with DropRejected.
func (b *Billing) send(chunk []map[string]any) {
	body, err := json.Marshal(map[string]any{"events": chunk})
	if err != nil {
		b.recordDrop(chunk, DropRejected)
		b.cfg.OnError(err)
		return
	}
	var lastErr error
	for attempt := 1; attempt <= maxSendAttempts; attempt++ {
		req, err := http.NewRequest(http.MethodPost, b.url, bytes.NewReader(body))
		if err != nil {
			b.recordDrop(chunk, DropRejected)
			b.cfg.OnError(err)
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", b.cfg.APIKey)
		req.Header.Set("X-Tenant-Id", b.cfg.TenantID)
		delay := time.Duration(1<<(attempt-1)) * b.retryBackoffBase
		resp, err := b.client.Do(req)
		if err != nil {
			lastErr = err
		} else {
			respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			code := resp.StatusCode
			switch {
			case code >= 200 && code < 300:
				b.reportPartialFailure(respBody, chunk)
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
				b.recordDrop(chunk, DropRejected)
				b.cfg.OnError(fmt.Errorf("grpcmetering: ingestor rejected batch of %d events with HTTP %d: %s",
					len(chunk), code, errorMessages(respBody)))
				return
			}
		}
		if attempt < maxSendAttempts {
			time.Sleep(delay)
		}
	}
	b.recordDrop(chunk, DropRetryExhausted)
	b.cfg.OnError(fmt.Errorf("grpcmetering: flush exhausted retries (dropped %d events): %v", len(chunk), lastErr))
}

// reportPartialFailure handles a 2xx body whose "failed" count is non-zero:
// it surfaces errors[].message through OnError and drops the events the
// ingestor refused with DropRejected. Only events identified by errors[].index
// are handed to OnDrop; failures the ingestor did not identify are counted
// without naming an event.
func (b *Billing) reportPartialFailure(respBody []byte, chunk []map[string]any) {
	var br batchResponse
	if unmarshalBatchResponse(respBody, &br) != nil || br.Failed <= 0 {
		return
	}
	failed := br.Failed
	if failed > len(chunk) {
		failed = len(chunk)
	}
	seen := make(map[int]struct{}, len(br.Errors))
	var rejected []map[string]any
	for _, e := range br.Errors {
		if e.Index == nil || *e.Index < 0 || *e.Index >= len(chunk) {
			continue
		}
		if _, dup := seen[*e.Index]; dup {
			continue
		}
		seen[*e.Index] = struct{}{}
		rejected = append(rejected, chunk[*e.Index])
	}
	if len(rejected) > failed {
		rejected = nil // response is inconsistent; do not guess
	}
	b.recordDrop(rejected, DropRejected)
	if unidentified := failed - len(rejected); unidentified > 0 {
		total := b.dropped.Add(int64(unidentified))
		log.Printf("[grpcmetering] WARN: dropped %d event(s) — %s; the ingestor did not identify them (%d total dropped).", unidentified, DropRejected, total)
	}
	b.cfg.OnError(fmt.Errorf("grpcmetering: ingestor rejected %d of %d events: %s",
		br.Failed, len(chunk), errorMessages(respBody)))
}

// errorMessages renders errors[].message ("[index] message; ...") from an
// ingestor response, falling back to the raw body.
func errorMessages(respBody []byte) string {
	var br batchResponse
	if unmarshalBatchResponse(respBody, &br) == nil && len(br.Errors) > 0 {
		msgs := make([]string, 0, len(br.Errors))
		for _, e := range br.Errors {
			if e.Index != nil {
				msgs = append(msgs, fmt.Sprintf("[%d] %s", *e.Index, e.Message))
			} else {
				msgs = append(msgs, e.Message)
			}
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

// unmarshalBatchResponse decodes a 2xx ingest response. The ingestor wraps
// every 2xx JSON body in {success, data, meta}; the inner data object is used
// when present, else the body itself (bare shape).
func unmarshalBatchResponse(body []byte, br *batchResponse) error {
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(body, &env) == nil {
		if inner := bytes.TrimSpace(env.Data); len(inner) > 0 && inner[0] == '{' {
			body = inner
		}
	}
	return json.Unmarshal(body, br)
}
