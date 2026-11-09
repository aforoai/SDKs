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
	"strings"
	"sync"
	"time"

	"github.com/aforoai/SDKs/aforo-metering-sdks/go-graphql/v2/internal/ingest"
)

const sdkVersion = "2.1.1"

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
	Compression       string        // "gzip" (default; 1 KiB+ batches gzip-encoded, needs usage-ingestor wave 8+) or "none"
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
//
// gqlHasErrors is true when the response body carries GraphQL errors (the
// statuses PARTIAL, ERROR and VALIDATION_FAILED above), also under HTTP 200,
// or when the HTTP status is 400 or more.
//
// gqlComplexity and gqlFieldCount cover only the operation that runs
// (operationName, else the first) and the fragments it spreads.
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

		customerID, resolverErr := b.resolveCustomer(r)
		if resolverErr != "" {
			// A resolver that panics: not billed, counted as invalid; the
			// request was already served.
			for i := 0; i < len(ops) || i == 0; i++ {
				b.dropInvalid(map[string]any{"productType": b.cfg.ProductType}, resolverErr)
			}
			return
		}
		if tooLarge {
			b.dropInvalid(map[string]any{"customerId": customerID, "productType": b.cfg.ProductType},
				fmt.Sprintf("request body larger than MaxRequestBodyBytes (%d); operation not read, request not metered", b.cfg.MaxRequestBodyBytes))
			return
		}
		bodyOutcome := ""
		if !recw.overflow {
			bodyOutcome = OutcomeFromGraphQLResponse(recw.body.Bytes())
		}
		executionStatus := holder.get()
		if executionStatus == "" {
			executionStatus = bodyOutcome
		}
		if executionStatus == "" {
			executionStatus = OutcomeFromHTTPStatus(recw.status)
		}
		// gqlHasErrors follows the response the client got: errors in the
		// GraphQL body (PARTIAL, ERROR, VALIDATION_FAILED), also under HTTP
		// 200, or an HTTP error status. A SetExecutionStatus override does not
		// change it.
		hasErrors := recw.status >= 400 || outcomeHasErrors(bodyOutcome)
		elapsed := time.Since(start).Milliseconds()
		for _, op := range ops {
			if apqMiss(op, recw) {
				// The client resends this operation with its query text; that
				// request is the one billed.
				continue
			}
			b.recordOp(customerID, op, elapsed, hasErrors, executionStatus, b.cfg.ProductType)
		}
	})
}

// resolveCustomer runs the resolver, turning a panic into the reason to drop
// the event as DropInvalid.
func (b *Billing) resolveCustomer(r *http.Request) (id, failure string) {
	defer func() {
		if rec := recover(); rec != nil {
			id, failure = "", fmt.Sprintf("CustomerResolver panicked: %v", rec)
		}
	}()
	return strings.TrimSpace(b.customer(r)), ""
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
	complexity, fieldCount := scoreOperation(query, operationName)

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

// detectOperation returns the type and name of the operation the request
// runs: the one named operationName when the document holds it, else the
// first operation. Comments, fragment definitions, strings and nested braces
// are skipped, so "# note\nmutation M {…}" and "fragment F on T {…} mutation
// M {…}" are mutations.
func detectOperation(query, operationName string) (string, string) {
	ops, _ := definitionsOf(query)
	opType, opName := "QUERY", operationName
	if chosen := chooseOperation(ops, operationName); chosen >= 0 {
		opType = ops[chosen].typ
		if opName == "" {
			opName = ops[chosen].name
		}
	}
	if opName == "" {
		opName = "anonymous"
	}
	return opType, opName
}

// chooseOperation returns the index of the operation named operationName,
// else of the first operation, else -1.
func chooseOperation(ops []opDef, operationName string) int {
	if operationName != "" {
		for i, op := range ops {
			if op.name == operationName {
				return i
			}
		}
	}
	if len(ops) > 0 {
		return 0
	}
	return -1
}

// opDef is one operation definition. body is the byte range of its top-level
// selection set ("{" through the matching "}"); body[1] is 0 while unknown.
type opDef struct {
	typ, name string
	body      [2]int
}

// definitionsOf lists the operation definitions of a GraphQL document, in
// order, and the selection-set byte range of each fragment definition by
// name. It is a single pass over the text: top-level keywords are read only
// outside selection sets, parentheses, strings and comments.
func definitionsOf(doc string) ([]opDef, map[string][2]int) {
	var ops []opDef
	frags := map[string][2]int{}
	braces, parens := 0, 0
	pending := ""         // "op" after query/mutation/subscription, "fragment" after fragment
	wantName := false     // the next top-level name is the operation's name
	wantFragName := false // the next top-level name is the fragment's name
	afterAt := false      // the next name is a directive name
	fragName := ""
	open := -1 // index of the top-level "{" of the definition being read
	openFrag := ""
	openOp := -1
	for i := 0; i < len(doc); {
		c := doc[i]
		switch {
		case c == '#':
			for i < len(doc) && doc[i] != '\n' && doc[i] != '\r' {
				i++
			}
			continue
		case c == '"':
			i = skipString(doc, i)
			continue
		case c == '{':
			if braces == 0 && parens == 0 {
				if pending == "" { // shorthand query: { field }
					ops = append(ops, opDef{typ: "QUERY"})
				}
				open, openOp, openFrag = i, -1, ""
				if pending == "fragment" {
					openFrag = fragName
				} else {
					openOp = len(ops) - 1
				}
				pending, wantName, wantFragName, fragName = "", false, false, ""
			}
			braces++
		case c == '}':
			if braces > 0 {
				braces--
				if braces == 0 && open >= 0 {
					if openOp >= 0 {
						ops[openOp].body = [2]int{open, i + 1}
					} else if openFrag != "" {
						if _, dup := frags[openFrag]; !dup {
							frags[openFrag] = [2]int{open, i + 1}
						}
					}
					open = -1
				}
			}
		case c == '(':
			parens++
			wantName = false
		case c == ')':
			if parens > 0 {
				parens--
			}
		case c == '@':
			afterAt, wantName, wantFragName = true, false, false
		case c == '_' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z':
			j := i + 1
			for j < len(doc) && (doc[j] == '_' || doc[j] >= 'A' && doc[j] <= 'Z' || doc[j] >= 'a' && doc[j] <= 'z' || doc[j] >= '0' && doc[j] <= '9') {
				j++
			}
			word := doc[i:j]
			i = j
			if braces != 0 || parens != 0 {
				continue
			}
			switch {
			case afterAt:
				afterAt = false
			case wantName:
				ops[len(ops)-1].name = word
				wantName = false
			case wantFragName:
				fragName = word
				wantFragName = false
			case pending == "" && (word == "query" || word == "mutation" || word == "subscription"):
				ops = append(ops, opDef{typ: strings.ToUpper(word)})
				pending, wantName = "op", true
			case pending == "" && word == "fragment":
				pending, wantFragName = "fragment", true
			}
			continue
		}
		i++
	}
	return ops, frags
}

// maxScore is the largest gqlComplexity / gqlFieldCount the ingestor stores
// (a Java int). Fragments spread inside fragments can multiply past it.
const maxScore = 1<<31 - 1

// scoreOperation returns (complexity, fieldCount) of the operation the
// request runs (operationName's, else the first): complexity is
// fieldCount + 5 × maxDepth. Only fields count: arguments, aliases,
// directives, the operation keyword, its name and its variable definitions do
// not. Other operations in the document and fragments it does not use are not
// counted. Each fragment spread counts the fragment's fields where it is
// spread (a fragment spread twice runs twice); inline fragments and spreads
// add no depth. A fragment's size is worked out once, so nested spreads cost
// linear time; a spread of an unknown fragment, or one that spreads itself,
// counts nothing. Both numbers are capped at 2³¹−1. The same rules as the
// Java, Python and Node SDKs.
func scoreOperation(query, operationName string) (int, int) {
	ops, frags := definitionsOf(query)
	chosen := chooseOperation(ops, operationName)
	if chosen < 0 || ops[chosen].body[1] == 0 {
		return 0, 0
	}
	s := &scorer{doc: query, frags: frags, sizes: map[string][2]int64{}, inProgress: map[string]bool{}}
	fields, depth, _ := s.selectionSet(ops[chosen].body[0])
	return int(clampScore(fields + 5*depth)), int(fields)
}

func clampScore(n int64) int64 {
	if n > maxScore {
		return maxScore
	}
	return n
}

type scorer struct {
	doc        string
	frags      map[string][2]int
	sizes      map[string][2]int64 // fragment name -> {fields, depth}
	inProgress map[string]bool
}

// fragmentSize is the field count and depth of a fragment's selection set,
// worked out once per fragment.
func (s *scorer) fragmentSize(name string) (int64, int64) {
	if known, ok := s.sizes[name]; ok {
		return known[0], known[1]
	}
	span, ok := s.frags[name]
	if !ok || s.inProgress[name] {
		return 0, 0
	}
	s.inProgress[name] = true
	f, d, _ := s.selectionSet(span[0])
	delete(s.inProgress, name)
	s.sizes[name] = [2]int64{f, d}
	return f, d
}

// selectionSet measures the selection set whose "{" is at pos and returns
// its field count, its depth and the position after its "}".
func (s *scorer) selectionSet(pos int) (fields, depth int64, end int) {
	tok, kind, next := gqlToken(s.doc, pos)
	if kind != tokPunct || tok != "{" {
		return 0, 0, pos
	}
	pos = next
	for {
		tok, kind, next = gqlToken(s.doc, pos)
		switch {
		case kind == tokEOF:
			return fields, depth, next
		case kind == tokPunct && tok == "}":
			return fields, depth, next
		case kind == tokPunct && tok == "...":
			pos = next
			tok, kind, next = gqlToken(s.doc, pos)
			if kind == tokName && tok != "on" { // fragment spread
				pos = s.skipDirectives(next)
				f, d := s.fragmentSize(tok)
				fields, depth = clampScore(fields+f), max(depth, d)
				continue
			}
			if kind == tokName { // "on Type"
				_, _, pos = gqlToken(s.doc, next)
			}
			pos = s.skipDirectives(pos)
			if t, k, _ := gqlToken(s.doc, pos); k == tokPunct && t == "{" {
				var f, d int64
				f, d, pos = s.selectionSet(pos)
				fields, depth = clampScore(fields+f), max(depth, d)
			}
		case kind == tokName: // a field, maybe aliased
			pos = next
			if t, k, n := gqlToken(s.doc, pos); k == tokPunct && t == ":" {
				_, _, pos = gqlToken(s.doc, n) // the field name after the alias
			}
			pos = s.skipArguments(pos)
			pos = s.skipDirectives(pos)
			var f, d int64
			if t, k, _ := gqlToken(s.doc, pos); k == tokPunct && t == "{" {
				f, d, pos = s.selectionSet(pos)
			}
			fields, depth = clampScore(fields+1+f), max(depth, 1+d)
		default: // not valid here: skip it
			pos = next
		}
	}
}

// skipArguments skips a parenthesized list at pos, if there is one.
func (s *scorer) skipArguments(pos int) int {
	tok, kind, next := gqlToken(s.doc, pos)
	if kind != tokPunct || tok != "(" {
		return pos
	}
	level := 1
	for pos = next; level > 0; {
		tok, kind, next = gqlToken(s.doc, pos)
		if kind == tokEOF {
			return next
		}
		if kind == tokPunct && tok == "(" {
			level++
		} else if kind == tokPunct && tok == ")" {
			level--
		}
		pos = next
	}
	return pos
}

// skipDirectives skips "@name(args)" directives at pos.
func (s *scorer) skipDirectives(pos int) int {
	for {
		tok, kind, next := gqlToken(s.doc, pos)
		if kind != tokPunct || tok != "@" {
			return pos
		}
		_, _, pos = gqlToken(s.doc, next) // directive name
		pos = s.skipArguments(pos)
	}
}

const (
	tokEOF = iota
	tokName
	tokPunct
	tokOther // numbers, strings, variables' "$"
)

// gqlToken returns the GraphQL token at or after pos, its kind and the
// position after it. Whitespace, commas and comments are skipped; strings
// (including block strings) are one token.
func gqlToken(doc string, pos int) (string, int, int) {
	for pos < len(doc) {
		c := doc[pos]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',' || c == 0xEF && strings.HasPrefix(doc[pos:], "\uFEFF"):
			if c == 0xEF {
				pos += 3
			} else {
				pos++
			}
		case c == '#':
			for pos < len(doc) && doc[pos] != '\n' && doc[pos] != '\r' {
				pos++
			}
		case c == '"':
			end := skipString(doc, pos)
			return doc[pos:end], tokOther, end
		case c == '_' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z':
			end := pos + 1
			for end < len(doc) && (doc[end] == '_' || doc[end] >= 'A' && doc[end] <= 'Z' || doc[end] >= 'a' && doc[end] <= 'z' || doc[end] >= '0' && doc[end] <= '9') {
				end++
			}
			return doc[pos:end], tokName, end
		case c == '.' && strings.HasPrefix(doc[pos:], "..."):
			return "...", tokPunct, pos + 3
		case strings.IndexByte("{}():@!=[]|&$", c) >= 0:
			return doc[pos : pos+1], tokPunct, pos + 1
		default: // a number or a stray byte
			end := pos + 1
			for end < len(doc) && (doc[end] == '.' || doc[end] == '-' || doc[end] == '+' || doc[end] >= '0' && doc[end] <= '9' || doc[end] == 'e' || doc[end] == 'E') {
				end++
			}
			return doc[pos:end], tokOther, end
		}
	}
	return "", tokEOF, len(doc)
}

// skipString returns the index just past the string literal starting at i
// (a "…" string with escapes, or a """…""" block string).
func skipString(doc string, i int) int {
	if strings.HasPrefix(doc[i:], `"""`) {
		for j := i + 3; j < len(doc); j++ {
			if doc[j] == '\\' && strings.HasPrefix(doc[j+1:], `"""`) {
				j += 3
				continue
			}
			if strings.HasPrefix(doc[j:], `"""`) {
				return j + 3
			}
		}
		return len(doc)
	}
	for j := i + 1; j < len(doc); j++ {
		switch doc[j] {
		case '\\':
			j++
		case '"', '\n', '\r':
			return j + 1
		}
	}
	return len(doc)
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
