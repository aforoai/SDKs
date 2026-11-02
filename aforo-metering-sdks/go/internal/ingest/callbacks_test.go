package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

type errSink struct {
	mu   sync.Mutex
	errs []*TransportError
}

func (s *errSink) add(e *TransportError) { s.mu.Lock(); s.errs = append(s.errs, e); s.mu.Unlock() }
func (s *errSink) kinds() []ErrorKind {
	s.mu.Lock()
	defer s.mu.Unlock()
	var k []ErrorKind
	for _, e := range s.errs {
		k = append(k, e.Kind)
	}
	return k
}

// OnError receives a *TransportError whose Kind callers branch on, with the
// events concerned, for every kind in the spec.
func TestOnErrorIsTypedWithKindAndEvents(t *testing.T) {
	var mode string
	var mu sync.Mutex
	s := &server{handle: func(w http.ResponseWriter, _ []string, _ int) {
		mu.Lock()
		m := mode
		mu.Unlock()
		switch m {
		case "auth":
			w.WriteHeader(401)
		case "outage":
			w.WriteHeader(503)
		case "rejected":
			w.WriteHeader(422)
		default:
			w.WriteHeader(202)
		}
	}}
	srv := httptest.NewServer(s)
	defer srv.Close()
	set := func(m string) { mu.Lock(); mode = m; mu.Unlock() }
	for _, tc := range []struct {
		mode string
		kind ErrorKind
		is   error
	}{
		{"auth", KindAuth, ErrIngestUnavailable},
		{"outage", KindOutage, ErrIngestUnavailable},
		{"rejected", KindRejected, nil},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			sink := &errSink{}
			c, _ := newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) { cfg.OnError = sink.add; cfg.MaxRetries = -1 })
			set(tc.mode)
			_ = c.Enqueue(ev("a"))
			_, _ = c.Flush(context.Background())
			if len(sink.errs) != 1 || sink.errs[0].Kind != tc.kind || len(sink.errs[0].Events) != 1 || sink.errs[0].Events[0].Key != "a" {
				t.Fatalf("errors = %+v, want one %s naming event a", sink.errs, tc.kind)
			}
			if tc.is != nil && !errors.Is(sink.errs[0], tc.is) {
				t.Fatalf("errors.Is(%v, %v) = false", sink.errs[0], tc.is)
			}
			var te *TransportError
			var asErr error = sink.errs[0]
			if !errors.As(asErr, &te) {
				t.Fatal("errors.As failed")
			}
		})
	}
	t.Run("shutdown+closed", func(t *testing.T) {
		set("outage")
		sink := &errSink{}
		c, _ := newTestClient(t, "http://127.0.0.1:1", newFakeHooks(0), func(cfg *Config) { cfg.OnError = sink.add })
		_ = c.Enqueue(ev("a"))
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_ = c.Close(ctx)
		_ = c.Enqueue(ev("late"))
		k := fmt.Sprint(sink.kinds())
		if k != "[shutdown closed]" {
			t.Fatalf("kinds = %s, want [shutdown closed]", k)
		}
		if !errors.Is(sink.errs[0], ErrShutdownIncomplete) || !errors.Is(sink.errs[1], ErrClosed) {
			t.Fatal("sentinels not matched")
		}
	})
}

// OnAccepted receives the envelope-unwrapped 2xx body and the batch, and may
// call Flush without deadlocking; a panic in it is recovered.
func TestOnAcceptedGetsUnwrappedBody(t *testing.T) {
	s := &server{handle: func(w http.ResponseWriter, _ []string, _ int) {
		w.WriteHeader(202)
		fmt.Fprint(w, `{"success":true,"data":{"accepted":2,"killedSessionIds":["s1"]},"meta":{}}`)
	}}
	srv := httptest.NewServer(s)
	defer srv.Close()
	var got struct {
		Killed []string `json:"killedSessionIds"`
	}
	var n int
	var c *Client
	c, _ = newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) {
		cfg.OnAccepted = func(body json.RawMessage, events []Event) {
			n = len(events)
			_ = json.Unmarshal(body, &got)
			_, _ = c.Flush(context.Background())
			panic("boom")
		}
	})
	_ = c.Enqueue(ev("a"))
	_ = c.Enqueue(ev("b"))
	if res, err := c.Flush(context.Background()); err != nil || res.Sent != 2 {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if n != 2 || len(got.Killed) != 1 || got.Killed[0] != "s1" {
		t.Fatalf("OnAccepted got %d events, body %+v", n, got)
	}
}
