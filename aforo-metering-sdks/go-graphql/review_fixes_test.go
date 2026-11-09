package graphqlmetering

// Regression tests for the 2026-11-09 SDK review (#5, #7, R7).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBillingGoStringHidesKey(t *testing.T) {
	b, _ := New(Config{TenantID: "t", ProductID: "p", APIKey: "sk_live_SECRET", IngestorURL: "http://localhost:1", hooks: fastHooks()})
	defer b.Shutdown(bg)
	for _, f := range []string{"%v", "%+v", "%#v"} {
		if s := fmt.Sprintf(f, b); strings.Contains(s, "SECRET") {
			t.Errorf("%s shows the key", f)
		}
	}
}

func TestDetectOperationReadsTheWholeDocument(t *testing.T) {
	cases := []struct{ query, opName, wantType, wantName string }{
		{"# GraphiQL\nmutation Pay { pay(amount: 5) { id } }", "", "MUTATION", "Pay"},
		{"fragment F on User { id }\nmutation Pay { pay { ...F } }", "", "MUTATION", "Pay"},
		{"query Q { me { id } }\nmutation Pay { pay { id } }", "Pay", "MUTATION", "Pay"},
		{"query Q { me { id } }\nmutation Pay { pay { id } }", "Q", "QUERY", "Q"},
		{"subscription OnPay($id: ID = \"x { y\") @live { paid(id: $id) { id } }", "", "SUBSCRIPTION", "OnPay"},
		{"query ($a: In = {b: 1}) { x(note: \"\"\"mutation M { }\"\"\") }", "", "QUERY", "anonymous"},
		{"{ me { id } }", "", "QUERY", "anonymous"},
		{"  mutation{ a }", "", "MUTATION", "anonymous"},
		{"", "", "QUERY", "anonymous"},
		{"query A { a }", "Missing", "QUERY", "Missing"},
	}
	for _, c := range cases {
		typ, name := detectOperation(c.query, c.opName)
		if typ != c.wantType || name != c.wantName {
			t.Errorf("%q / %q → %s %s, want %s %s", c.query, c.opName, typ, name, c.wantType, c.wantName)
		}
	}
}

func TestPanickingResolverDropsTheEventAsInvalid(t *testing.T) {
	b, _ := New(Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: "http://localhost:1", hooks: fastHooks(),
		CustomerResolver: func(*http.Request) string { panic("session store down") }})
	defer b.Shutdown(bg)
	served := false
	h := b.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { served = true; _, _ = w.Write([]byte(`{"data":{}}`)) }))
	body, _ := json.Marshal([]map[string]string{{"query": "{ a }"}, {"query": "{ b }"}})
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic reached the server: %v", r)
			}
		}()
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/graphql", bytes.NewReader(body)))
	}()
	if !served || b.DroppedCount() != 2 || b.BufferedCount() != 0 {
		t.Fatalf("served=%v dropped=%d queued=%d (want 2 invalid, one per operation)", served, b.DroppedCount(), b.BufferedCount())
	}
}
