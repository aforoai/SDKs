package ingest

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Wave 8, G269: batches of CompressionMinBytes or more are gzip-encoded,
// smaller ones are plain, a retry resends the same bytes, and "none" turns it off.
func TestCompressionRules(t *testing.T) {
	t.Run("large batch gzip, decoded keys intact", func(t *testing.T) {
		s := &server{}
		srv := httptest.NewServer(s)
		defer srv.Close()
		c, _ := newTestClient(t, srv.URL, newFakeHooks(0))
		for i := 0; i < 100; i++ {
			_ = c.Enqueue(ev(fmt.Sprintf("k%03d", i)))
		}
		if _, err := c.Flush(context.Background()); err != nil {
			t.Fatal(err)
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if len(s.encodings) != 1 || s.encodings[0] != "gzip" {
			t.Fatalf("encodings = %q, want [gzip]", s.encodings)
		}
		if got := len(s.batches[0]); got != 100 || s.batches[0][0] != "k000" {
			t.Fatalf("decoded batch = %d keys (first %q), want 100 from k000", got, s.batches[0][0])
		}
	})

	t.Run("small batch plain", func(t *testing.T) {
		s := &server{}
		srv := httptest.NewServer(s)
		defer srv.Close()
		c, _ := newTestClient(t, srv.URL, newFakeHooks(0))
		_ = c.Enqueue(ev("k1"))
		if _, err := c.Flush(context.Background()); err != nil {
			t.Fatal(err)
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.encodings[0] != "" || !strings.HasPrefix(string(s.wire[0]), "{") {
			t.Fatalf("small body sent with encoding %q", s.encodings[0])
		}
	})

	t.Run("retry resends identical bytes", func(t *testing.T) {
		s := &server{handle: func(w http.ResponseWriter, _ []string, n int) {
			if n == 1 {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			w.WriteHeader(http.StatusAccepted)
		}}
		srv := httptest.NewServer(s)
		defer srv.Close()
		c, _ := newTestClient(t, srv.URL, newFakeHooks(0))
		for i := 0; i < 100; i++ {
			_ = c.Enqueue(ev(fmt.Sprintf("k%03d", i)))
		}
		if _, err := c.Flush(context.Background()); err != nil {
			t.Fatal(err)
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if len(s.wire) != 2 || !bytes.Equal(s.wire[0], s.wire[1]) {
			t.Fatalf("got %d requests; retry bytes equal = %v", len(s.wire), len(s.wire) == 2 && bytes.Equal(s.wire[0], s.wire[1]))
		}
	})

	t.Run("compression none sends plain JSON; caller cannot set Content-Encoding", func(t *testing.T) {
		s := &server{}
		srv := httptest.NewServer(s)
		defer srv.Close()
		c, _ := newTestClient(t, srv.URL, newFakeHooks(0), func(cfg *Config) {
			cfg.Compression = "none"
			cfg.Headers = map[string]string{"Content-Encoding": "br"}
		})
		for i := 0; i < 100; i++ {
			_ = c.Enqueue(ev(fmt.Sprintf("k%03d", i)))
		}
		if _, err := c.Flush(context.Background()); err != nil {
			t.Fatal(err)
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.encodings[0] != "" || len(s.batches[0]) != 100 {
			t.Fatalf("encoding %q, %d keys; want plain with 100", s.encodings[0], len(s.batches[0]))
		}
	})

	t.Run("unknown compression is a configuration error", func(t *testing.T) {
		_, err := New(Config{BaseURL: "https://ingest.example", APIKey: "k", Compression: "br"})
		if err == nil || !strings.Contains(err.Error(), "Compression") {
			t.Fatalf("err = %v, want a Compression error", err)
		}
	})
}
