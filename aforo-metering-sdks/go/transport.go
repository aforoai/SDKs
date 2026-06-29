package metering

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
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
		url:    baseURL + "/v1/ingest/batch",
		apiKey: apiKey,
		client: &http.Client{Timeout: timeout},
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
		return FlushResult{Failed: len(events)}
	}

	for attempt := 0; attempt <= t.maxRetries; attempt++ {
		req, err := http.NewRequest("POST", t.url, bytes.NewReader(body))
		if err != nil {
			return FlushResult{Failed: len(events)}
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+t.apiKey)

		resp, err := t.client.Do(req)
		if err != nil {
			if attempt < t.maxRetries {
				time.Sleep(t.retryBase * time.Duration(1<<uint(attempt)))
				continue
			}
			return FlushResult{Failed: len(events)}
		}
		resp.Body.Close()

		status := resp.StatusCode
		if status >= 200 && status < 300 {
			return FlushResult{Sent: len(events)}
		}

		// 4xx except 408/429 — don't retry
		if status >= 400 && status < 500 && status != 408 && status != 429 {
			return FlushResult{Failed: len(events)}
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

	return FlushResult{Failed: len(events)}
}

func (t *transport) close() {
	t.client.CloseIdleConnections()
}

// formatURL builds the ingestor URL (exported for testing).
func formatURL(baseURL string) string {
	return fmt.Sprintf("%s/v1/ingest/batch", baseURL)
}
