package com.aforo.grpc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import io.grpc.CallOptions;
import io.grpc.ManagedChannel;
import io.grpc.MethodDescriptor;
import io.grpc.Server;
import io.grpc.ServerServiceDefinition;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.netty.shaded.io.grpc.netty.NettyChannelBuilder;
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder;
import io.grpc.stub.ClientCalls;
import io.grpc.stub.ServerCalls;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

/** Regression test for review finding 8: every call is metered exactly once, with the status the caller saw. */
class ReviewRegressionGrpcTest {

    static final MethodDescriptor.Marshaller<String> STR = new MethodDescriptor.Marshaller<>() {
        @Override public InputStream stream(String v) { return new ByteArrayInputStream(v.getBytes(StandardCharsets.UTF_8)); }
        @Override public String parse(InputStream in) {
            try { return new String(in.readAllBytes(), StandardCharsets.UTF_8); } catch (Exception e) { throw new RuntimeException(e); }
        }
    };

    static MethodDescriptor<String, String> unary(String name) {
        return MethodDescriptor.<String, String>newBuilder().setType(MethodDescriptor.MethodType.UNARY)
                .setFullMethodName("review.Svc/" + name).setRequestMarshaller(STR).setResponseMarshaller(STR).build();
    }

    @Test
    void handlerExceptionsAndDeadlinesAreMeteredOnce() throws Exception {
        ObjectMapper om = new ObjectMapper();
        List<JsonNode> events = new CopyOnWriteArrayList<>();
        HttpServer ingest = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        ingest.createContext("/", ex -> {
            om.readTree(com.aforo.testsupport.RequestBodies.read(ex)).get("events").forEach(events::add);
            ex.sendResponseHeaders(202, -1);
            ex.close();
        });
        ingest.start();
        AforoGrpcBilling billing = AforoGrpcBilling.newBuilder()
                .tenantId("t").productId("p").apiKey("k").serviceName("review.Svc")
                .ingestorUrl("http://127.0.0.1:" + ingest.getAddress().getPort())
                .customerResolver((call, headers) -> "cust_1").flushIntervalMs(60_000).build();

        MethodDescriptor<String, String> ok = unary("Ok"), thrower = unary("Throws"), slow = unary("Slow"),
                invalid = unary("Invalid");
        ServerServiceDefinition svc = ServerServiceDefinition.builder("review.Svc")
                .addMethod(ok, ServerCalls.asyncUnaryCall((req, obs) -> { obs.onNext("hi"); obs.onCompleted(); }))
                .addMethod(thrower, ServerCalls.asyncUnaryCall((req, obs) -> { throw new NullPointerException("bug"); }))
                .addMethod(invalid, ServerCalls.asyncUnaryCall((req, obs) ->
                        obs.onError(Status.INVALID_ARGUMENT.asRuntimeException())))
                .addMethod(slow, ServerCalls.asyncUnaryCall((req, obs) -> {
                    try { Thread.sleep(500); } catch (InterruptedException ignored) { }
                    obs.onNext("late");
                    obs.onCompleted();
                }))
                .build();
        Server server = NettyServerBuilder.forAddress(new InetSocketAddress("127.0.0.1", 0))
                .addService(svc).intercept(billing.interceptor()).build().start();
        ManagedChannel ch = NettyChannelBuilder.forAddress("127.0.0.1", server.getPort()).usePlaintext().build();
        try {
            for (MethodDescriptor<String, String> m : List.of(ok, thrower, invalid, slow)) {
                CallOptions opts = m == slow ? CallOptions.DEFAULT.withDeadlineAfter(100, TimeUnit.MILLISECONDS)
                        : CallOptions.DEFAULT;
                try {
                    ClientCalls.blockingUnaryCall(ch, m, opts, "x");
                } catch (StatusRuntimeException expected) {
                    // Throws -> UNKNOWN, Invalid -> INVALID_ARGUMENT, Slow -> DEADLINE_EXCEEDED
                }
            }
            Thread.sleep(800); // the slow handler finishes and closes the already-cancelled call
        } finally {
            ch.shutdownNow();
            server.shutdownNow();
            billing.close();
            ingest.stop(0);
        }
        Map<String, String> byMethod = events.stream().collect(Collectors.toMap(
                e -> e.get("grpcMethod").asText(),
                e -> e.get("grpcStatusCode").asText() + "/" + e.get("executionStatus").asText()));
        assertThat(events).hasSize(4);
        assertThat(byMethod).containsEntry("Ok", "OK/SUCCESS")
                .containsEntry("Throws", "UNKNOWN/ERROR")
                .containsEntry("Invalid", "INVALID_ARGUMENT/VALIDATION_FAILED")
                .containsEntry("Slow", "DEADLINE_EXCEEDED/TIMEOUT");
    }
}
