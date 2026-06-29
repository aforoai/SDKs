/*
 * Real-server integration test for aforo:grpc-metering.
 *
 * Where AforoGrpcBillingTest uses mock ServerCall/ServerCallHandler,
 * this file:
 *   - spins up a REAL io.grpc Server via NettyServerBuilder on a
 *     random localhost port
 *   - registers a programmatically-defined UNARY service (no .proto)
 *     via ServerServiceDefinition + MethodDescriptor with JSON-bytes
 *     marshallers
 *   - installs billing.interceptor()
 *   - connects a REAL ManagedChannel and makes RPCs
 *   - asserts the metering event reaches a real HTTP capture server
 *
 * Catches what mock-based tests can't:
 *   - real Metadata propagation across the wire
 *   - ServerInterceptor firing on the real call-close path
 *   - real Status code → label mapping for OK + INVALID_ARGUMENT
 *   - real flush-over-HTTP round trip with Authorization headers
 */
package com.aforo.grpc;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.grpc.CallOptions;
import io.grpc.Channel;
import io.grpc.ClientCall;
import io.grpc.ClientInterceptor;
import io.grpc.ClientInterceptors;
import io.grpc.ForwardingClientCall;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.Server;
import io.grpc.ServerServiceDefinition;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.netty.shaded.io.grpc.netty.NettyChannelBuilder;
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder;
import io.grpc.stub.ServerCalls;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class AforoGrpcIntegrationTest {

    private static final ObjectMapper OM = new ObjectMapper();

    // Capture HTTP server for the ingestor
    private HttpServer captureServer;
    private int capturePort;
    private final List<Map<String, Object>> capturedBodies = new ArrayList<>();
    private final List<Map<String, List<String>>> capturedHeaders = new ArrayList<>();

    // gRPC
    private Server grpcServer;
    private ManagedChannel channel;
    private AforoGrpcBilling billing;

    // JSON-bytes marshallers — no .proto required
    private static final MethodDescriptor.Marshaller<Map<String, Object>> JSON_MARSHALLER =
            new MethodDescriptor.Marshaller<>() {
                @Override
                public InputStream stream(Map<String, Object> value) {
                    try {
                        return new ByteArrayInputStream(OM.writeValueAsBytes(value));
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                }

                @Override
                public Map<String, Object> parse(InputStream stream) {
                    try {
                        return OM.readValue(stream, new TypeReference<Map<String, Object>>() {});
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                }
            };

    private static final MethodDescriptor<Map<String, Object>, Map<String, Object>> SAY_HELLO =
            MethodDescriptor.<Map<String, Object>, Map<String, Object>>newBuilder()
                    .setType(MethodDescriptor.MethodType.UNARY)
                    .setFullMethodName("aforo.test.Greeter/SayHello")
                    .setRequestMarshaller(JSON_MARSHALLER)
                    .setResponseMarshaller(JSON_MARSHALLER)
                    .build();

    private static final MethodDescriptor<Map<String, Object>, Map<String, Object>> FAIL_HARD =
            MethodDescriptor.<Map<String, Object>, Map<String, Object>>newBuilder()
                    .setType(MethodDescriptor.MethodType.UNARY)
                    .setFullMethodName("aforo.test.Greeter/FailHard")
                    .setRequestMarshaller(JSON_MARSHALLER)
                    .setResponseMarshaller(JSON_MARSHALLER)
                    .build();

    private static final Metadata.Key<String> CUSTOMER_ID_KEY =
            Metadata.Key.of("x-customer-id", Metadata.ASCII_STRING_MARSHALLER);

    @BeforeEach
    void setUp() throws IOException {
        // Start capture HTTP server on a random port
        captureServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        captureServer.createContext("/", (HttpExchange ex) -> {
            byte[] body = ex.getRequestBody().readAllBytes();
            synchronized (capturedBodies) {
                try {
                    if (body.length > 0) {
                        Map<String, Object> parsed = OM.readValue(body, new TypeReference<>() {});
                        capturedBodies.add(parsed);
                    } else {
                        capturedBodies.add(Map.of());
                    }
                    capturedHeaders.add(Map.copyOf(ex.getRequestHeaders()));
                } catch (Exception ignore) {
                    capturedBodies.add(Map.of());
                }
            }
            ex.sendResponseHeaders(204, -1);
            ex.close();
        });
        captureServer.start();
        capturePort = captureServer.getAddress().getPort();

        // Build billing
        billing = AforoGrpcBilling.newBuilder()
                .tenantId("tenant-int-grpc")
                .productId("prod-int-grpc")
                .apiKey("sk_int_grpc")
                .serviceName("aforo.test.Greeter")
                .ingestorUrl("http://127.0.0.1:" + capturePort)
                .flushCount(1)
                .flushIntervalMs(60_000L)
                .build();

        // Start gRPC server on a random localhost port
        ServerServiceDefinition service = ServerServiceDefinition.builder("aforo.test.Greeter")
                .addMethod(SAY_HELLO, ServerCalls.asyncUnaryCall((req, respObs) -> {
                    respObs.onNext(Map.of("message", "hello " + req.getOrDefault("name", "anon")));
                    respObs.onCompleted();
                }))
                .addMethod(FAIL_HARD, ServerCalls.asyncUnaryCall((req, respObs) -> {
                    respObs.onError(Status.INVALID_ARGUMENT.withDescription("boom").asRuntimeException());
                }))
                .build();

        grpcServer = NettyServerBuilder.forAddress(new InetSocketAddress("127.0.0.1", 0))
                .addService(service)
                .intercept(billing.interceptor())
                .build()
                .start();

        channel = NettyChannelBuilder
                .forAddress("127.0.0.1", grpcServer.getPort())
                .usePlaintext()
                .build();
    }

    @AfterEach
    void tearDown() throws InterruptedException {
        if (channel != null) {
            channel.shutdownNow().awaitTermination(2, TimeUnit.SECONDS);
        }
        if (grpcServer != null) {
            grpcServer.shutdownNow().awaitTermination(2, TimeUnit.SECONDS);
        }
        if (billing != null) {
            billing.close();
        }
        if (captureServer != null) {
            captureServer.stop(0);
        }
    }

    private Channel withCustomerId(String customerId) {
        ClientInterceptor ci = new ClientInterceptor() {
            @Override
            public <ReqT, RespT> ClientCall<ReqT, RespT> interceptCall(
                    MethodDescriptor<ReqT, RespT> method, CallOptions callOptions, Channel next) {
                return new ForwardingClientCall.SimpleForwardingClientCall<>(next.newCall(method, callOptions)) {
                    @Override
                    public void start(Listener<RespT> responseListener, Metadata headers) {
                        headers.put(CUSTOMER_ID_KEY, customerId);
                        super.start(responseListener, headers);
                    }
                };
            }
        };
        return ClientInterceptors.intercept(channel, ci);
    }

    private Map<String, Object> unaryCall(MethodDescriptor<Map<String, Object>, Map<String, Object>> method,
                                          Map<String, Object> request,
                                          Channel ch) throws Exception {
        BlockingQueue<Object> q = new ArrayBlockingQueue<>(1);
        ClientCall<Map<String, Object>, Map<String, Object>> call = ch.newCall(method, CallOptions.DEFAULT);
        call.start(new ClientCall.Listener<Map<String, Object>>() {
            AtomicReference<Map<String, Object>> resp = new AtomicReference<>();

            @Override
            public void onMessage(Map<String, Object> message) {
                resp.set(message);
            }

            @Override
            public void onClose(Status status, Metadata trailers) {
                if (!status.isOk()) {
                    q.add(new StatusRuntimeException(status));
                } else {
                    q.add(resp.get() == null ? Map.of() : resp.get());
                }
            }
        }, new Metadata());
        call.sendMessage(request);
        call.halfClose();
        call.request(1);
        Object out = q.poll(5, TimeUnit.SECONDS);
        if (out instanceof StatusRuntimeException sre) throw sre;
        @SuppressWarnings("unchecked")
        Map<String, Object> m = (Map<String, Object>) out;
        return m;
    }

    private List<Map<String, Object>> waitForEvents(int count, long timeoutMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            List<Map<String, Object>> events = flatten();
            if (events.size() >= count) return events;
            Thread.sleep(25);
        }
        return flatten();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> flatten() {
        List<Map<String, Object>> out = new ArrayList<>();
        synchronized (capturedBodies) {
            for (Map<String, Object> body : capturedBodies) {
                Object evs = body.get("events");
                if (evs instanceof List<?> list) {
                    for (Object o : list) {
                        if (o instanceof Map<?, ?> m) out.add((Map<String, Object>) m);
                    }
                }
            }
        }
        return out;
    }

    // ── Tests ──────────────────────────────────────────────────────────

    @Test
    void unarySuccess_realRpc_emitsOkEvent() throws Exception {
        Map<String, Object> resp = unaryCall(SAY_HELLO, Map.of("name", "world"),
                withCustomerId("cust_grpc_001"));
        assertThat(resp).containsEntry("message", "hello world");

        List<Map<String, Object>> events = waitForEvents(1, 3000);
        assertThat(events).isNotEmpty();
        Map<String, Object> ev = events.get(0);
        assertThat(ev).containsEntry("productType", "GRPC_API");
        assertThat(ev).containsEntry("grpcService", "aforo.test.Greeter");
        assertThat(ev).containsEntry("grpcMethod", "SayHello");
        assertThat(ev).containsEntry("grpcStatusCode", "OK");
        assertThat(ev).containsEntry("grpcCallType", "UNARY");
        assertThat(ev).containsEntry("customerId", "cust_grpc_001");
    }

    @Test
    void unaryError_realRpc_emitsMappedStatusEvent() throws Exception {
        assertThatThrownBy(() -> unaryCall(FAIL_HARD, Map.of("name", "anything"),
                withCustomerId("cust_grpc_002")))
                .isInstanceOf(StatusRuntimeException.class);

        List<Map<String, Object>> events = waitForEvents(1, 3000);
        assertThat(events).isNotEmpty();
        Map<String, Object> ev = events.get(0);
        assertThat(ev).containsEntry("grpcMethod", "FailHard");
        assertThat(ev).containsEntry("grpcStatusCode", "INVALID_ARGUMENT");
        assertThat(ev).containsEntry("customerId", "cust_grpc_002");
    }

    @Test
    void authorizationAndTenantHeaders_reachIngestor() throws Exception {
        unaryCall(SAY_HELLO, Map.of("name", "headers"), withCustomerId("cust_grpc_hdr"));

        // Wait for the ingestor HTTP request to land
        long deadline = System.currentTimeMillis() + 3000;
        while (System.currentTimeMillis() < deadline && capturedHeaders.isEmpty()) {
            Thread.sleep(25);
        }
        assertThat(capturedHeaders).isNotEmpty();
        Map<String, List<String>> headers = capturedHeaders.get(0);
        // HttpExchange capitalizes keys; use case-insensitive lookup
        List<String> auth = headers.getOrDefault("Authorization", List.of());
        List<String> tenant = headers.getOrDefault("X-tenant-id", headers.getOrDefault("X-Tenant-Id", List.of()));
        assertThat(auth).contains("Bearer sk_int_grpc");
        assertThat(tenant).contains("tenant-int-grpc");
    }
}
