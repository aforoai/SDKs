// Package mqttmetering ships per-event MQTT billing data from a Go MQTT
// client (paho.mqtt.golang or any other) to Aforo's usage ingestor.
//
// For broker-side metering on EMQ X 5.x, use the companion Erlang plugin
// at aforo-nextgen-docker/emqx-plugin-aforo-metering/. This Go SDK is
// for client-side metering — call from your CONNECT, PUBLISH, SUBSCRIBE,
// DISCONNECT code paths.
package mqttmetering

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/aforoai/SDKs/aforo-metering-sdks/go-mqtt/v2/internal/ingest"
)

const sdkVersion = "2.0.0"

// Ingestor limits for the MQTT fields (IngestUsageEventRequest @Size).
const (
	maxMqttTopicLen    = 500
	maxMqttClientIDLen = 128
)

// Config configures Billing. Sending defaults follow the shared transport
// policy (contract/ingest-contract.json → transportPolicy).
//
// The customer id is an argument of every Record* call: pass the Aforo
// customer you resolved from your own authentication. The SDK never derives
// it from the MQTT username or client id.
type Config struct {
	TenantID          string
	ProductID         string
	APIKey            string // sent only as X-API-Key; never logged or printed
	IngestorURL       string // must be https (http only for localhost or with AllowInsecureHTTP)
	ProductType       string // default "MQTT_BROKER"; sent as top-level productType on every event
	EmitDeliverEvents bool   // off by default — DELIVER events are high-volume

	AllowInsecureHTTP bool          // allow http:// to a host other than localhost/127.0.0.1/::1
	FlushCount        int           // events per request, default 500 (max 1000)
	FlushInterval     time.Duration // default 5s
	MaxQueueSize      int           // default 10000; when full the oldest event is dropped (DropOverflow)
	MaxRetries        int           // default 3; negative disables retries
	RetryBase         time.Duration // full-jitter backoff base, default 500ms
	Timeout           time.Duration // total deadline per request, default 10s
	ShutdownTimeout   time.Duration // how long Shutdown keeps sending, default 5s

	HTTPClient *http.Client // optional; you keep ownership
	// OnError is called for sending problems with a *TransportError (use
	// errors.As and branch on Kind: outage, auth, rejected, shutdown,
	// closed) and for events refused client-side with a plain error. It runs
	// on the background sender and may call Flush or Shutdown. Never carries
	// the API key.
	OnError func(error)
	// OnAccepted, when set, receives the body of every 2xx answer (the data
	// object, envelope removed) and the events of that request. Same
	// goroutine and panic rules as OnError.
	OnAccepted func(body json.RawMessage, events []map[string]any)
	// OnDrop is an OPT-IN hook invoked with events the SDK gives up on (see
	// DropReason). Events keep their idempotency keys, so re-submitting them
	// after recovery is dedup-safe. Default: nil (drops are still counted in
	// DroppedCount() and WARN-logged). Panics in the hook are recovered.
	OnDrop func(events []map[string]any, reason DropReason)

	hooks ingest.Hooks // tests: clock, sleep and random source
}

type Billing struct {
	cfg Config
	tp  *ingest.Client
	// truncWarned holds the label names already WARN-logged as truncated.
	truncWarned sync.Map
}

// New validates cfg and starts the background sender. Call Shutdown(ctx)
// when your client stops.
func New(cfg Config) (*Billing, error) {
	if cfg.TenantID == "" || cfg.ProductID == "" || cfg.APIKey == "" || cfg.IngestorURL == "" {
		return nil, errors.New("mqttmetering: TenantID, ProductID, APIKey, IngestorURL are required")
	}
	cfg.ProductType = normalizeProductType(cfg.ProductType)
	if cfg.ProductType == "" {
		cfg.ProductType = DefaultProductType
	}
	if cfg.OnError == nil {
		cfg.OnError = func(err error) {}
	}
	tp, err := newTransport(cfg)
	if err != nil {
		return nil, err
	}
	return &Billing{cfg: cfg, tp: tp}, nil
}

// Shutdown sends what is queued until the earlier of ctx's deadline and
// Config.ShutdownTimeout. Events still queued then are reported as
// DropShutdown and Shutdown returns an error wrapping ErrShutdownIncomplete.
// Safe to call more than once.
func (b *Billing) Shutdown(ctx context.Context) error {
	return b.shutdownTransport(ctx)
}

// Per-event recording methods — wrap these around your MQTT client API.
// Each accepts optional EventOptions (productType override, explicit
// ExecutionStatus) and has a *WithOptions form taking a single EventOptions.
//
// A blank customerID is not billed: the event is dropped as DropInvalid and
// counted. An event the ingestor would refuse (blank
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
	invalid := ""
	if customerID == "" {
		invalid = "customerId is required"
	}
	if invalid == "" && strings.TrimSpace(topic) == "" {
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
