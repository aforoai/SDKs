package mqttmetering

// Regression tests for the 2026-11-09 SDK review (#5, #8, R3).

import (
	"fmt"
	"go/parser"
	"go/token"
	"os"
	"strconv"
	"strings"
	"testing"
)

func TestBillingGoStringHidesKey(t *testing.T) {
	b, err := New(Config{TenantID: "t", ProductID: "p", APIKey: "sk_live_SECRET", IngestorURL: "http://localhost:1", hooks: fastHooks()})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Shutdown(bg)
	for _, f := range []string{"%v", "%+v", "%#v"} {
		if s := fmt.Sprintf(f, b); strings.Contains(s, "SECRET") {
			t.Errorf("%s shows the key", f)
		}
	}
}

func TestPushLeavesOutOfRangeIntegersOff(t *testing.T) {
	b, _ := New(Config{TenantID: "t", ProductID: "p", APIKey: "k", IngestorURL: "http://localhost:1", hooks: fastHooks()})
	defer b.Shutdown(bg)
	ev := b.eventOf("c", "dev", "PUBLISH", "a/b", 1, false, 5, nil)
	ev["messageCount"] = int64(1 << 40)
	b.push(ev)
	if _, ok := ev["messageCount"]; ok || b.BufferedCount() != 1 {
		t.Fatalf("messageCount kept=%v queued=%d", ok, b.BufferedCount())
	}
}

func TestReadmeQuickstartImportsWhatItUses(t *testing.T) {
	raw, err := os.ReadFile("README.md")
	if err != nil {
		t.Fatal(err)
	}
	s := string(raw)
	i := strings.Index(s, "## Quickstart")
	j := strings.Index(s[i:], "```go\n")
	k := strings.Index(s[i+j+6:], "```")
	code := s[i+j+6 : i+j+6+k]
	f, err := parser.ParseFile(token.NewFileSet(), "quickstart.go", code, parser.ImportsOnly)
	if err != nil {
		t.Fatal(err)
	}
	imported := map[string]bool{}
	for _, im := range f.Imports {
		p, _ := strconv.Unquote(im.Path.Value)
		imported[p] = true
	}
	for _, pkg := range []string{"context", "log", "os", "time"} {
		if strings.Contains(code, pkg+".") && !imported[pkg] {
			t.Errorf("quickstart uses %s. without importing %q", pkg, pkg)
		}
	}
}
