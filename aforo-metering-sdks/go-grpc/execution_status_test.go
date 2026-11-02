package grpcmetering

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func TestOutcomeFromGrpcCodeTable(t *testing.T) {
	cases := map[codes.Code]string{
		codes.OK:                 "SUCCESS",
		codes.Canceled:           "CANCELLED",
		codes.Unknown:            "ERROR",
		codes.InvalidArgument:    "VALIDATION_FAILED",
		codes.DeadlineExceeded:   "TIMEOUT",
		codes.NotFound:           "ERROR",
		codes.AlreadyExists:      "ERROR",
		codes.PermissionDenied:   "BLOCKED",
		codes.ResourceExhausted:  "BLOCKED",
		codes.FailedPrecondition: "VALIDATION_FAILED",
		codes.Aborted:            "ERROR",
		codes.OutOfRange:         "VALIDATION_FAILED",
		codes.Unimplemented:      "ERROR",
		codes.Internal:           "ERROR",
		codes.Unavailable:        "ERROR",
		codes.DataLoss:           "ERROR",
		codes.Unauthenticated:    "BLOCKED",
		codes.Code(99):           "ERROR",
	}
	for c, want := range cases {
		if got := OutcomeFromGrpcCode(c); got != want {
			t.Errorf("OutcomeFromGrpcCode(%s) = %q, want %q", c, got, want)
		}
	}
}

func recordAndGetStatus(t *testing.T, fn func(b *Billing, ctx context.Context)) (string, bool) {
	t.Helper()
	rec := &recorder{status: 204}
	srv := httptest.NewServer(rec)
	defer srv.Close()
	b := newBilling(t, srv)
	fn(b, ctxWith(metadata.Pairs("x-customer-id", "cust_001")))
	waitFor(t, func() bool { return len(rec.got()) == 1 }, 2*time.Second)
	ev := rec.got()[0].body["events"].([]any)[0].(map[string]any)
	v, present := ev["executionStatus"]
	s, _ := v.(string)
	return s, present
}

func TestRecordDerivesExecutionStatusFromError(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{nil, "SUCCESS"},
		{status.Error(codes.InvalidArgument, "bad"), "VALIDATION_FAILED"},
		{status.Error(codes.DeadlineExceeded, "slow"), "TIMEOUT"},
		{status.Error(codes.Unauthenticated, "who"), "BLOCKED"},
		{status.Error(codes.Canceled, "gone"), "CANCELLED"},
		{status.Error(codes.Unavailable, "down"), "ERROR"},
	}
	for _, c := range cases {
		got, _ := recordAndGetStatus(t, func(b *Billing, ctx context.Context) {
			b.Record(ctx, "GetUser", "UNARY", 1, c.err, 5)
		})
		if got != c.want {
			t.Errorf("err=%v: executionStatus = %q, want %q", c.err, got, c.want)
		}
	}
}

func TestRecordWithOptionsExplicitBeatsDerived(t *testing.T) {
	got, _ := recordAndGetStatus(t, func(b *Billing, ctx context.Context) {
		b.RecordWithOptions(ctx, "GetUser", "UNARY", 1, status.Error(codes.Internal, "x"), 5,
			EventOptions{ExecutionStatus: "  partial "})
	})
	if got != "PARTIAL" {
		t.Fatalf("executionStatus = %q, want PARTIAL", got)
	}
}

func TestRecordWithOptionsBlankFallsBackToDerived(t *testing.T) {
	got, _ := recordAndGetStatus(t, func(b *Billing, ctx context.Context) {
		b.RecordWithOptions(ctx, "GetUser", "UNARY", 1, status.Error(codes.DeadlineExceeded, "x"), 5,
			EventOptions{ExecutionStatus: "   "})
	})
	if got != "TIMEOUT" {
		t.Fatalf("executionStatus = %q, want TIMEOUT", got)
	}
}

func TestUnaryInterceptorSetExecutionStatusOverrides(t *testing.T) {
	var setOK bool
	got, _ := recordAndGetStatus(t, func(b *Billing, ctx context.Context) {
		_, _ = b.UnaryInterceptor()(ctx, nil, &grpc.UnaryServerInfo{FullMethod: "/acme.v1.UserService/GetUser"},
			func(ctx context.Context, req any) (any, error) {
				setOK = SetExecutionStatus(ctx, "hitl_required")
				return nil, nil
			})
	})
	if !setOK {
		t.Fatal("SetExecutionStatus returned false inside a metered handler")
	}
	if got != "HITL_REQUIRED" {
		t.Fatalf("executionStatus = %q, want HITL_REQUIRED", got)
	}
}

func TestUnaryInterceptorDerivesWhenNotSet(t *testing.T) {
	got, _ := recordAndGetStatus(t, func(b *Billing, ctx context.Context) {
		_, _ = b.UnaryInterceptor()(ctx, nil, &grpc.UnaryServerInfo{FullMethod: "/acme.v1.UserService/GetUser"},
			func(ctx context.Context, req any) (any, error) {
				return nil, status.Error(codes.PermissionDenied, "no")
			})
	})
	if got != "BLOCKED" {
		t.Fatalf("executionStatus = %q, want BLOCKED", got)
	}
}

type fakeStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (f *fakeStream) Context() context.Context { return f.ctx }

func TestStreamInterceptorSetExecutionStatusOverrides(t *testing.T) {
	got, _ := recordAndGetStatus(t, func(b *Billing, ctx context.Context) {
		_ = b.StreamInterceptor()(nil, &fakeStream{ctx: ctx},
			&grpc.StreamServerInfo{FullMethod: "/acme.v1.UserService/Watch", IsServerStream: true},
			func(srv any, ss grpc.ServerStream) error {
				if !SetExecutionStatus(ss.Context(), "partial") {
					t.Error("SetExecutionStatus returned false on the stream context")
				}
				return status.Error(codes.Internal, "x")
			})
	})
	if got != "PARTIAL" {
		t.Fatalf("executionStatus = %q, want PARTIAL", got)
	}
}

func TestSetExecutionStatusOutsideMeteredRPC(t *testing.T) {
	if SetExecutionStatus(context.Background(), "SUCCESS") {
		t.Fatal("SetExecutionStatus must return false outside a metered RPC")
	}
}

func recordAndGetEvent(t *testing.T, fn func(b *Billing, ctx context.Context)) map[string]any {
	t.Helper()
	rec := &recorder{status: 204}
	srv := httptest.NewServer(rec)
	defer srv.Close()
	b := newBilling(t, srv)
	fn(b, ctxWith(metadata.Pairs("x-customer-id", "cust_001")))
	waitFor(t, func() bool { return len(rec.got()) == 1 }, 2*time.Second)
	return rec.got()[0].body["events"].([]any)[0].(map[string]any)
}

func TestRecordMapsPlainContextErrors(t *testing.T) {
	cases := []struct {
		err        error
		wantCode   string
		wantStatus string
	}{
		{context.Canceled, "CANCELLED", "CANCELLED"},
		{context.DeadlineExceeded, "DEADLINE_EXCEEDED", "TIMEOUT"},
		{fmt.Errorf("lookup: %w", context.Canceled), "CANCELLED", "CANCELLED"},
		{fmt.Errorf("lookup: %w", context.DeadlineExceeded), "DEADLINE_EXCEEDED", "TIMEOUT"},
		{errors.New("plain failure"), "UNKNOWN", "ERROR"},
	}
	for _, c := range cases {
		ev := recordAndGetEvent(t, func(b *Billing, ctx context.Context) {
			b.Record(ctx, "GetUser", "UNARY", 1, c.err, 5)
		})
		if ev["grpcStatusCode"] != c.wantCode || ev["executionStatus"] != c.wantStatus {
			t.Errorf("err=%v: grpcStatusCode=%v executionStatus=%v, want %s/%s",
				c.err, ev["grpcStatusCode"], ev["executionStatus"], c.wantCode, c.wantStatus)
		}
	}
}

func TestUnaryInterceptorMapsCtxErr(t *testing.T) {
	ev := recordAndGetEvent(t, func(b *Billing, ctx context.Context) {
		_, _ = b.UnaryInterceptor()(ctx, nil, &grpc.UnaryServerInfo{FullMethod: "/acme.v1.UserService/GetUser"},
			func(ctx context.Context, req any) (any, error) {
				return nil, fmt.Errorf("db: %w", context.DeadlineExceeded)
			})
	})
	if ev["grpcStatusCode"] != "DEADLINE_EXCEEDED" || ev["executionStatus"] != "TIMEOUT" {
		t.Fatalf("got %v/%v, want DEADLINE_EXCEEDED/TIMEOUT", ev["grpcStatusCode"], ev["executionStatus"])
	}
}

func TestStreamInterceptorMapsCtxErr(t *testing.T) {
	ev := recordAndGetEvent(t, func(b *Billing, ctx context.Context) {
		_ = b.StreamInterceptor()(nil, &fakeStream{ctx: ctx},
			&grpc.StreamServerInfo{FullMethod: "/acme.v1.UserService/Watch", IsServerStream: true},
			func(srv any, ss grpc.ServerStream) error { return context.Canceled })
	})
	if ev["grpcStatusCode"] != "CANCELLED" || ev["executionStatus"] != "CANCELLED" {
		t.Fatalf("got %v/%v, want CANCELLED/CANCELLED", ev["grpcStatusCode"], ev["executionStatus"])
	}
}

func TestRecordWithOptionsUnknownStatusIgnored(t *testing.T) {
	for _, bogus := range []string{"done", strings.Repeat("X", 25)} {
		ev := recordAndGetEvent(t, func(b *Billing, ctx context.Context) {
			b.RecordWithOptions(ctx, "GetUser", "UNARY", 1, status.Error(codes.DeadlineExceeded, "x"), 5,
				EventOptions{ExecutionStatus: bogus})
		})
		if ev["executionStatus"] != "TIMEOUT" {
			t.Errorf("bogus %q: executionStatus = %v, want derived TIMEOUT", bogus, ev["executionStatus"])
		}
		if ev["grpcMethod"] != "GetUser" || ev["customerId"] != "cust_001" {
			t.Errorf("bogus %q: rest of event not sent intact: %v", bogus, ev)
		}
	}
}

func TestNormalizeExecutionStatusRejectsUnknown(t *testing.T) {
	cases := map[string]string{
		"":                      "",
		"  ":                    "",
		" success ":             "SUCCESS",
		"hitl_required":         "HITL_REQUIRED",
		"validation_failed":     "VALIDATION_FAILED",
		"DONE":                  "",
		strings.Repeat("A", 21): "",
	}
	for in, want := range cases {
		if got := normalizeExecutionStatus(in); got != want {
			t.Errorf("normalizeExecutionStatus(%q) = %q, want %q", in, got, want)
		}
	}
}
