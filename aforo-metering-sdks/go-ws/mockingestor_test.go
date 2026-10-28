package wsmetering

// Test harness for the shared fault-injecting mock ingestor
// (mock-ingestor/, contract/TRANSPORT-SPEC.md). Each test starts its own
// instance as a subprocess on a free port and stops it on cleanup.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

type mockIngestor struct {
	URL string
	cmd *exec.Cmd
}

type mockRequest struct {
	Status          int      `json:"status"`
	EventCount      int      `json:"eventCount"`
	IdempotencyKeys []string `json:"idempotencyKeys"`
	ContentEncoding *string  `json:"contentEncoding"`
	UserAgent       *string  `json:"userAgent"`
}

type mockState struct {
	Requests        []mockRequest    `json:"requests"`
	Events          []map[string]any `json:"events"`
	AcceptedCount   int              `json:"acceptedCount"`
	UniqueKeys      int              `json:"uniqueKeys"`
	Duplicates      int              `json:"duplicates"`
	MaxInFlight     int              `json:"maxInFlight"`
	FaultsRemaining int              `json:"faultsRemaining"`
}

func findMockIngestor(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 6; i++ {
		p := filepath.Join(dir, "mock-ingestor", "bin", "mock-ingestor.mjs")
		if _, err := os.Stat(p); err == nil {
			return p
		}
		dir = filepath.Dir(dir)
	}
	t.Fatal("mock-ingestor/bin/mock-ingestor.mjs not found above the module directory")
	return ""
}

// startMockIngestor starts the mock and returns once it is listening. Needs
// Node 18+ on PATH; the test is skipped (with the reason) when node is absent.
func startMockIngestor(t *testing.T) *mockIngestor {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH; the mock-ingestor integration tests need Node 18+")
	}
	cmd := exec.Command(node, findMockIngestor(t), "--port", "0")
	stdin, _ := cmd.StdinPipe() // the mock exits when its stdin closes
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	lines := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		if sc.Scan() {
			lines <- sc.Text()
		}
		_, _ = io.Copy(io.Discard, stdout)
	}()
	select {
	case line := <-lines:
		var hello struct {
			Event string `json:"event"`
			URL   string `json:"url"`
		}
		if err := json.Unmarshal([]byte(line), &hello); err != nil || hello.Event != "listening" {
			t.Fatalf("unexpected first line from mock ingestor: %q", line)
		}
		return &mockIngestor{URL: hello.URL, cmd: cmd}
	case <-time.After(15 * time.Second):
		t.Fatal("mock ingestor did not start")
	}
	return nil
}

func (m *mockIngestor) control(t *testing.T, method, path string, body any) []byte {
	t.Helper()
	var r io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		r = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, m.URL+path, r)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("mock control %s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		t.Fatalf("mock control %s %s: HTTP %d %s", method, path, resp.StatusCode, out)
	}
	return out
}

func (m *mockIngestor) faults(t *testing.T, faults ...map[string]any) {
	t.Helper()
	m.control(t, http.MethodPost, "/__control/faults", map[string]any{"faults": faults})
}

func (m *mockIngestor) clearFaults(t *testing.T) {
	t.Helper()
	m.control(t, http.MethodDelete, "/__control/faults", nil)
}

func (m *mockIngestor) state(t *testing.T) mockState {
	t.Helper()
	var st mockState
	if err := json.Unmarshal(m.control(t, http.MethodGet, "/__control/state", nil), &st); err != nil {
		t.Fatal(err)
	}
	return st
}

// waitFor polls cond (no fixed sleeps) until it holds or d passes.
func waitUntil(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
