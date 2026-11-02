package ingest

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// sendOutcome is what happened to one batch.
type sendOutcome struct {
	sent       int
	rejected   int
	retry      []Event // to requeue at the front (keys kept)
	outage     bool    // retries exhausted, 401/403, a 3xx or the context ended
	authStatus int     // 401 or 403 when that caused the outage
	redirect   int     // the 3xx status when a redirect caused the outage
	location   string  // the redirect target host (never the key)
	status     int     // the last HTTP status seen, 0 for a network error
	cause      string  // the last failure, for logs and OnError
}

// encodeBatch builds {"events":[...]} from pre-serialized events.
func encodeBatch(events []Event) []byte {
	n := len(`{"events":[]}`)
	for _, e := range events {
		n += len(e.Body) + 1
	}
	var b bytes.Buffer
	b.Grow(n)
	b.WriteString(`{"events":[`)
	for i, e := range events {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(e.Body)
	}
	b.WriteString(`]}`)
	return b.Bytes()
}

// sendBatch posts one batch with retries. 413 splits it; 2xx per-event
// failures go back to the queue (retryable) or are reported (not retryable).
func (c *Client) sendBatch(ctx context.Context, events []Event) sendOutcome {
	// Compressed once; every retry sends the same bytes.
	body, gzipped := c.encodeBody(encodeBatch(events))
	for attempt := 0; ; attempt++ {
		status, header, respBody, err := c.post(ctx, body, gzipped)
		if err == nil && status >= 300 && status < 400 {
			// Never followed (the key must not reach another host): an outage,
			// logged at ERROR with the target host. Fixing the base URL recovers.
			host := redirectHost(header.Get("Location"))
			return sendOutcome{retry: events, outage: true, redirect: status, location: host, status: status,
				cause: fmt.Sprintf("HTTP %d redirect to %s; redirects are not followed", status, host)}
		}
		if err != nil && ctx.Err() != nil {
			// Shutdown deadline (or Close) cut the request off.
			return sendOutcome{retry: events, outage: true, cause: "request cut off by the shutdown deadline"}
		}
		var retryAfter time.Duration
		var hasRetryAfter bool
		cause := ""
		switch {
		case err != nil:
			// network error or timeout: retryable
			cause = truncate(err.Error(), 200)
		case status >= 200 && status < 300:
			return c.handleAccepted(events, respBody)
		case status == http.StatusRequestEntityTooLarge:
			if len(events) == 1 {
				c.logf("WARN: the ingestor refused an event as too large (HTTP 413).")
				c.reportError(KindRejected, status, events, "ingestor rejected an event as too large (HTTP 413)")
				c.Report(events, DropRejected)
				return sendOutcome{rejected: 1}
			}
			mid := len(events) / 2
			first := c.sendBatch(ctx, events[:mid])
			if first.outage {
				first.retry = append(first.retry, events[mid:]...)
				return first
			}
			second := c.sendBatch(ctx, events[mid:])
			second.sent += first.sent
			second.rejected += first.rejected
			second.retry = append(first.retry, second.retry...)
			return second
		case status == http.StatusUnauthorized || status == http.StatusForbidden:
			return sendOutcome{retry: events, outage: true, authStatus: status, status: status, cause: fmt.Sprintf("HTTP %d: API key wrong or revoked", status)}
		case isRetryableStatus(status):
			retryAfter, hasRetryAfter = ParseRetryAfter(header.Get("Retry-After"), c.cfg.Hooks.Now())
			cause = fmt.Sprintf("HTTP %d", status)
		default:
			msg := serverMessage(respBody)
			c.logf("WARN: the ingestor rejected a batch of %d event(s) with HTTP %d: %s", len(events), status, msg)
			c.reportError(KindRejected, status, events, "ingestor rejected batch of %d events with HTTP %d: %s", len(events), status, msg)
			c.Report(events, DropRejected)
			return sendOutcome{rejected: len(events)}
		}
		if attempt >= c.cfg.MaxRetries {
			return sendOutcome{retry: events, outage: true, status: status, cause: cause}
		}
		if err := c.cfg.Hooks.Sleep(ctx, c.retryDelay(attempt, retryAfter, hasRetryAfter)); err != nil {
			return sendOutcome{retry: events, outage: true, status: status, cause: cause}
		}
	}
}

// isRetryableStatus: 408, 429 and every 5xx (not only 500/502/503/504).
func isRetryableStatus(status int) bool {
	return status == 408 || status == 429 || (status >= 500 && status < 600)
}

// redirectHost returns the host of a Location value for the log line, or
// "an unknown location". Query strings and paths are left out.
func redirectHost(location string) string {
	if u, err := url.Parse(strings.TrimSpace(location)); err == nil && u.Host != "" {
		return u.Host
	}
	if strings.TrimSpace(location) != "" {
		return "a relative location on the same host"
	}
	return "an unknown location"
}

// post sends one request. rctx bounds the whole exchange — connect, headers
// and reading the body — so a server that stalls mid-body or drips bytes is
// cut off at Timeout (or the shutdown deadline, whichever is first). A body
// cut off on a 2xx is returned as an error: the batch is retried with the
// same keys (the ingestor deduplicates) rather than guessed delivered.
// encodeBody gzips json when compression is on and the body is at least
// CompressionMinBytes (wave 8, G269). A compression failure sends the JSON as
// it is, never drops the batch.
func (c *Client) encodeBody(json []byte) ([]byte, bool) {
	if c.cfg.Compression != "gzip" || len(json) < CompressionMinBytes {
		return json, false
	}
	var b bytes.Buffer
	b.Grow(len(json) / 4)
	w := gzip.NewWriter(&b)
	if _, err := w.Write(json); err != nil {
		c.logf("DEBUG: gzip failed, sending uncompressed: %v", err)
		return json, false
	}
	if err := w.Close(); err != nil {
		c.logf("DEBUG: gzip failed, sending uncompressed: %v", err)
		return json, false
	}
	return b.Bytes(), true
}

func (c *Client) post(ctx context.Context, body []byte, gzipped bool) (int, http.Header, []byte, error) {
	rctx, cancel := context.WithTimeout(ctx, c.cfg.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return 0, nil, nil, err
	}
	for k, v := range c.cfg.Headers {
		req.Header.Set(k, v)
	}
	req.Header.Set("Content-Type", "application/json")
	if gzipped {
		req.Header.Set("Content-Encoding", "gzip")
	} else {
		req.Header.Del("Content-Encoding")
	}
	req.Header.Set("X-API-Key", c.cfg.APIKey)
	if c.cfg.UserAgent != "" {
		req.Header.Set("User-Agent", c.cfg.UserAgent)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, nil, scrubKey(err, c.cfg.APIKey)
	}
	defer resp.Body.Close()
	respBody, rerr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if rerr != nil {
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return 0, nil, nil, scrubKey(fmt.Errorf("reading the %d response body: %w", resp.StatusCode, rerr), c.cfg.APIKey)
		}
		c.logf("DEBUG: could not read the HTTP %d response body: %v", resp.StatusCode, scrubKey(rerr, c.cfg.APIKey))
	}
	return resp.StatusCode, resp.Header, respBody, nil
}

// scrubKey makes sure no error string carries the API key.
func scrubKey(err error, key string) error {
	if key == "" || !strings.Contains(err.Error(), key) {
		return err
	}
	return errors.New(strings.ReplaceAll(err.Error(), key, "[REDACTED]"))
}

type batchResponse struct {
	Accepted   int `json:"accepted"`
	Duplicates int `json:"duplicates"`
	Failed     int `json:"failed"`
	Errors     []struct {
		Index     *int   `json:"index"`
		Message   string `json:"message"`
		Retryable bool   `json:"retryable"`
	} `json:"errors"`
}

// handleAccepted reads a 2xx body. errors[] is authoritative, whatever
// `failed` says: events it names with retryable true go back to the queue,
// the others are reported as rejected. Failures counted in `failed` beyond
// the named ones are counted and logged, never guessed.
func (c *Client) handleAccepted(events []Event, respBody []byte) sendOutcome {
	c.callOnAccepted(unwrapEnvelope(respBody), events)
	var br batchResponse
	if unmarshalBatchResponse(respBody, &br) != nil {
		return sendOutcome{sent: len(events)}
	}
	seen := make(map[int]bool, len(br.Errors))
	var retry, rejected []Event
	logged := 0
	for _, e := range br.Errors {
		if e.Index == nil || *e.Index < 0 || *e.Index >= len(events) || seen[*e.Index] {
			continue
		}
		seen[*e.Index] = true
		if e.Retryable {
			retry = append(retry, events[*e.Index])
			continue
		}
		rejected = append(rejected, events[*e.Index])
		if logged < 5 {
			c.logf("WARN: the ingestor rejected the event at batch index %d: %s", *e.Index, truncate(e.Message, 200))
			logged++
		}
	}
	named := len(retry) + len(rejected)
	unidentified := br.Failed - named
	if unidentified < 0 {
		unidentified = 0
	}
	if unidentified > len(events)-named {
		unidentified = len(events) - named
	}
	if len(rejected) > 0 || unidentified > 0 {
		c.reportError(KindRejected, 0, rejected, "ingestor rejected %d of %d events: %s", len(rejected)+unidentified, len(events), serverMessage(respBody))
	}
	c.Report(rejected, DropRejected)
	if unidentified > 0 {
		total := c.dropped.Add(int64(unidentified))
		c.logf("WARN: the ingestor refused %d event(s) without naming them (%d dropped in total).", unidentified, total)
	}
	return sendOutcome{
		sent:     len(events) - named - unidentified,
		rejected: len(rejected) + unidentified,
		retry:    retry,
	}
}

// unwrapEnvelope returns data from {success, data, meta}, else the body.
func unwrapEnvelope(body []byte) json.RawMessage {
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(body, &env) == nil {
		if inner := bytes.TrimSpace(env.Data); len(inner) > 0 {
			return json.RawMessage(inner)
		}
	}
	return json.RawMessage(bytes.TrimSpace(body))
}

// unmarshalBatchResponse reads {success, data, meta} or the bare shape.
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

// serverMessage extracts a short reason from an error body.
func serverMessage(body []byte) string {
	var parsed struct {
		Message string `json:"message"`
		Detail  string `json:"detail"`
		Title   string `json:"title"`
		Error   string `json:"error"`
		Errors  []struct {
			Index   *int   `json:"index"`
			Message string `json:"message"`
		} `json:"errors"`
		Data *struct {
			Errors []struct {
				Index   *int   `json:"index"`
				Message string `json:"message"`
			} `json:"errors"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &parsed) == nil {
		errs := parsed.Errors
		if len(errs) == 0 && parsed.Data != nil {
			errs = parsed.Data.Errors
		}
		var msgs []string
		for _, e := range errs {
			if e.Message == "" {
				continue
			}
			if e.Index != nil {
				msgs = append(msgs, fmt.Sprintf("[%d] %s", *e.Index, e.Message))
			} else {
				msgs = append(msgs, e.Message)
			}
		}
		if len(msgs) > 0 {
			return truncate(strings.Join(msgs, "; "), 1024)
		}
		for _, m := range []string{parsed.Detail, parsed.Message, parsed.Title, parsed.Error} {
			if m != "" {
				return truncate(m, 200)
			}
		}
	}
	return truncate(strings.TrimSpace(string(body)), 200)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
