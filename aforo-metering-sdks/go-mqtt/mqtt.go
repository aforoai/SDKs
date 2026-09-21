// Package mqttmetering ships per-event MQTT billing data from a Go MQTT
// client (paho.mqtt.golang or any other) to Aforo's usage ingestor.
//
// For broker-side metering on EMQ X 5.x, use the companion Erlang plugin
// at aforo-nextgen-docker/emqx-plugin-aforo-metering/. This Go SDK is
// for client-side metering — call from your CONNECT, PUBLISH, SUBSCRIBE,
// DISCONNECT code paths.
package mqttmetering

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"time"
)

const sdkVersion = "1.0.0"

type Config struct {
	TenantID          string
	ProductID         string
	APIKey            string
	IngestorURL       string
	EmitDeliverEvents bool          // off by default — DELIVER events are high-volume
	FlushCount        int           // default 200 — MQTT is highest volume
	FlushInterval     time.Duration // default 2s
	HTTPClient        *http.Client
	OnError           func(error)
}

type Billing struct {
	cfg    Config
	url    string
	client *http.Client

	mu     sync.Mutex
	buffer []map[string]any
	stop   chan struct{}
	wg     sync.WaitGroup
}

func New(cfg Config) (*Billing, error) {
	if cfg.TenantID == "" || cfg.ProductID == "" || cfg.APIKey == "" || cfg.IngestorURL == "" {
		return nil, errors.New("mqttmetering: TenantID, ProductID, APIKey, IngestorURL are required")
	}
	if cfg.FlushCount == 0 {
		cfg.FlushCount = 200
	}
	if cfg.FlushInterval == 0 {
		cfg.FlushInterval = 2 * time.Second
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 10 * time.Second}
	}
	if cfg.OnError == nil {
		cfg.OnError = func(err error) {}
	}
	b := &Billing{
		cfg:    cfg,
		url:    strings.TrimRight(cfg.IngestorURL, "/") + "/v1/ingest/batch",
		client: cfg.HTTPClient,
		stop:   make(chan struct{}),
	}
	b.wg.Add(1)
	go b.flushLoop()
	return b, nil
}

// Per-event recording methods — wrap these around your MQTT client API.

func (b *Billing) RecordPublish(customerID, clientID, topic string, qos int, retained bool, payloadBytes int64) {
	b.push(b.eventOf(customerID, clientID, "PUBLISH", topic, qos, retained, payloadBytes))
}

func (b *Billing) RecordDeliver(customerID, clientID, topic string, qos int, retained bool, payloadBytes int64) {
	if !b.cfg.EmitDeliverEvents {
		return
	}
	b.push(b.eventOf(customerID, clientID, "DELIVER", topic, qos, retained, payloadBytes))
}

func (b *Billing) RecordSubscribe(customerID, clientID, topicFilter string, qos int) {
	b.push(b.eventOf(customerID, clientID, "SUBSCRIBE", topicFilter, qos, false, 0))
}

func (b *Billing) RecordUnsubscribe(customerID, clientID, topicFilter string) {
	b.push(b.eventOf(customerID, clientID, "UNSUBSCRIBE", topicFilter, 0, false, 0))
}

func (b *Billing) RecordConnect(customerID, clientID string) {
	b.push(b.eventOf(customerID, clientID, "CONNECT", "", 0, false, 0))
}

func (b *Billing) RecordDisconnect(customerID, clientID string) {
	b.push(b.eventOf(customerID, clientID, "DISCONNECT", "", 0, false, 0))
}

func (b *Billing) eventOf(customerID, clientID, eventType, topic string, qos int, retained bool, bytesAmt int64) map[string]any {
	if customerID == "" {
		return nil
	}
	if len(customerID) > 64 {
		b.cfg.OnError(fmt.Errorf("mqttmetering: customerId longer than 64 chars, event dropped"))
		return nil
	}
	if topic == "" {
		switch eventType {
		case "CONNECT", "DISCONNECT":
			// mqttTopic is required for MQTT_BROKER events; session events have
			// no topic, so use the broker-style $SYS client topic.
			topic = fmt.Sprintf("$SYS/clients/%s/%s", clientID, strings.ToLower(eventType)+"ed")
		default:
			b.cfg.OnError(fmt.Errorf("mqttmetering: empty topic on %s, event dropped", eventType))
			return nil
		}
	}
	now := time.Now().UTC()
	e := map[string]any{
		"customerId":     customerID,
		"metricName":     "mqtt_broker." + strings.ToLower(eventType),
		"quantity":       1,
		"occurredAt":     now.Format(time.RFC3339Nano),
		"idempotencyKey": capKey(fmt.Sprintf("mqtt:%s:%s:%s:%s:%d:%s", b.cfg.TenantID, clientID, eventType, topic, now.UnixMilli(), randomSuffix())),
		"productType":    "MQTT_BROKER",
		"mqttTopic":      topic,
		"mqttRetained":   retained,
		"mqttEventType":  eventType,
		"mqttClientId":   clientID,
		"dataBytes":      bytesAmt,
		"metadata": map[string]any{
			"sdkVersion": sdkVersion,
			"productId":  b.cfg.ProductID,
		},
	}
	// mqttQos must be 0, 1 or 2; omit anything else instead of having the
	// ingestor reject the event.
	if qos >= 0 && qos <= 2 {
		e["mqttQos"] = qos
	}
	return e
}

func (b *Billing) push(event map[string]any) {
	if event == nil {
		return
	}
	b.mu.Lock()
	b.buffer = append(b.buffer, event)
	overflow := len(b.buffer) >= b.cfg.FlushCount
	b.mu.Unlock()
	if overflow {
		go b.flush()
	}
}

func (b *Billing) flushLoop() {
	defer b.wg.Done()
	ticker := time.NewTicker(b.cfg.FlushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			b.flush()
		case <-b.stop:
			b.flush()
			return
		}
	}
}

// maxBatchSize is the ingestor's per-request cap on POST /v1/ingest/batch.
const maxBatchSize = 1000

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
// once, so every retry carries the same idempotencyKeys.
func (b *Billing) send(chunk []map[string]any) {
	body, err := json.Marshal(map[string]any{"events": chunk})
	if err != nil {
		b.cfg.OnError(err)
		return
	}
	for attempt := 1; attempt <= 3; attempt++ {
		req, _ := http.NewRequest(http.MethodPost, b.url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", b.cfg.APIKey)
		req.Header.Set("X-Tenant-Id", b.cfg.TenantID)
		resp, err := b.client.Do(req)
		if err == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				return
			}
		} else if attempt == 3 {
			b.cfg.OnError(err)
			return
		}
		if attempt < 3 {
			time.Sleep(time.Duration(1<<(attempt-1)) * time.Second)
		}
	}
	b.cfg.OnError(fmt.Errorf("mqttmetering: flush exhausted retries (dropped %d events)", len(chunk)))
}

func (b *Billing) Shutdown() error {
	close(b.stop)
	b.wg.Wait()
	return nil
}

// capKey keeps idempotency keys within the ingestor's 255-char limit (topics
// can be up to 500 chars). The unique tail (millis + random suffix) is kept.
func capKey(k string) string {
	if len(k) > 255 {
		return k[len(k)-255:]
	}
	return k
}

var alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

func randomSuffix() string {
	out := make([]byte, 8)
	for i := range out {
		out[i] = alphabet[rand.Intn(len(alphabet))]
	}
	return string(out)
}
