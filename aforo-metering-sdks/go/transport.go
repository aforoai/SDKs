package metering

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

// transport sends batched events to the Aforo ingestor.
type transport struct {
	url        string
	apiKey     string
	client     *http.Client
	maxRetries int
	retryBase  time.Duration
}

func newTransport(baseURL, apiKey string, timeout time.Duration, maxRetries int, retryBase time.Duration) *transport {
	return &transport{
		url:        baseURL + "/v1/ingest/batch",
		apiKey:     apiKey,
		client:     &http.Client{Timeout: timeout},
		maxRetries: maxRetries,
		retryBase:  retryBase,
	}
}

func (t *transport) send(events []resolvedEvent) FlushResult {
	if len(events) == 0 {
		return FlushResult{}
	}

	body, err := json.Marshal(batchRequest{Events: events})
	if err != nil {
		return FlushResult{Failed: len(events), Reason: DropRejected}
	}

	for attempt := 0; attempt <= t.maxRetries; attempt++ {
		req, err := http.NewRequest("POST", t.url, bytes.NewReader(body))
		if err != nil {
			return FlushResult{Failed: len(events), Reason: DropRejected}
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", t.apiKey)

		resp, err := t.client.Do(req)
		if err != nil {
			if attempt < t.maxRetries {
				time.Sleep(t.retryBase * time.Duration(1<<uint(attempt)))
				continue
			}
			return FlushResult{Failed: len(events), Reason: DropRetryExhausted}
		}
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()

		status := resp.StatusCode
		if status >= 200 && status < 300 {
			// 202 body: {accepted, duplicates, failed, errors:[{index, message}]}
			var br batchResponse
			if unmarshalBatchResponse(respBody, &br) == nil && br.Failed > 0 && br.Failed <= len(events) {
				return FlushResult{
					Sent:          len(events) - br.Failed,
					Failed:        br.Failed,
					Reason:        DropRejected,
					failedIndexes: br.failedIndexes(len(events)),
				}
			}
			return FlushResult{Sent: len(events)}
		}

		// 4xx except 408/429 — don't retry
		if status >= 400 && status < 500 && status != 408 && status != 429 {
			log.Printf("[aforo] WARN: ingestor rejected batch of %d event(s) with HTTP %d: %s", len(events), status, serverMessage(respBody))
			return FlushResult{Failed: len(events), Reason: DropRejected}
		}

		// Retryable
		if attempt < t.maxRetries {
			delay := t.retryBase * time.Duration(1<<uint(attempt))
			if status == 429 {
				if ra := resp.Header.Get("Retry-After"); ra != "" {
					if secs, err := strconv.Atoi(ra); err == nil {
						delay = time.Duration(secs) * time.Second
					}
				}
			}
			time.Sleep(delay)
		}
	}

	return FlushResult{Failed: len(events), Reason: DropRetryExhausted}
}

func (t *transport) close() {
	t.client.CloseIdleConnections()
}

// formatURL builds the ingestor URL (exported for testing).
func formatURL(baseURL string) string {
	return fmt.Sprintf("%s/v1/ingest/batch", baseURL)
}

// failedIndexes returns the distinct, in-range batch positions named by the
// response's errors[] (and logs their messages). Empty when the ingestor did
// not identify the refused events.
func (br batchResponse) failedIndexes(batchLen int) []int {
	seen := make(map[int]struct{}, len(br.Errors))
	var out []int
	for _, e := range br.Errors {
		if e.Index == nil || *e.Index < 0 || *e.Index >= batchLen {
			continue
		}
		if _, dup := seen[*e.Index]; dup {
			continue
		}
		seen[*e.Index] = struct{}{}
		out = append(out, *e.Index)
		if len(out) <= 5 {
			log.Printf("[aforo] WARN: ingestor rejected event at batch index %d: %s", *e.Index, truncateForLog(e.Message))
		}
	}
	if len(out) > br.Failed {
		return nil
	}
	return out
}

// serverMessage extracts a short human-readable reason from an error body.
func serverMessage(body []byte) string {
	var parsed struct {
		Message string `json:"message"`
		Detail  string `json:"detail"`
		Error   string `json:"error"`
		Errors  []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if json.Unmarshal(body, &parsed) == nil {
		for _, e := range parsed.Errors {
			if e.Message != "" {
				return truncateForLog(e.Message)
			}
		}
		for _, m := range []string{parsed.Message, parsed.Detail, parsed.Error} {
			if m != "" {
				return truncateForLog(m)
			}
		}
	}
	return truncateForLog(strings.TrimSpace(string(body)))
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
