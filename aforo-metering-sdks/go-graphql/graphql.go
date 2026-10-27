// Package graphqlmetering ships per-operation GraphQL billing events
// from a Go GraphQL server (graphql-go, gqlgen, or any HTTP server)
// to Aforo's usage ingestor.
//
// Two integration modes:
//   - HTTP middleware: Wrap your /graphql HTTP handler with billing.Middleware()
//   - Manual:           Call billing.Record() from your custom executor
package graphqlmetering

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/aforoai/SDKs/aforo-metering-sdks/go-graphql/v2/internal/ingest"
)

const sdkVersion = "2.0.0"

// maxGqlOperationNameLen is the ingestor's limit for gqlOperationName.
const maxGqlOperationNameLen = 255

// maxCapturedResponseBytes caps how much of a GraphQL response the
// Middleware keeps to derive executionStatus. Larger responses fall back to
// the HTTP status.
const maxCapturedResponseBytes = 1 << 20

// DefaultMaxRequestBodyBytes is how much of a request body the Middleware
// reads to find the operation (Config.MaxRequestBodyBytes).
const DefaultMaxRequestBodyBytes = 1 << 20

// DefaultCustomerIDHeader is the request header read for the customer id when
// Config.TrustCustomerHeader is true and CustomerIDHeader is empty.
const DefaultCustomerIDHeader = "X-Customer-Id"

// ErrNoCustomerResolver is returned by NewMiddleware (and Middleware panics
// with it) when Config has neither a CustomerResolver nor TrustCustomerHeader.
var ErrNoCustomerResolver = errors.New("graphqlmetering: Config needs a CustomerResolver (the Aforo customer id from your own authentication: session, JWT subject, API-key lookup) or TrustCustomerHeader: true to bill the customer named in a request header that your callers control")

// Config configures Billing. Sending defaults follow the shared transport
// policy (contract/ingest-contract.json → transportPolicy).
type Config struct {
	TenantID      string
	ProductID     string
	APIKey        string // sent only as X-API-Key; never logged or printed
	IngestorURL   string // must be https (http only for localhost or with AllowInsecureHTTP)
	ProductType   string // default "GRAPHQL_API"; sent as top-level productType on every event
	SchemaVersion string // optional, attached to event metadata

	// CustomerResolver returns the Aforo customer id for a request, from
	// identity your server authenticated (session, JWT subject, API-key
	// lookup). Required for NewMiddleware / Middleware unless
	// TrustCustomerHeader is true; Record takes the customer id directly. A
	// blank result is not billed: the event is dropped as DropInvalid and
	// counted; the request itself is never blocked.
	CustomerResolver func(r *http.Request) string
	// TrustCustomerHeader bills the customer named in CustomerIDHeader. The
	// caller of your API controls that header, so only turn this on when a
	// trusted proxy sets it and strips client values. Ignored when
	// CustomerResolver is set.
	TrustCustomerHeader bool
	// CustomerIDHeader defaults to DefaultCustomerIDHeader ("X-Customer-Id").
	CustomerIDHeader string

	// MaxRequestBodyBytes caps how much of a request body Middleware reads to
	// find the operation. Default 1 MiB. A larger body is passed to your
	// handler unchanged (nothing is cut off) and the request is not metered:
	// it is dropped as DropInvalid and counted, so a huge body can never make
	// the SDK hold it in memory.
	MaxRequestBodyBytes int64

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
	cfg      Config
	tp       *ingest.Client
	customer func(r *http.Request) string
	// truncWarned holds the label names already WARN-logged as truncated.
	truncWarned sync.Map
}

// New validates cfg and starts the background sender. It returns an error
// for a non-https IngestorURL. The customer identity is checked when you
// build the middleware (NewMiddleware).
func New(cfg Config) (*Billing, error) {
	if cfg.TenantID == "" || cfg.ProductID == "" || cfg.APIKey == "" || cfg.IngestorURL == "" {
		return nil, errors.New("graphqlmetering: TenantID, ProductID, APIKey, IngestorURL are required")
	}
	customer := cfg.CustomerResolver
	if customer == nil && cfg.TrustCustomerHeader {
		header := cfg.CustomerIDHeader
		if header == "" {
			header = DefaultCustomerIDHeader
		}
		customer = func(r *http.Request) string { return r.Header.Get(header) }
	}
	cfg.ProductType = normalizeProductType(cfg.ProductType)
	if cfg.ProductType == "" {
		cfg.ProductType = DefaultProductType
	}
	if cfg.MaxRequestBodyBytes <= 0 {
		cfg.MaxRequestBodyBytes = DefaultMaxRequestBodyBytes
	}
	if cfg.OnError == nil {
		cfg.OnError = func(err error) {}
	}
	tp, err := newTransport(cfg)
	if err != nil {
		return nil, err
	}
	return &Billing{cfg: cfg, tp: tp, customer: customer}, nil
}

// gqlRequest is one GraphQL operation as sent over HTTP (POST JSON body or
// GET query string), including Automatic Persisted Queries.
type gqlRequest struct {
	Query         string `json:"query"`
	OperationName string `json:"operationName"`
	Extensions    struct {
		PersistedQuery struct {
			Sha256Hash string `json:"sha256Hash"`
		} `json:"persistedQuery"`
	} `json:"extensions"`
}

func (g gqlRequest) persistedHash() string { return g.Extensions.PersistedQuery.Sha256Hash }

// isOperation reports whether the request names a GraphQL operation: query
// text, or an APQ hash.
func (g gqlRequest) isOperation() bool {
	return strings.TrimSpace(g.Query) != "" || g.persistedHash() != ""
}

// NewMiddleware wraps next (your GraphQL handler) and meters every operation.
// It returns ErrNoCustomerResolver when Config has neither CustomerResolver
// nor TrustCustomerHeader.
//
//	mw, err := billing.NewMiddleware(gqlHandler)
//	if err != nil { log.Fatal(err) }
//	http.Handle("/graphql", mw)
func (b *Billing) NewMiddleware(next http.Handler) (http.Handler, error) {
	if b.customer == nil {
		return nil, ErrNoCustomerResolver
	}
	return b.middleware(next), nil
}

// Middleware is NewMiddleware for wiring code that cannot handle an error. It
// panics with ErrNoCustomerResolver when no customer source is configured —
// a programming error caught at startup, never at request time.
func (b *Billing) Middleware(next http.Handler) http.Handler {
	h, err := b.NewMiddleware(next)
	if err != nil {
		panic(err)
	}
	return h
}

// middleware wraps an http.Handler that serves GraphQL and emits one billing
// event per operation. It meters
//   - POST with a JSON body (one operation, or a batch array: one event each),
//   - POST with Content-Type application/graphql (the body is the query),
//   - GET with query / operationName / extensions in the URL, and
//   - Automatic Persisted Queries (an extensions.persistedQuery.sha256Hash
//     with or without the query text; the hash goes to metadata).
//
// It reads at most Config.MaxRequestBodyBytes of the body; your handler still
// receives the whole body.
//
// The operation name comes from the client's request. One longer than the
// ingestor's 255 characters is truncated (never splitting a character) and the
// event is still sent; a WARN is logged once.
//
// executionStatus is derived from the response body (see
// OutcomeFromGraphQLResponse), falling back to the HTTP status (see
// OutcomeFromHTTPStatus) when the body is not a GraphQL response or is larger
// than 1 MiB. A handler can override it with SetExecutionStatus(r.Context(), …).
func (b *Billing) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ops, tooLarge := b.readOperations(r)
		if len(ops) == 0 && !tooLarge {
			next.ServeHTTP(w, r)
			return
		}

		holder := &statusHolder{}
		r = r.WithContext(context.WithValue(r.Context(), statusHolderKey{}, holder))

		start := time.Now()
		recw := &responseRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(recw, r)

		customerID := strings.TrimSpace(b.customer(r))
		if tooLarge {
			b.dropInvalid(map[string]any{"customerId": customerID, "productType": b.cfg.ProductType},
				fmt.Sprintf("request body larger than MaxRequestBodyBytes (%d); operation not read, request not metered", b.cfg.MaxRequestBodyBytes))
			return
		}
		executionStatus := holder.get()
		if executionStatus == "" && !recw.overflow {
			executionStatus = OutcomeFromGraphQLResponse(recw.body.Bytes())
		}
		if executionStatus == "" {
			executionStatus = OutcomeFromHTTPStatus(recw.status)
		}
		elapsed := time.Since(start).Milliseconds()
		for _, op := range ops {
			if apqMiss(op, recw) {
				// The client resends this operation with its query text; that
				// request is the one billed.
				continue
			}
			b.recordOp(customerID, op, elapsed, recw.status >= 400, executionStatus, b.cfg.ProductType)
		}
	})
}

// readOperations finds the GraphQL operations in r without holding more than
// MaxRequestBodyBytes of its body. r.Body is replaced so the handler still
// reads the full, unchanged body. tooLarge is true when the body exceeded the
// limit (no operation was read).
func (b *Billing) readOperations(r *http.Request) (ops []gqlRequest, tooLarge bool) {
	switch r.Method {
	case http.MethodGet:
		q := r.URL.Query()
		op := gqlRequest{Query: q.Get("query"), OperationName: q.Get("operationName")}
		if ext := q.Get("extensions"); ext != "" {
			_ = json.Unmarshal([]byte(ext), &op.Extensions) // malformed extensions: no hash
		}
		if op.isOperation() {
			return []gqlRequest{op}, false
		}
		return nil, false
	case http.MethodPost:
	default:
		return nil, false
	}
	if r.Body == nil || r.Body == http.NoBody {
		return nil, false
	}
	limit := b.cfg.MaxRequestBodyBytes
	head, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		// The handler sees the same read error on the rest of the body.
		r.Body = readCloser{io.MultiReader(bytes.NewReader(head), r.Body), r.Body}
		return nil, false
	}
	if int64(len(head)) > limit {
		r.Body = readCloser{io.MultiReader(bytes.NewReader(head), r.Body), r.Body}
		return nil, true
	}
	r.Body = readCloser{bytes.NewReader(head), r.Body}
	if strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/graphql") {
		op := gqlRequest{Query: string(head), OperationName: r.URL.Query().Get("operationName")}
		if op.isOperation() {
			return []gqlRequest{op}, false
		}
		return nil, false
	}
	trimmed := bytes.TrimSpace(head)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		var batch []gqlRequest
		if json.Unmarshal(trimmed, &batch) != nil {
			return nil, false
		}
		for _, op := range batch {
			if op.isOperation() {
				ops = append(ops, op)
			}
		}
		return ops, false
	}
	var op gqlRequest
	if json.Unmarshal(trimmed, &op) != nil || !op.isOperation() {
		return nil, false
	}
	return []gqlRequest{op}, false
}

// apqMiss reports a hash-only persisted query the server did not know: the
// APQ protocol answers PersistedQueryNotFound and the client retries with the
// full query, so billing the first request would bill the operation twice.
func apqMiss(op gqlRequest, recw *responseRecorder) bool {
	if strings.TrimSpace(op.Query) != "" || op.persistedHash() == "" || recw.overflow {
		return false
	}
	body := recw.body.Bytes()
	return bytes.Contains(body, []byte("PersistedQueryNotFound")) || bytes.Contains(body, []byte("PERSISTED_QUERY_NOT_FOUND"))
}

// readCloser reads from r and closes the original body.
type readCloser struct {
	io.Reader
	body io.Closer
}

func (rc readCloser) Close() error { return rc.body.Close() }

// Record emits one billing event manually. Use from custom executors.
// No executionStatus is sent unless EventOptions.ExecutionStatus is set (for
// example OutcomeFromGraphQLResponse of the response you returned). Optional
// EventOptions also override the event's productType.
//
// A call with a blank customerID or query is not metered. An event the
// ingestor would refuse (a field over its limit) is not buffered: it is
// counted in DroppedCount(), WARN-logged and handed to OnDrop with DropInvalid.
// The operation name (the operationName argument, or the name read from the
// query text when it is "") originates from the client's request, so one over
// 255 characters is truncated and the event is still sent.
func (b *Billing) Record(customerID, query, operationName string, durationMs int64, hasErrors bool, opts ...EventOptions) {
	b.record(customerID, query, operationName, durationMs, hasErrors, executionStatusFor(opts), b.productTypeFor(opts))
}

// RecordWithOptions is Record with optional per-event fields.
func (b *Billing) RecordWithOptions(customerID, query, operationName string, durationMs int64, hasErrors bool, opts EventOptions) {
	b.Record(customerID, query, operationName, durationMs, hasErrors, opts)
}

func (b *Billing) record(customerID, query, operationName string, durationMs int64, hasErrors bool, executionStatus, productType string) {
	if query == "" {
		return
	}
	b.recordOp(customerID, gqlRequest{Query: query, OperationName: operationName}, durationMs, hasErrors, executionStatus, productType)
}

func (b *Billing) recordOp(customerID string, op gqlRequest, durationMs int64, hasErrors bool, executionStatus, productType string) {
	customerID = strings.TrimSpace(customerID)
	query, operationName := op.Query, op.OperationName
	opType, opName := detectOperation(query, operationName)
	complexity, fieldCount := scoreComplexity(query)

	now := time.Now().UTC()
	// The key is built from the full operation name, before truncation.
	key := idempotencyKeyFor(b.cfg.TenantID, b.cfg.ProductID, opName, now.UnixMilli(), randomSuffix())
	// The operation name always originates from the client's request (also
	// when integration code hands it to Record), so it is truncated to the
	// ingestor's limit instead of dropping the event.
	opName = b.truncateLabel("gqlOperationName", opName, maxGqlOperationNameLen)
	event := map[string]any{
		"customerId":          customerID,
		"metricName":          "graphql_api.operations",
		"quantity":            1,
		"occurredAt":          now.Format(time.RFC3339Nano),
		"idempotencyKey":      key,
		"productType":         productType,
		"gqlOperationType":    opType,
		"gqlOperationName":    opName,
		"gqlComplexity":       complexity,
		"gqlFieldCount":       fieldCount,
		"gqlHasErrors":        hasErrors,
		"executionDurationMs": durationMs,
		"metadata": withSchemaVersion(map[string]any{
			"sdkVersion": sdkVersion,
			"productId":  b.cfg.ProductID,
		}, b.cfg.SchemaVersion),
	}
	if s := normalizeExecutionStatus(executionStatus); s != "" {
		event["executionStatus"] = s
	}
	if h := op.persistedHash(); h != "" {
		event["metadata"].(map[string]any)["persistedQueryHash"] = truncate(h, 128)
	}
	if customerID == "" {
		// Not billed, but counted: no customer was resolved for this request.
		b.dropInvalid(event, "customerId is required (CustomerResolver returned nothing)")
		return
	}
	for _, c := range []struct {
		field, value string
		max          int
	}{
		{"customerId", customerID, maxCustomerIDLen},
		{"productType", productType, maxProductTypeLen},
	} {
		if msg := tooLong(c.field, c.value, c.max); msg != "" {
			b.dropInvalid(event, msg)
			return
		}
	}
	b.push(event)
}

// Shutdown sends what is queued until the earlier of ctx's deadline and
// Config.ShutdownTimeout. Events still queued then are reported as
// DropShutdown and Shutdown returns an error wrapping ErrShutdownIncomplete.
// Safe to call more than once.
func (b *Billing) Shutdown(ctx context.Context) error {
	return b.shutdownTransport(ctx)
}

// ── Helpers ──

type responseRecorder struct {
	http.ResponseWriter
	status   int
	body     bytes.Buffer
	overflow bool
}

func (r *responseRecorder) WriteHeader(code int) { r.status = code; r.ResponseWriter.WriteHeader(code) }

// Flush implements http.Flusher (subscriptions over SSE, incremental delivery).
func (r *responseRecorder) Flush() { _ = http.NewResponseController(r.ResponseWriter).Flush() }

// Hijack implements http.Hijacker (subscriptions over WebSocket).
func (r *responseRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := http.NewResponseController(r.ResponseWriter).Hijack()
	if err == nil {
		r.status = http.StatusSwitchingProtocols
	}
	return conn, rw, err
}

// Unwrap returns the wrapped writer (used by http.ResponseController).
func (r *responseRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// Write keeps a copy of the first maxCapturedResponseBytes of the response so
// the Middleware can derive executionStatus from it.
func (r *responseRecorder) Write(p []byte) (int, error) {
	if !r.overflow {
		if r.body.Len()+len(p) > maxCapturedResponseBytes {
			r.overflow = true
			r.body = bytes.Buffer{}
		} else {
			r.body.Write(p)
		}
	}
	return r.ResponseWriter.Write(p)
}

// fieldTokenRegex is compiled once; compiling per request on caller-supplied
// text was a CPU cost the caller controlled.
var fieldTokenRegex = regexp.MustCompile(`[A-Za-z_][A-Za-z0-9_]*\s*[(:{]?`)

var firstKeywordRegex = regexp.MustCompile(`^\s*(query|mutation|subscription)\b\s*([A-Za-z_][A-Za-z0-9_]*)?`)

func detectOperation(query, operationName string) (string, string) {
	matches := firstKeywordRegex.FindStringSubmatch(query)
	opType := "QUERY"
	opName := operationName
	if len(matches) >= 2 {
		opType = strings.ToUpper(matches[1])
	}
	if opName == "" && len(matches) >= 3 && matches[2] != "" {
		opName = matches[2]
	}
	if opName == "" {
		opName = "anonymous"
	}
	return opType, opName
}

// scoreComplexity = field_count + 5 * max_depth using a brace-balance approximation.
// (Lightweight — for AST-accurate scoring use graphql-go's visitor.)
func scoreComplexity(query string) (int, int) {
	depth, maxDepth, fields := 0, 0, 0
	for _, c := range query {
		switch c {
		case '{':
			depth++
			if depth > maxDepth {
				maxDepth = depth
			}
		case '}':
			if depth > 0 {
				depth--
			}
		}
	}
	// Field count = approximation — count whitespace-separated identifiers inside braces.
	// Good enough for billing scoring; SDK consumers can override via Record() with a precomputed value.
	fields = len(fieldTokenRegex.FindAllStringIndex(query, -1))
	return fields + 5*maxDepth, fields
}

func withSchemaVersion(m map[string]any, sv string) map[string]any {
	if sv != "" {
		m["schemaVersion"] = sv
	}
	return m
}

// idempotencyKeyFor returns "gql:<tenant>:<product>:<operation>:<millis>:<suffix>".
// opName must be the full, untruncated operation name; see boundedKey for what
// happens when the key would exceed 255 characters.
func idempotencyKeyFor(tenantID, productID, opName string, millis int64, suffix string) string {
	return boundedKey(fmt.Sprintf("gql:%s:%s:", tenantID, productID), opName, fmt.Sprintf(":%d:%s", millis, suffix))
}

var alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

func randomSuffix() string {
	out := make([]byte, 8)
	for i := range out {
		out[i] = alphabet[rand.Intn(len(alphabet))]
	}
	return string(out)
}
