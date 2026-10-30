// Package ingest is the transport core every Aforo Go metering SDK uses to
// send usage to the ingestor (contract/TRANSPORT-SPEC.md, contract v2).
//
// The source of truth is go/internal/ingest. scripts/sync-transport.sh copies
// these files, unchanged, into go-ws, go-mqtt, go-grpc and go-graphql; never
// edit a copy. The package imports the standard library only.
//
// One Client owns one bounded queue, one long-lived flusher goroutine and one
// pooled *http.Client. Enqueue never starts a goroutine or sends a request: it
// appends to the queue and, at the flush threshold, wakes the flusher.
package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Defaults from contract/ingest-contract.json → transportPolicy.
const (
	DefaultPath            = "/v1/ingest/batch"
	DefaultFlushCount      = 500
	MaxBatchEvents         = 1000
	DefaultTargetBodyBytes = 4 << 20
	// CompressionMinBytes: bodies smaller than this are sent plain; gzip's
	// header and dictionary cost more than they save (wave 8, G269).
	CompressionMinBytes    = 1024
	DefaultMaxQueueSize    = 10_000
	DefaultFlushInterval   = 5 * time.Second
	DefaultTimeout         = 10 * time.Second
	DefaultConnectTimeout  = 5 * time.Second
	DefaultShutdownTimeout = 5 * time.Second
	DefaultMaxRetries      = 3
	DefaultRetryBase       = 500 * time.Millisecond
	DefaultMaxRetryDelay   = 30 * time.Second
	DefaultMaxRetryAfter   = 60 * time.Second
	DefaultBreakerInitial  = 5 * time.Second
	DefaultBreakerMax      = 5 * time.Minute
)

// DropReason says why the SDK gave up on an event.
type DropReason string

const (
	DropOverflow       DropReason = "overflow"        // the queue was full; the oldest event was evicted
	DropRejected       DropReason = "rejected"        // the ingestor refused it (non-retryable 4xx, single event still 413, errors[] retryable=false)
	DropInvalid        DropReason = "invalid"         // refused client-side before it was queued
	DropShutdown       DropReason = "shutdown"        // still queued when the shutdown deadline passed
	DropClosed         DropReason = "closed"          // tracked after Close
	DropRetryExhausted DropReason = "retry_exhausted" // kept for API compatibility; the core requeues instead
)

// Errors returned by the core.
var (
	// ErrClosed is returned by Enqueue and Flush after Close.
	ErrClosed = errors.New("aforo: client is closed")
	// ErrIngestUnavailable is returned by Flush when the ingestor could not be
	// reached (or refused the API key) after the retries; the events stay
	// queued and are sent when it recovers.
	ErrIngestUnavailable = errors.New("aforo: ingestor unavailable; events kept in the queue")
	// ErrShutdownIncomplete is returned (wrapped) by Close when events were
	// still queued at the shutdown deadline; they were reported through
	// OnDrop with DropShutdown.
	ErrShutdownIncomplete = errors.New("aforo: shutdown deadline passed with events still queued")
)

// Hooks replace the clock, sleep and random source. Tests set them so retry,
// backoff and breaker behaviour never waits on the wall clock. Zero values use
// the real clock.
type Hooks struct {
	Now   func() time.Time
	Sleep func(ctx context.Context, d time.Duration) error
	// After returns a channel that fires after d and a stop function.
	After func(d time.Duration) (<-chan time.Time, func() bool)
	// Rand returns a number in [0, 1).
	Rand func() float64
}

// Config configures a Client.
type Config struct {
	BaseURL   string
	Path      string // default DefaultPath
	APIKey    string // sent only as X-API-Key
	UserAgent string // "aforo-<module>/<version>"
	// Headers are added to every request (for example X-Tenant-Id). They
	// cannot replace Content-Type, Content-Encoding, X-API-Key or User-Agent.
	Headers           map[string]string
	AllowInsecureHTTP bool // allow http:// to hosts other than localhost

	// HTTPClient is used for every request when set; the caller keeps
	// ownership. When nil the core builds one pooled client and closes its
	// idle connections on Close.
	HTTPClient *http.Client

	Timeout         time.Duration // total deadline per request, default 10 s
	FlushCount      int           // events per request, default 500, clamped to 1000
	FlushInterval   time.Duration // default 5 s
	MaxQueueSize    int           // default 10 000
	MaxRetries      int           // default 3; a negative value means no retries
	RetryBase       time.Duration // default 500 ms
	MaxRetryDelay   time.Duration // default 30 s
	MaxRetryAfter   time.Duration // default 60 s
	BreakerInitial  time.Duration // default 5 s
	BreakerMax      time.Duration // default 5 min
	ShutdownTimeout time.Duration // default 5 s
	TargetBodyBytes int           // split above this many body bytes, default 4 MiB
	// Compression is "gzip" (default; bodies of CompressionMinBytes or more are
	// sent with Content-Encoding: gzip) or "none" (always plain JSON). gzip needs
	// an ingestor that decodes it (usage-ingestor wave 8 and later).
	Compression string

	// OnDrop receives events the SDK gave up on. Panics are recovered and logged.
	OnDrop func(events []Event, reason DropReason)
	// OnError, when set, receives a *TransportError for every rejection,
	// outage, shutdown loss and track-after-close (the same dropped events
	// still go to OnDrop). Branch on Kind, never on the message. It never
	// carries the API key. It runs on the sender goroutine and may call
	// Flush or Close; panics are recovered and logged.
	OnError func(*TransportError)
	// OnAccepted, when set, receives the envelope-unwrapped body of every
	// 2xx answer and the events of that request (for example to read
	// killedSessionIds). Same goroutine and panic rules as OnError.
	OnAccepted func(body json.RawMessage, events []Event)
	// Logf receives log lines; default log.Printf. LogPrefix defaults to "[aforo]".
	Logf      func(format string, args ...any)
	LogPrefix string

	Hooks Hooks
}

// String never prints the API key.
func (c Config) String() string {
	return fmt.Sprintf("ingest.Config{BaseURL:%q, APIKey:%s, FlushCount:%d, MaxQueueSize:%d}",
		c.BaseURL, RedactKey(c.APIKey), c.FlushCount, c.MaxQueueSize)
}

// GoString never prints the API key.
func (c Config) GoString() string { return c.String() }

// RedactKey returns a placeholder for an API key; it never returns the key.
func RedactKey(key string) string {
	if key == "" {
		return `""`
	}
	return "[REDACTED]"
}

// ValidateBaseURL enforces https. Plain http is allowed for localhost,
// 127.0.0.1 and ::1, or anywhere when allowInsecure is true.
func ValidateBaseURL(raw string, allowInsecure bool) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return fmt.Errorf("aforo: base URL %q is not an absolute URL", raw)
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		return nil
	case "http":
		if allowInsecure || isLoopbackHost(u.Hostname()) {
			return nil
		}
		return fmt.Errorf("aforo: base URL %q uses plain http; use https (http is allowed only for localhost, 127.0.0.1 and ::1, or with AllowInsecureHTTP)", raw)
	default:
		return fmt.Errorf("aforo: base URL %q must use https", raw)
	}
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.Equal(net.IPv4(127, 0, 0, 1)) || ip.Equal(net.IPv6loopback))
}

func (c *Config) applyDefaults() {
	if c.Path == "" {
		c.Path = DefaultPath
	}
	if c.Timeout <= 0 {
		c.Timeout = DefaultTimeout
	}
	if c.FlushCount <= 0 {
		c.FlushCount = DefaultFlushCount
	}
	if c.FlushCount > MaxBatchEvents {
		c.FlushCount = MaxBatchEvents
	}
	if c.FlushInterval <= 0 {
		c.FlushInterval = DefaultFlushInterval
	}
	if c.MaxQueueSize <= 0 {
		c.MaxQueueSize = DefaultMaxQueueSize
	}
	if c.MaxRetries == 0 {
		c.MaxRetries = DefaultMaxRetries
	}
	if c.MaxRetries < 0 {
		c.MaxRetries = 0
	}
	if c.RetryBase <= 0 {
		c.RetryBase = DefaultRetryBase
	}
	if c.MaxRetryDelay <= 0 {
		c.MaxRetryDelay = DefaultMaxRetryDelay
	}
	if c.MaxRetryAfter <= 0 {
		c.MaxRetryAfter = DefaultMaxRetryAfter
	}
	if c.BreakerInitial <= 0 {
		c.BreakerInitial = DefaultBreakerInitial
	}
	if c.BreakerMax < c.BreakerInitial {
		c.BreakerMax = DefaultBreakerMax
		if c.BreakerMax < c.BreakerInitial {
			c.BreakerMax = c.BreakerInitial
		}
	}
	if c.ShutdownTimeout <= 0 {
		c.ShutdownTimeout = DefaultShutdownTimeout
	}
	if c.TargetBodyBytes <= 0 {
		c.TargetBodyBytes = DefaultTargetBodyBytes
	}
	if c.Compression == "" {
		c.Compression = "gzip"
	}
	if c.Logf == nil {
		c.Logf = log.Printf
	}
	if c.LogPrefix == "" {
		c.LogPrefix = "[aforo]"
	}
	if c.Hooks.Now == nil {
		c.Hooks.Now = time.Now
	}
	if c.Hooks.Rand == nil {
		c.Hooks.Rand = rand.Float64
	}
	if c.Hooks.After == nil {
		c.Hooks.After = func(d time.Duration) (<-chan time.Time, func() bool) {
			t := time.NewTimer(d)
			return t.C, t.Stop
		}
	}
	if c.Hooks.Sleep == nil {
		after := c.Hooks.After
		c.Hooks.Sleep = func(ctx context.Context, d time.Duration) error {
			if d <= 0 {
				return ctx.Err()
			}
			ch, stop := after(d)
			defer stop()
			select {
			case <-ch:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
}

// newPooledHTTPClient builds the one HTTP client a Client reuses for every
// request: keep-alive pool, connect timeout, total request timeout.
func newPooledHTTPClient(timeout time.Duration) *http.Client {
	tr := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: DefaultConnectTimeout, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          10,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   DefaultConnectTimeout,
		ExpectContinueTimeout: time.Second,
	}
	return &http.Client{Timeout: timeout, Transport: tr, CheckRedirect: refuseRedirect}
}

// refuseRedirect stops the HTTP client from following a 3xx: the API key must
// never reach another host. The 3xx is returned to the caller as is.
func refuseRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

// withoutRedirects returns a copy of a caller-supplied client that never
// follows redirects. The copy shares the caller's Transport (and its pool);
// the caller's own client is not changed.
func withoutRedirects(hc *http.Client) *http.Client {
	cp := *hc
	cp.CheckRedirect = refuseRedirect
	return &cp
}

// ErrorKind classifies a TransportError.
type ErrorKind string

const (
	KindOutage   ErrorKind = "outage"   // ingestor unreachable, 5xx/408/429 after the retries, or a redirect; events kept queued
	KindAuth     ErrorKind = "auth"     // 401/403: API key wrong or revoked; events kept queued
	KindRejected ErrorKind = "rejected" // the ingestor refused events; they went to OnDrop as rejected
	KindShutdown ErrorKind = "shutdown" // still queued at the shutdown deadline; reported as shutdown
	KindClosed   ErrorKind = "closed"   // tracked after Close; reported as closed
)

// TransportError is what OnError receives. Events are the events concerned
// (requeued for outage/auth, dropped for the other kinds). Status is the
// HTTP status when one caused it, else 0. Message never carries the API key.
type TransportError struct {
	Kind    ErrorKind
	Status  int
	Message string
	Events  []Event
}

func (e *TransportError) Error() string { return e.Message }

// Unwrap lets errors.Is match the sentinel errors for each kind.
func (e *TransportError) Unwrap() error {
	switch e.Kind {
	case KindOutage, KindAuth:
		return ErrIngestUnavailable
	case KindShutdown:
		return ErrShutdownIncomplete
	case KindClosed:
		return ErrClosed
	}
	return nil
}
