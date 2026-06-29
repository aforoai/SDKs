# grpcmetering — Aforo gRPC Metering SDK for Go

Server interceptors that meter every RPC call (unary + streaming) and ship billing events to Aforo's usage ingestor.

## Install

```bash
go get github.com/aforo/grpc-metering-go
```

Peer dep: `google.golang.org/grpc ^1.60`.

## Usage

```go
package main

import (
    "context"
    "log"
    "net"
    "os"

    grpcmetering "github.com/aforo/grpc-metering-go"
    "google.golang.org/grpc"
)

func main() {
    billing, err := grpcmetering.New(grpcmetering.Config{
        TenantID:    "tenant_acme",
        ProductID:   "prod_grpc_user_svc",
        APIKey:      os.Getenv("AFORO_API_KEY"),
        IngestorURL: "https://ingestor.aforo.ai",
        ServiceName: "acme.v1.UserService",
    })
    if err != nil {
        log.Fatal(err)
    }
    defer billing.Shutdown(context.Background())

    server := grpc.NewServer(
        grpc.UnaryInterceptor(billing.UnaryInterceptor()),
        grpc.StreamInterceptor(billing.StreamInterceptor()),
    )
    // pb.RegisterUserServiceServer(server, &userServer{})

    lis, _ := net.Listen("tcp", ":50051")
    server.Serve(lis)
}
```

## Streaming RPCs — exact message counts

Both `UnaryInterceptor` and `StreamInterceptor` emit `messageCount = 1` per call by default — appropriate for unary, but undercounts streaming. For exact counts, call `billing.Record(...)` from inside your handler:

```go
func (s *server) ListUsers(req *pb.ListReq, stream pb.UserService_ListUsersServer) error {
    start := time.Now()
    n := 0
    for _, u := range users {
        if err := stream.Send(u); err != nil {
            return err
        }
        n++
    }
    billing.Record(stream.Context(), "ListUsers", "SERVER_STREAM", n, nil, time.Since(start).Milliseconds())
    return nil
}
```

## Customer-ID resolution

Default extractor reads `x-customer-id` from the gRPC metadata. Override:

```go
billing, _ := grpcmetering.New(grpcmetering.Config{
    // ...
    CustomerExtractor: func(ctx context.Context) string {
        md, _ := metadata.FromIncomingContext(ctx)
        return decodeJWT(md.Get("authorization")[0])
    },
})
```

Calls without a customer ID are not metered.

## Status code mapping

`status.Code()` → descriptor enum: `OK`, `CANCELLED`, `UNKNOWN`, `INVALID_ARGUMENT`, `DEADLINE_EXCEEDED`, `NOT_FOUND`, `ALREADY_EXISTS`, `PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`, `FAILED_PRECONDITION`, `ABORTED`, `OUT_OF_RANGE`, `UNIMPLEMENTED`, `INTERNAL`, `UNAVAILABLE`, `DATA_LOSS`, `UNAUTHENTICATED`.

## Batching & retry

50 events / 5 s defaults. `OnError` callback for terminal flush failures. Call `Shutdown(ctx)` for graceful drain.

## License

MIT
