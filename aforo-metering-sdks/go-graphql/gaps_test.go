package graphqlmetering

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"runtime"
	"strings"
	"testing"
	"time"
)

func emitOneEvent(b *Billing) { b.Record("cust_1", "query Q { a }", "", 1, false) }

func gqlBilling(t *testing.T, url string, mutate ...func(*Config)) (*Billing, *recorderDrops) {
	t.Helper()
	d := &recorderDrops{}
	cfg := Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: url, FlushInterval: time.Hour,
		ShutdownTimeout: 200 * time.Millisecond, OnDrop: d.hook, hooks: fastHooks(),
		CustomerResolver: func(*http.Request) string { return "cust_mw" }}
	for _, m := range mutate {
		m(&cfg)
	}
	b, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.Shutdown(bg) })
	return b, d
}

type recorderDrops = mockDrops

func served(t *testing.T, b *Billing, req *http.Request, reply string) {
	t.Helper()
	h, err := b.NewMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = w.Write([]byte(reply))
	}))
	if err != nil {
		t.Fatal(err)
	}
	h.ServeHTTP(httptest.NewRecorder(), req)
}

// G265: the middleware needs a resolver or explicit trust.
func TestNewMiddleware_RequiresResolverOrExplicitTrust(t *testing.T) {
	b, _ := gqlBilling(t, "http://127.0.0.1:1", func(c *Config) { c.CustomerResolver = nil })
	if _, err := b.NewMiddleware(http.NotFoundHandler()); !errors.Is(err, ErrNoCustomerResolver) {
		t.Fatalf("err = %v, want ErrNoCustomerResolver", err)
	}
	defer func() {
		if recover() == nil {
			t.Fatal("Middleware must panic at wiring time without a customer source")
		}
	}()
	b.Middleware(http.NotFoundHandler())
}

// G265: the resolver wins over a caller-supplied header.
func TestResolverIgnoresCustomerHeader(t *testing.T) {
	r := &recorder{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b, _ := gqlBilling(t, srv.URL)
	req := httptest.NewRequest(http.MethodPost, "/graphql", strings.NewReader(`{"query":"{ me { id } }"}`))
	req.Header.Set("X-Customer-Id", "attacker")
	served(t, b, req, `{"data":{}}`)
	_ = b.Shutdown(bg)
	if evs := r.events(); len(evs) != 1 || evs[0]["customerId"] != "cust_mw" {
		t.Fatalf("events = %v", evs)
	}
}

// G278: GET queries and persisted queries are metered; an APQ miss is not
// billed twice.
func TestGETAndPersistedQueriesAreMetered(t *testing.T) {
	r := &recorder{}
	srv := httptest.NewServer(r)
	defer srv.Close()
	b, _ := gqlBilling(t, srv.URL)

	get := httptest.NewRequest(http.MethodGet, "/graphql?query="+url.QueryEscape("query Me { me { id } }"), nil)
	served(t, b, get, `{"data":{}}`)

	ext := url.QueryEscape(`{"persistedQuery":{"version":1,"sha256Hash":"abc123"}}`)
	apqGet := httptest.NewRequest(http.MethodGet, "/graphql?operationName=Cached&extensions="+ext, nil)
	served(t, b, apqGet, `{"data":{}}`)

	miss := httptest.NewRequest(http.MethodPost, "/graphql", strings.NewReader(`{"extensions":{"persistedQuery":{"version":1,"sha256Hash":"def456"}}}`))
	served(t, b, miss, `{"errors":[{"message":"PersistedQueryNotFound"}]}`)

	batch := httptest.NewRequest(http.MethodPost, "/graphql", strings.NewReader(`[{"query":"query A { a }"},{"query":"mutation B { b }"}]`))
	served(t, b, batch, `[{"data":{}},{"data":{}}]`)

	plain := httptest.NewRequest(http.MethodPost, "/graphql", strings.NewReader(`query Raw { r }`))
	plain.Header.Set("Content-Type", "application/graphql")
	served(t, b, plain, `{"data":{}}`)

	_ = b.Shutdown(bg)
	names := map[string]string{}
	for _, e := range r.events() {
		names[e["gqlOperationName"].(string)] = e["gqlOperationType"].(string)
		if e["gqlOperationName"] == "Cached" {
			if e["metadata"].(map[string]any)["persistedQueryHash"] != "abc123" {
				t.Errorf("APQ hash not recorded: %v", e["metadata"])
			}
		}
	}
	want := map[string]string{"Me": "QUERY", "Cached": "QUERY", "A": "QUERY", "B": "MUTATION", "Raw": "QUERY"}
	if fmt.Sprint(names) != fmt.Sprint(want) {
		t.Fatalf("metered operations = %v, want %v (the APQ miss must not be billed)", names, want)
	}
}

// G277: the body is read only up to MaxRequestBodyBytes; the handler still
// gets the whole body; the request is counted as not metered.
func TestOversizedBodyIsNotBufferedAndHandlerGetsItAll(t *testing.T) {
	b, d := gqlBilling(t, "http://127.0.0.1:1", func(c *Config) { c.MaxRequestBodyBytes = 1024 })
	body := `{"query":"` + strings.Repeat("a", 64<<10) + `"}`
	cr := &countingReader{r: strings.NewReader(body)}
	var seen int
	h, _ := b.NewMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if cr.n > 2048 {
			t.Errorf("middleware read %d bytes before the handler ran", cr.n)
		}
		raw, _ := readRequestBody(r)
		seen = len(raw)
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/graphql", cr))
	if seen != len(body) {
		t.Fatalf("handler got %d bytes, want %d", seen, len(body))
	}
	if _, reasons := d.snapshot(); len(reasons) != 1 || reasons[0] != DropInvalid {
		t.Fatalf("reasons = %v, want one DropInvalid", reasons)
	}
}

type countingReader struct {
	r io.Reader
	n int
}

func (c *countingReader) Read(p []byte) (int, error) {
	k, err := c.r.Read(p)
	c.n += k
	return k, err
}

// G278: the field regex is compiled once (no allocation-heavy compile per call).
func TestScoreComplexityDoesNotCompilePerCall(t *testing.T) {
	q := "query Q { a b c { d e } }"
	allocs := testing.AllocsPerRun(50, func() { scoreComplexity(q) })
	if allocs > 20 {
		t.Fatalf("scoreComplexity allocates %.0f objects per call; the regex must be compiled once", allocs)
	}
}

// G275 family: the response recorder keeps Flusher/Hijacker/Unwrap.
func TestResponseRecorderInterfaces(t *testing.T) {
	var w http.ResponseWriter = &responseRecorder{ResponseWriter: httptest.NewRecorder(), status: 200}
	if _, ok := w.(http.Flusher); !ok {
		t.Fatal("not a Flusher")
	}
	if _, ok := w.(http.Hijacker); !ok {
		t.Fatal("not a Hijacker")
	}
	if err := http.NewResponseController(w).Flush(); err != nil {
		t.Fatalf("Flush through the recorder: %v", err)
	}
}

// G276: recording over the threshold starts no goroutine.
func TestRecord_StartsNoGoroutines(t *testing.T) {
	gate := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-gate; w.WriteHeader(202) }))
	defer srv.Close()
	defer close(gate)
	b, _ := gqlBilling(t, srv.URL, func(c *Config) { c.FlushCount = 1 })
	before := runtime.NumGoroutine()
	for i := 0; i < 500; i++ {
		emitOneEvent(b)
	}
	if extra := runtime.NumGoroutine() - before; extra > 8 {
		t.Fatalf("500 events started %d goroutines", extra)
	}
}

// Record with a blank customer is counted, not silently skipped.
func TestRecordBlankCustomerIsCounted(t *testing.T) {
	b, d := gqlBilling(t, "http://127.0.0.1:1")
	b.Record(" ", "{ a }", "", 1, false)
	if _, reasons := d.snapshot(); len(reasons) != 1 || reasons[0] != DropInvalid {
		t.Fatalf("reasons = %v", reasons)
	}
}

// G270: https is enforced and the API key is never printed.
func TestHTTPSAndKeyRedaction(t *testing.T) {
	if _, err := New(Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: "http://api.example.com"}); err == nil {
		t.Fatal("plain http to a remote host accepted")
	}
	cfg := Config{TenantID: "t", ProductID: "p", APIKey: "sk_live_secret", IngestorURL: "https://api.example.com", hooks: fastHooks()}
	b, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Shutdown(bg)
	for _, s := range []string{fmt.Sprint(cfg), fmt.Sprintf("%+v", cfg), fmt.Sprintf("%#v", cfg), fmt.Sprint(b)} {
		if strings.Contains(s, "sk_live_secret") {
			t.Fatalf("API key printed: %s", s)
		}
	}
}
