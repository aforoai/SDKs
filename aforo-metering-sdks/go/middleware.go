package metering

import (
	"net/http"
	"regexp"
	"strings"
)

var (
	numericRe = regexp.MustCompile(`^\d+$`)
	uuidRe    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	mongoRe   = regexp.MustCompile(`^[0-9a-f]{24}$`)
	versionRe = regexp.MustCompile(`(?i)^v\d+$`)

	defaultExcludePaths = []string{"/health", "/ready", "/metrics", "/favicon.ico"}
)

// MiddlewareOptions configures the HTTP middleware.
type MiddlewareOptions struct {
	APIKey            string
	BaseURL           string
	ExcludePaths      []string
	ExcludeStatusCode []int
	CustomerIDHeader  string // Default: "X-Customer-Id", fallback "X-Api-Key"
	ClientOptions     *Options
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
	client := NewClient(clientOpts)

	excludePaths := opts.ExcludePaths
	if len(excludePaths) == 0 {
		excludePaths = defaultExcludePaths
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Wrap response writer to capture status code
		sw := &statusWriter{ResponseWriter: w, statusCode: 200}
		next.ServeHTTP(sw, r)

		// After response — capture event
		path := r.URL.Path
		method := r.Method

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

		customerID := r.Header.Get("X-Customer-Id")
		if customerID == "" {
			customerID = r.Header.Get("X-Api-Key")
		}
		if opts.CustomerIDHeader != "" {
			if v := r.Header.Get(opts.CustomerIDHeader); v != "" {
				customerID = v
			}
		}
		if customerID == "" {
			return
		}

		normalized := normalizePath(path)
		_ = client.Track(TrackEvent{
			CustomerID: customerID,
			MetricName: method + " " + normalized,
			Quantity:   1,
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
