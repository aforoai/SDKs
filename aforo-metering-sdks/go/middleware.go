package metering

import (
	"bufio"
	"errors"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var (
	numericRe = regexp.MustCompile(`^\d+$`)
	uuidRe    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	mongoRe   = regexp.MustCompile(`^[0-9a-f]{24}$`)
	versionRe = regexp.MustCompile(`(?i)^v\d+$`)

	defaultExcludePaths = []string{"/health", "/ready", "/metrics", "/favicon.ico"}
)

// DefaultMetricName is the metric recorded per request when neither
// MetricName nor MetricNameFunc is set.
//
// It must exist in the tenant's Aforo metric catalog: the ingestor rejects an
// unknown metric, and because it validates a batch as a whole, one such event
// fails the entire batch with 400. The previous default, "METHOD /path", is a
// name no catalog contains, so every event failed out of the box.
const DefaultMetricName = "api_calls"

// DefaultCustomerIDHeader is the request header read for the customer id when
// MiddlewareOptions.TrustCustomerHeader is true and CustomerIDHeader is empty.
const DefaultCustomerIDHeader = "X-Customer-Id"

// ErrNoCustomerResolver is returned when a middleware is built without a
// CustomerResolver and without TrustCustomerHeader.
var ErrNoCustomerResolver = errors.New("aforo: middleware needs a CustomerResolver (the Aforo customer id from your own authentication: session, JWT subject, API-key lookup) or TrustCustomerHeader: true to bill the customer named in a request header that your callers control")

// MiddlewareOptions configures the HTTP middleware.
type MiddlewareOptions struct {
	ExcludePaths      []string
	ExcludeStatusCode []int

	// MetricName is the fixed metric recorded per request. Default
	// DefaultMetricName ("api_calls"). Must exist in your Aforo catalog.
	MetricName string
	// MetricNameFunc derives the metric from the request; it takes precedence
	// over MetricName. An empty result falls back to MetricName / the default.
	MetricNameFunc func(r *http.Request) string

	// CustomerResolver returns the Aforo customer id for a request, from
	// identity your server has authenticated (session, JWT subject, API-key
	// lookup, mTLS). Required unless TrustCustomerHeader is true. A blank
	// result is not billed: the event is dropped as DropInvalid and counted;
	// the request itself is never blocked.
	CustomerResolver func(r *http.Request) string

	// TrustCustomerHeader bills the customer named in CustomerIDHeader. The
	// caller of your API controls that header, so only turn this on when a
	// trusted proxy in front of your service sets it and strips any value the
	// client sent. Ignored when CustomerResolver is set.
	TrustCustomerHeader bool
	// CustomerIDHeader is the header read when TrustCustomerHeader is true.
	// Default DefaultCustomerIDHeader ("X-Customer-Id").
	CustomerIDHeader string

	// ProductType is sent as the top-level productType on every event.
	// Default: the client's Options.ProductType.
	ProductType string
}

// NewMiddleware returns net/http middleware that meters every request through
// client. You own client: create it once and Close it at shutdown so queued
// events are sent. The returned func works with net/http
// (mw(mux)) and Chi (r.Use(mw)).
//
//	client, _ := metering.NewClient(metering.Options{APIKey: os.Getenv("AFORO_API_KEY")})
//	defer client.Close(context.Background())
//	mw, err := metering.NewMiddleware(client, metering.MiddlewareOptions{
//	    CustomerResolver: func(r *http.Request) string { return customerFromSession(r) },
//	})
//	http.ListenAndServe(":8080", mw(mux))
func NewMiddleware(client *AforoClient, opts MiddlewareOptions) (func(http.Handler) http.Handler, error) {
	if client == nil {
		return nil, errors.New("aforo: middleware needs a client (metering.NewClient); you Close it at shutdown")
	}
	resolve := opts.CustomerResolver
	if resolve == nil {
		if !opts.TrustCustomerHeader {
			return nil, ErrNoCustomerResolver
		}
		header := opts.CustomerIDHeader
		if header == "" {
			header = DefaultCustomerIDHeader
		}
		resolve = func(r *http.Request) string { return r.Header.Get(header) }
	}

	excludePaths := opts.ExcludePaths
	if len(excludePaths) == 0 {
		excludePaths = defaultExcludePaths
	}
	metricName := opts.MetricName
	if metricName == "" {
		metricName = DefaultMetricName
	}
	productType := normalizeProductType(opts.ProductType)

	// endpointPath and httpMethod come from the caller of the metered API, so
	// they are truncated to the ingestor's limits instead of dropping the event.
	labels := &labelTruncator{}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sw := &statusWriter{ResponseWriter: w, statusCode: http.StatusOK}
			start := time.Now()
			next.ServeHTTP(sw, r)
			elapsed := time.Since(start)

			// CORS preflights are browser protocol, not billable calls, and
			// carry no credentials -- so they never have a customer.
			if r.Method == http.MethodOptions {
				return
			}
			path := r.URL.Path // never carries the query string
			for _, ep := range excludePaths {
				if strings.HasPrefix(path, ep) {
					return
				}
			}
			for _, sc := range opts.ExcludeStatusCode {
				if sw.statusCode == sc {
					return
				}
			}

			metric := metricName
			if opts.MetricNameFunc != nil {
				if m := opts.MetricNameFunc(r); m != "" {
					metric = m
				}
			}
			// A blank customer id makes Track drop the event as DropInvalid
			// (counted and handed to OnDrop); the request is already served.
			_ = client.Track(TrackEvent{
				CustomerID:     strings.TrimSpace(resolve(r)),
				MetricName:     metric,
				Quantity:       1,
				ProductType:    productType,
				EndpointPath:   labels.truncate("endpointPath", normalizePath(path), maxEndpointPathLen),
				HTTPMethod:     labels.truncate("httpMethod", r.Method, maxHTTPMethodLen),
				StatusCode:     sw.statusCode,
				ResponseTimeMs: elapsed.Milliseconds(),
			})
		})
	}, nil
}

// HTTPMiddleware wraps next with NewMiddleware(client, opts).
func HTTPMiddleware(next http.Handler, client *AforoClient, opts MiddlewareOptions) (http.Handler, error) {
	mw, err := NewMiddleware(client, opts)
	if err != nil {
		return nil, err
	}
	return mw(next), nil
}

// ChiMiddleware is NewMiddleware under the name Chi users look for:
//
//	mw, err := metering.ChiMiddleware(client, opts)
//	r.Use(mw)
//
// Every handler shares the one client you pass in.
func ChiMiddleware(client *AforoClient, opts MiddlewareOptions) (func(http.Handler) http.Handler, error) {
	return NewMiddleware(client, opts)
}

// Gin users: there is no Gin-specific helper here because this package imports
// no web framework (zero deps). Wrap the middleware instead, e.g.
//
//	mw, _ := metering.NewMiddleware(client, opts)
//	router.Use(gin.WrapH(mw(next)))
//
// or call client.Track(...) directly from a gin.HandlerFunc.

// NormalizePath replaces dynamic path segments (numeric ids, UUIDs, Mongo ids)
// with ":id". Useful inside a MetricNameFunc or for metadata; the middleware no
// longer uses route-shaped metric names by default.
func NormalizePath(path string) string { return normalizePath(path) }

// normalizePath replaces dynamic segments with :id.
func normalizePath(path string) string {
	segments := strings.Split(path, "/")
	for i, seg := range segments {
		if seg == "" {
			continue
		}
		if versionRe.MatchString(seg) {
			continue
		}
		if numericRe.MatchString(seg) || uuidRe.MatchString(strings.ToLower(seg)) || mongoRe.MatchString(strings.ToLower(seg)) {
			segments[i] = ":id"
		}
	}
	return strings.Join(segments, "/")
}

// statusWriter wraps http.ResponseWriter to capture the status code. It
// passes Flush and Hijack through and implements Unwrap, so server-sent
// events, WebSocket upgrades and http.ResponseController keep working behind
// the middleware.
type statusWriter struct {
	http.ResponseWriter
	statusCode int
	written    bool
}

func (w *statusWriter) WriteHeader(code int) {
	if !w.written {
		w.statusCode = code
		w.written = true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if !w.written {
		w.statusCode = http.StatusOK
		w.written = true
	}
	return w.ResponseWriter.Write(b)
}

// Flush implements http.Flusher when the wrapped writer can flush.
func (w *statusWriter) Flush() {
	if !w.written {
		w.statusCode = http.StatusOK
		w.written = true
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

// Hijack implements http.Hijacker for WebSocket upgrades. A hijacked
// connection is recorded with status 101 unless a status was already written.
func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err == nil && !w.written {
		w.statusCode = http.StatusSwitchingProtocols
		w.written = true
	}
	return conn, rw, err
}

// Unwrap returns the wrapped writer (used by http.ResponseController).
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
