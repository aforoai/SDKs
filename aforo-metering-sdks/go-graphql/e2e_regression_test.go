// Regressions from the 2026-11-09 end-to-end test against a real ingestor:
//   - complexity and field count covered every operation in the document, so a
//     multi-operation document over-billed the operation that ran;
//   - gqlHasErrors followed only the HTTP status, so a 200 response carrying
//     GraphQL errors was sent with gqlHasErrors=false.

package graphqlmetering

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const pickMeDoc = `query A { users { id } } mutation PickMe { createOrder(item: "cup") { id } }`

// The cross-SDK fixtures: java-graphql, python-graphql and node-graphql score
// the same documents to the same numbers.
var scoreFixtures = []struct {
	name, doc, operationName string
	fields, complexity       int
}{
	{"other operations are not counted", pickMeDoc, "PickMe", 2, 12},
	{"the first operation without operationName", pickMeDoc, "", 2, 12},
	{"a fragment counts where it is spread; unused ones do not",
		`query Q { first: user(id: 1) { ...U } second: user(id: 2) { ...U } } fragment U on User { id profile { bio } } fragment Unused on User { id name email }`,
		"", 8, 23},
	{"an inline fragment with a directive adds no depth",
		`query C { user(id: 7) { id ... on User @include(if: true) { name } } }`, "", 3, 13},
	{"aliases, arguments, variables and directives are not fields",
		`query D($first: Int = 5) { top: teams(first: $first, filter: {active: true, tags: ["a", "b"]}) { members: users(limit: 10, order: DESC) @skip(if: false) { recent: orders(last: 3, status: [OPEN, PAID]) { id total(currency: "USD") } } } }`,
		"", 5, 25},
	{"an anonymous query", `{ me { id name friends(first: 2) { name } } }`, "", 5, 20},
	{"comments and strings are skipped", "query S { # a { b c }\n a(s: \"{ x y }\", b: \"\"\"{ z }\"\"\") }", "", 1, 6},
	{"a self-spreading fragment counts nothing more", `query L { user { ...F } } fragment F on User { id ...F }`, "", 2, 12},
	{"an unknown fragment counts nothing", `query M { user { ...Missing id } }`, "", 2, 12},
}

func TestScoreOperationFixtures(t *testing.T) {
	for _, fx := range scoreFixtures {
		c, f := scoreOperation(fx.doc, fx.operationName)
		if f != fx.fields || c != fx.complexity {
			t.Errorf("%s: scored fields=%d complexity=%d, want %d/%d", fx.name, f, c, fx.fields, fx.complexity)
		}
	}
}

func TestScoreOperationNestedSpreadsAreLinearAndCapped(t *testing.T) {
	// F0 spreads F1 twice, F1 spreads F2 twice, ...: 2^40 fields if expanded.
	var b strings.Builder
	b.WriteString("query Bomb { root { ...F0 } }")
	for i := 0; i < 40; i++ {
		fmt.Fprintf(&b, " fragment F%d on T { a ...F%d ...F%d }", i, i+1, i+1)
	}
	b.WriteString(" fragment F40 on T { leaf }")
	start := time.Now()
	c, f := scoreOperation(b.String(), "")
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("scoring nested spreads took %v; fragment sizes must be worked out once", elapsed)
	}
	if f != maxScore || c != maxScore {
		t.Errorf("scored fields=%d complexity=%d, want both capped at %d", f, c, maxScore)
	}
}

func TestMiddlewareScoresTheNamedOperation(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec)
	defer srv.Close()
	b := newBilling(t, srv)
	handler := b.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"createOrder":{"id":"o1"}}}`))
	}))
	body, _ := json.Marshal(map[string]string{"query": pickMeDoc, "operationName": "PickMe"})
	req := httptest.NewRequest(http.MethodPost, "/graphql", bytes.NewReader(body))
	req.Header.Set("X-Customer-Id", "cust_1")
	handler.ServeHTTP(httptest.NewRecorder(), req)

	waitFor(t, func() bool { return len(rec.events()) == 1 }, 2*time.Second)
	ev := rec.events()[0]
	wantC, wantF := 12, 2
	if ev["gqlOperationType"] != "MUTATION" || ev["gqlOperationName"] != "PickMe" {
		t.Errorf("operation = %v %v", ev["gqlOperationType"], ev["gqlOperationName"])
	}
	if int(ev["gqlComplexity"].(float64)) != wantC || int(ev["gqlFieldCount"].(float64)) != wantF {
		t.Errorf("complexity/fields = %v/%v, want %d/%d", ev["gqlComplexity"], ev["gqlFieldCount"], wantC, wantF)
	}
}

func TestMiddlewareHasErrorsFollowsTheGraphQLBody(t *testing.T) {
	cases := []struct {
		name, body, override string
		status               int
		wantErrors           bool
		wantStatus           string
	}{
		{"ok", `{"data":{"a":1}}`, "", 200, false, "SUCCESS"},
		{"partial under 200", `{"data":{"a":1},"errors":[{"message":"boom"}]}`, "", 200, true, "PARTIAL"},
		{"failed under 200", `{"data":null,"errors":[{"message":"boom"}]}`, "", 200, true, "ERROR"},
		{"validation under 200", `{"errors":[{"message":"bad field"}]}`, "", 200, true, "VALIDATION_FAILED"},
		{"empty errors array", `{"data":{"a":1},"errors":[]}`, "", 200, false, "SUCCESS"},
		{"http error, no GraphQL body", `upstream down`, "", 502, true, "ERROR"},
		{"override keeps the flag", `{"data":{"a":1},"errors":[{"message":"boom"}]}`, "SUCCESS", 200, true, "SUCCESS"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := &recorder{}
			srv := httptest.NewServer(rec)
			defer srv.Close()
			b := newBilling(t, srv)
			handler := b.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.override != "" {
					SetExecutionStatus(r.Context(), tc.override)
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			req := httptest.NewRequest(http.MethodPost, "/graphql", bytes.NewReader([]byte(`{"query":"query Q { a }"}`)))
			req.Header.Set("X-Customer-Id", "cust_1")
			handler.ServeHTTP(httptest.NewRecorder(), req)

			waitFor(t, func() bool { return len(rec.events()) == 1 }, 2*time.Second)
			ev := rec.events()[0]
			if ev["gqlHasErrors"] != tc.wantErrors {
				t.Errorf("gqlHasErrors = %v, want %v", ev["gqlHasErrors"], tc.wantErrors)
			}
			if ev["executionStatus"] != tc.wantStatus {
				t.Errorf("executionStatus = %v, want %v", ev["executionStatus"], tc.wantStatus)
			}
		})
	}
}
