package graphqlmetering

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
)

// readRequestBody reads a test server's request body, decoding Content-Encoding:
// gzip the way usage-ingestor's GzipRequestFilter does (wave 8, G269: the SDK
// gzips bodies of 1 KiB or more).
func readRequestBody(r *http.Request) ([]byte, error) {
	raw, err := io.ReadAll(r.Body)
	if err != nil || r.Header.Get("Content-Encoding") != "gzip" {
		return raw, err
	}
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return io.ReadAll(zr)
}

func mustReadRequestBody(r *http.Request) []byte {
	b, _ := readRequestBody(r)
	return b
}
