// Package mqttmetering ships per-event MQTT billing data from a Go MQTT
// client (paho.mqtt.golang or any other) to Aforo's usage ingestor.
//
// For broker-side metering on EMQ X 5.x, use the companion Erlang plugin
// at aforo-nextgen-docker/emqx-plugin-aforo-metering/. This Go SDK is
// for client-side metering — call from your CONNECT, PUBLISH, SUBSCRIBE,
// DISCONNECT code paths.
package mqttmetering

import (
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const sdkVersion = "1.2.2"

// Ingestor limits for the MQTT fields (IngestUsageEventRequest @Size).
const (
	maxMqttTopicLen    = 500
	maxMqttClientIDLen = 128
)

// DropReason describes why a buffered batch was permanently dropped.
// The buffer is unbounded (drained at flush start), so unlike the core SDK
// there is no overflow reason here.
type DropReason string

const (
	// DropRetryExhausted — the batch failed after all transport retries.
	DropRetryExhausted DropReason = "retry_exhausted"
	// DropRejected — the ingestor answered a non-retryable 4xx, refused the
	// event individually in a 2xx partial-failure response, or the batch
	// could not be serialized.
	DropRejected DropReason = "rejected"
	// DropInvalid — the event failed client-side validation (a required field
	// was blank or a field exceeded the ingestor's limit) and was never
	// buffered.
	DropInvalid DropReason = "invalid"
)

type Config struct {
	TenantID          string
	ProductID         string
	APIKey            string
	IngestorURL       string
	ProductType       string        // default "MQTT_BROKER"; sent as top-level productType on every event
	EmitDeliverEvents bool          // off by default — DELIVER events are high-volume
	FlushCount        int           // default 200 — MQTT is highest volume
	FlushInterval     time.Duration // default 2s
	HTTPClient        *http.Client
	OnError           func(error)
	// OnDrop is an OPT-IN hook invoked with events the SDK is about to lose
	// permanently (retry exhaustion, a rejection by the ingestor, or
	// client-side validation — see DropReason). Events keep
	// their idempotency keys, so re-submitting them after recovery is
	// dedup-safe. Default: nil (drops are still counted in DroppedCount()
	// and WARN-logged). Panics in the hook are recovered.
	OnDrop func(events []map[string]any, reason DropReason)
}

type Billing struct {
	cfg    Config
	url    string
	client *http.Client

	mu       sync.Mutex
	buffer   []map[string]any
	stop     chan struct{}
	stopOnce sync.Once
	dropped  atomic.Int64
	// invalidDrops throttles the DropInvalid WARN log.
	invalidDrops atomic.Int64
	// truncWarned holds the label names already WARN-logged as truncated.
	truncWarned sync.Map
	// retryBackoffBase is the exponential-backoff base (default 1s) —
	// package-private so tests can skip real sleeps.
	retryBackoffBase time.Duration
	wg               sync.WaitGroup
}

func New(cfg Config) (*Billing, error) {
	if cfg.TenantID == "" || cfg.ProductID == "" || cfg.APIKey == "" || cfg.IngestorURL == "" {
		return nil, errors.New("mqttmetering: TenantID, ProductID, APIKey, IngestorURL are required")
	}
	cfg.ProductType = normalizeProductType(cfg.ProductType)
	if cfg.ProductType == "" {
		cfg.ProductType = DefaultProductType
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
		cfg:              cfg,
		url:              strings.TrimRight(cfg.IngestorURL, "/") + "/v1/ingest/batch",
		client:           cfg.HTTPClient,
		stop:             make(chan struct{}),
		retryBackoffBase: time.Second,
	}
	b.wg.Add(1)
	go b.flushLoop()
	return b, nil
}

// Per-event recording methods — wrap these around your MQTT client API.
// Each accepts optional EventOptions (productType override, explicit
// ExecutionStatus) and has a *WithOptions form taking a single EventOptions.
//
// A blank customerID is not metered. An event the ingestor would refuse (blank
// topic on a topic event, a field over its limit) is not buffered: it is
// counted in DroppedCount(), WARN-logged and handed to OnDrop with DropInvalid.
// topic and clientID are the exception: they originate from the MQTT client,
// so a topic over 500 or a client id over 128 characters is truncated and the
// event is still sent.

func (b *Billing) RecordPublish(customerID, clientID, topic string, qos int, retained bool, payloadBytes int64, opts ...EventOptions) {
	b.push(b.eventOf(customerID, clientID, "PUBLISH", topic, qos, retained, payloadBytes, opts))
}

func (b *Billing) RecordPublishWithOptions(customerID, clientID, topic string, qos int, retained bool, payloadBytes int64, opts EventOptions) {
	b.RecordPublish(customerID, clientID, topic, qos, retained, payloadBytes, opts)
}

func (b *Billing) RecordDeliver(customerID, clientID, topic string, qos int, retained bool, payloadBytes int64, opts ...EventOptions) {
	if !b.cfg.EmitDeliverEvents {
		return
	}
	b.push(b.eventOf(customerID, clientID, "DELIVER", topic, qos, retained, payloadBytes, opts))
}

func (b *Billing) RecordDeliverWithOptions(customerID, clientID, topic string, qos int, retained bool, payloadBytes int64, opts EventOptions) {
	b.RecordDeliver(customerID, clientID, topic, qos, retained, payloadBytes, opts)
}

func (b *Billing) RecordSubscribe(customerID, clientID, topicFilter string, qos int, opts ...EventOptions) {
	b.push(b.eventOf(customerID, clientID, "SUBSCRIBE", topicFilter, qos, false, 0, opts))
}

func (b *Billing) RecordSubscribeWithOptions(customerID, clientID, topicFilter string, qos int, opts EventOptions) {
	b.RecordSubscribe(customerID, clientID, topicFilter, qos, opts)
}

func (b *Billing) RecordUnsubscribe(customerID, clientID, topicFilter string, opts ...EventOptions) {
	b.push(b.eventOf(customerID, clientID, "UNSUBSCRIBE", topicFilter, 0, false, 0, opts))
}

func (b *Billing) RecordUnsubscribeWithOptions(customerID, clientID, topicFilter string, opts EventOptions) {
	b.RecordUnsubscribe(customerID, clientID, topicFilter, opts)
}

func (b *Billing) RecordConnect(customerID, clientID string, opts ...EventOptions) {
	b.push(b.eventOf(customerID, clientID, "CONNECT", "", 0, false, 0, opts))
}

func (b *Billing) RecordConnectWithOptions(customerID, clientID string, opts EventOptions) {
	b.RecordConnect(customerID, clientID, opts)
}

func (b *Billing) RecordDisconnect(customerID, clientID string, opts ...EventOptions) {
	b.push(b.eventOf(customerID, clientID, "DISCONNECT", "", 0, false, 0, opts))
}

func (b *Billing) RecordDisconnectWithOptions(customerID, clientID string, opts EventOptions) {
	b.RecordDisconnect(customerID, clientID, opts)
}

func (b *Billing) eventOf(customerID, clientID, eventType, topic string, qos int, retained bool, bytesAmt int64, opts []EventOptions) map[string]any {
	customerID = strings.TrimSpace(customerID)
	if customerID == "" {
		return nil
	}
	invalid := ""
	if strings.TrimSpace(topic) == "" {
		switch eventType {
		case "CONNECT", "DISCONNECT":
			// mqttTopic is required for MQTT_BROKER events; session events have
			// no topic, so use the broker-style $SYS client topic.
			topic = fmt.Sprintf("$SYS/clients/%s/%s", clientID, strings.ToLower(eventType)+"ed")
		default:
			invalid = fmt.Sprintf("mqttTopic is required on %s (got %q)", eventType, truncate(topic, 80))
		}
	}
	now := time.Now().UTC()
	// The key is built from the full topic and client id, before truncation.
	key := idempotencyKeyFor(b.cfg.TenantID, clientID, eventType, topic, now.UnixMilli(), randomSuffix())
	// Topic and client id always originate from the MQTT client's message
	// (integration code only hands them on), so they are truncated to the
	// ingestor's limits instead of dropping the event.
	topic = b.truncateLabel("mqttTopic", topic, maxMqttTopicLen)
	clientID = b.truncateLabel("mqttClientId", clientID, maxMqttClientIDLen)
	e := map[string]any{
		"customerId":     customerID,
		"metricName":     "mqtt_broker." + strings.ToLower(eventType),
		"quantity":       1,
		"occurredAt":     now.Format(time.RFC3339Nano),
		"idempotencyKey": key,
		"productType":    b.productTypeFor(opts),
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
	withExecutionStatus(e, executionStatusFor(opts))
	// An event the ingestor would refuse is dropped here (DropInvalid)
	// instead of failing server-side unseen. customerId and productType are
	// never truncated.
	if invalid == "" {
		for _, c := range []struct {
			field, value string
			max          int
		}{
			{"customerId", customerID, maxCustomerIDLen},
			{"productType", e["productType"].(string), maxProductTypeLen},
		} {
			if invalid = tooLong(c.field, c.value, c.max); invalid != "" {
				break
			}
		}
	}
	if invalid != "" {
		b.dropInvalid(e, invalid)
		return nil
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

func (b *Billing) Shutdown() error {
	b.stopOnce.Do(func() { close(b.stop) })
	b.wg.Wait()
	return nil
}

// idempotencyKeyFor returns
// "mqtt:<tenant>:<clientId>:<eventType>:<topic>:<millis>:<suffix>". A topic can
// be 500 characters, so the key can exceed the ingestor's 255; see boundedKey
// for what happens then (the topic is digested, the key is never cut).
func idempotencyKeyFor(tenantID, clientID, eventType, topic string, millis int64, suffix string) string {
	return boundedKey(fmt.Sprintf("mqtt:%s:%s:%s:", tenantID, clientID, eventType), topic, fmt.Sprintf(":%d:%s", millis, suffix))
}

var alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

func randomSuffix() string {
	out := make([]byte, 8)
	for i := range out {
		out[i] = alphabet[rand.Intn(len(alphabet))]
	}
	return string(out)
}
