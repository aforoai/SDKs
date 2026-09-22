package metering

import (
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
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
// CustomerIDFunc is not set.
const DefaultCustomerIDHeader = "X-Customer-Id"

// maxEndpointPathLen is the ingestor's limit for the top-level endpointPath field.
const maxEndpointPathLen = 512

// MiddlewareOptions configures the HTTP middleware.
type MiddlewareOptions struct {
	APIKey            string
	BaseURL           string
	ExcludePaths      []string
	ExcludeStatusCode []int

	// MetricName is the fixed metric recorded per request. Default
	// DefaultMetricName ("api_calls"). Must exist in your Aforo catalog.
	MetricName string
	// MetricNameFunc derives the metric from the request; it takes precedence
	// over MetricName. An empty result falls back to MetricName / the default.
	MetricNameFunc func(r *http.Request) string

	// CustomerIDHeader is the header carrying the Aforo customer id.
	// Default DefaultCustomerIDHeader ("X-Customer-Id"). The caller's
	// X-Api-Key is never used: it is a secret, not a customer id.
	CustomerIDHeader string
	// CustomerIDFunc derives the customer id from the request; it takes
	// precedence over CustomerIDHeader. Requests with no customer id are not
	// metered.
	CustomerIDFunc func(r *http.Request) string

	// ProductType is sent as the top-level productType on every event.
	// Default: ClientOptions.ProductType, else DefaultProductType ("API").
	ProductType string

	ClientOptions *Options
}

// HTTPMiddleware returns an http.Handler wrapper that captures usage events.
//
//	mux := http.NewServeMux()
//	mux.Handle("/", handler)
//	wrapped := metering.HTTPMiddleware(mux, metering.MiddlewareOptions{APIKey: "key"})
//	http.ListenAndServe(":8080", wrapped)
func HTTPMiddleware(next http.Handler, opts MiddlewareOptions) http.Handler {
	clientOpts := Options{APIKey: opts.APIKey, BaseURL: opts.BaseURL}
	if opts.ClientOptions != nil {
		clientOpts = *opts.ClientOptions
		clientOpts.APIKey = opts.APIKey
		if opts.BaseURL != "" {
			clientOpts.BaseURL = opts.BaseURL
		}
	}
	if opts.ProductType != "" {
		clientOpts.ProductType = opts.ProductType
	}
	client := NewClient(clientOpts)

	excludePaths := opts.ExcludePaths
	if len(excludePaths) == 0 {
		excludePaths = defaultExcludePaths
	}

	customerHeader := opts.CustomerIDHeader
	if customerHeader == "" {
		customerHeader = DefaultCustomerIDHeader
	}
	metricName := opts.MetricName
	if metricName == "" {
		metricName = DefaultMetricName
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Wrap response writer to capture status code
		sw := &statusWriter{ResponseWriter: w, statusCode: 200}
		start := time.Now()
		next.ServeHTTP(sw, r)
		elapsed := time.Since(start)

		// After response — capture event
		path := r.URL.Path

		// CORS preflights are browser protocol, not billable calls, and carry
		// no credentials -- so they never have a customer. Never meter them.
		if r.Method == http.MethodOptions {
			return
		}

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

		var customerID string
		if opts.CustomerIDFunc != nil {
			customerID = opts.CustomerIDFunc(r)
		} else {
			customerID = r.Header.Get(customerHeader)
		}
		customerID = strings.TrimSpace(customerID)
		if customerID == "" {
			return
		}

		metric := metricName
		if opts.MetricNameFunc != nil {
			if m := opts.MetricNameFunc(r); m != "" {
				metric = m
			}
		}

		// r.URL.Path never carries the query string.
		_ = client.Track(TrackEvent{
			CustomerID:     customerID,
			MetricName:     metric,
			Quantity:       1,
			EndpointPath:   truncateUTF8(normalizePath(path), maxEndpointPathLen),
			HTTPMethod:     r.Method,
			StatusCode:     sw.statusCode,
			ResponseTimeMs: elapsed.Milliseconds(),
		})
	})
}

// Gin users: there is no Gin-specific helper here because this package imports
// no web framework (zero deps). Wrap HTTPMiddleware instead, e.g.
//   router.Use(gin.WrapH(metering.HTTPMiddleware(next, opts)))
// or call client.Track(...) directly from a gin.HandlerFunc.

// ChiMiddleware returns a Chi-compatible middleware function.
// Usage: r.Use(metering.ChiMiddleware(opts))
func ChiMiddleware(opts MiddlewareOptions) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return HTTPMiddleware(next, opts)
	}
}

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

// truncateUTF8 cuts s to at most max bytes without splitting a rune.
func truncateUTF8(s string, max int) string {
	if len(s) <= max {
		return s
	}
	for max > 0 && !utf8.RuneStart(s[max]) {
		max--
	}
	return s[:max]
}

// statusWriter wraps http.ResponseWriter to capture the status code.
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
		w.statusCode = 200
		w.written = true
	}
	return w.ResponseWriter.Write(b)
}
