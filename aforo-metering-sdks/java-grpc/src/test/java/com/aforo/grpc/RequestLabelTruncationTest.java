package com.aforo.grpc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

import static org.assertj.core.api.Assertions.assertThat;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ServerCall;
import io.grpc.Status;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.concurrent.atomic.AtomicReference;

@DisplayName("AforoGrpcBilling — over-long method name from the call is truncated, not dropped")
class RequestLabelTruncationTest {

    private static final MethodDescriptor.Marshaller<String> MARSHALLER = new MethodDescriptor.Marshaller<>() {
        @Override public InputStream stream(String value) { return new ByteArrayInputStream(value.getBytes()); }
        @Override public String parse(InputStream stream) { return ""; }
    };

    private static final Metadata.Key<String> CUSTOMER =
            Metadata.Key.of("x-customer-id", Metadata.ASCII_STRING_MARSHALLER);

    private AforoGrpcBilling.Builder builder() {
        return AforoGrpcBilling.newBuilder().tenantId("tenant-001").productId("prod-grpc")
                .apiKey("sk_test").ingestorUrl("http://127.0.0.1:" + port).serviceName("acme.v1.UserService")
                .flushIntervalMs(60_000);
    }

    /** Drives the interceptor for one call to {@code pkg.Svc/<method>} and closes it OK. */
    private static void call(AforoGrpcBilling billing, String method, String customerId) {
        MethodDescriptor<String, String> descriptor = MethodDescriptor.<String, String>newBuilder()
                .setType(MethodDescriptor.MethodType.UNARY)
                .setFullMethodName("pkg.Svc/" + method)
                .setRequestMarshaller(MARSHALLER).setResponseMarshaller(MARSHALLER).build();
        ServerCall<String, String> raw = new ServerCall<>() {
            @Override public void request(int numMessages) { }
            @Override public void sendHeaders(Metadata headers) { }
            @Override public void sendMessage(String message) { }
            @Override public void close(Status status, Metadata trailers) { }
            @Override public boolean isCancelled() { return false; }
            @Override public MethodDescriptor<String, String> getMethodDescriptor() { return descriptor; }
        };
        Metadata headers = new Metadata();
        headers.put(CUSTOMER, customerId);
        AtomicReference<ServerCall<String, String>> wrapped = new AtomicReference<>();
        billing.interceptor().interceptCall(raw, headers, (c, h) -> {
            wrapped.set(c);
            return new ServerCall.Listener<>() { };
        });
        wrapped.get().close(Status.OK, new Metadata());
    }

    @Test
    @DisplayName("interceptor: 200-char method: event sent, label cut to 128, one warning for two calls, keys from the full name")
    void overLongMethodFromCallIsTruncatedAndSent() throws Exception {
        String methodA = "M" + "x".repeat(198) + "A";
        String methodB = "M" + "x".repeat(198) + "B"; // same first 128 characters
        List<AforoGrpcBilling.DropReason> reasons = new CopyOnWriteArrayList<>();
        try (AforoGrpcBilling b = builder().flushCount(2).onDrop((e, r) -> reasons.add(r)).build()) {
            call(b, methodA, "cust_001");
            call(b, methodB, "cust_001");
            assertThat(b.droppedCount()).isZero();
            waitFor(() -> received.size() == 2, 3000);
        }
        assertThat(reasons).isEmpty();
        assertThat(received).hasSize(2);
        assertThat(received.get(0).get("grpcMethod").asText()).isEqualTo(methodA.substring(0, 128));
        assertThat(received.get(1).get("grpcMethod").asText()).isEqualTo(methodB.substring(0, 128));
        assertThat(truncationWarnings()).hasSize(1);
        assertThat(truncationWarnings().get(0)).contains("grpcMethod").contains("128");

        String naturalA = "grpc:tenant-001:acme.v1.UserService:" + methodA;
        String naturalB = "grpc:tenant-001:acme.v1.UserService:" + methodB;
        String keyA = received.get(0).get("idempotencyKey").asText();
        String keyB = received.get(1).get("idempotencyKey").asText();
        assertThat(keyA.length()).isLessThanOrEqualTo(255);
        // Built from the untruncated method (natural part is 236 chars > room, so it carries the digest).
        assertThat(naturalPart(keyA)).isEqualTo(AforoGrpcBilling.fitKeyPart(naturalA, ROOM))
                .isEqualTo(AforoGrpcBilling.fitKeyPart(naturalA, ROOM));
        assertThat(naturalPart(keyB)).isEqualTo(AforoGrpcBilling.fitKeyPart(naturalB, ROOM))
                .isNotEqualTo(naturalPart(keyA));
    }

    @Test
    @DisplayName("interceptor: a method within the limit is sent as-is with the plain key and no warning")
    void methodWithinLimitIsUntouched() throws Exception {
        try (AforoGrpcBilling b = builder().flushCount(1).build()) {
            call(b, "GetUser", "cust_001");
            waitFor(() -> received.size() == 1, 3000);
        }
        assertThat(received.get(0).get("grpcMethod").asText()).isEqualTo("GetUser");
        assertThat(naturalPart(received.get(0).get("idempotencyKey").asText()))
                .isEqualTo("grpc:tenant-001:acme.v1.UserService:GetUser");
        assertThat(truncationWarnings()).isEmpty();
    }

    @Test
    @DisplayName("interceptor: an over-long customerId is still dropped as INVALID")
    void overLongCustomerIdStillDropped() throws Exception {
        List<AforoGrpcBilling.DropReason> reasons = new CopyOnWriteArrayList<>();
        try (AforoGrpcBilling b = builder().flushCount(1).onDrop((e, r) -> reasons.add(r)).build()) {
            call(b, "M".repeat(200), "c".repeat(65));
            assertThat(b.droppedCount()).isEqualTo(1);
            Thread.sleep(100);
        }
        assertThat(received).isEmpty();
        assertThat(reasons).containsExactly(AforoGrpcBilling.DropReason.INVALID);
    }

    @Test
    @DisplayName("record(): a method over 128 passed by the integration is truncated and sent; key from the full name")
    void explicitOverLongMethodIsTruncatedAndSent() throws Exception {
        String method = "m".repeat(127) + "\uD83D\uDE00" + "tail".repeat(30); // pair straddles index 127/128
        List<AforoGrpcBilling.DropReason> reasons = new CopyOnWriteArrayList<>();
        try (AforoGrpcBilling b = builder().flushCount(2).onDrop((e, r) -> reasons.add(r)).build()) {
            b.record("m".repeat(129), "UNARY", "cust_001", "OK", 1L);
            b.record(method, "UNARY", "cust_001", "OK", 1L);
            assertThat(b.droppedCount()).isZero();
            waitFor(() -> received.size() == 2, 3000);
        }
        assertThat(reasons).isEmpty();
        assertThat(received.get(0).get("grpcMethod").asText()).isEqualTo("m".repeat(128));
        assertThat(received.get(1).get("grpcMethod").asText()).isEqualTo("m".repeat(127)); // pair not split
        assertThat(truncationWarnings()).hasSize(1);
        assertThat(naturalPart(received.get(1).get("idempotencyKey").asText()))
                .isEqualTo(AforoGrpcBilling.fitKeyPart("grpc:tenant-001:acme.v1.UserService:" + method, ROOM));
    }

    @Test
    @DisplayName("record(): an over-long customerId is still dropped as INVALID")
    void explicitOverLongCustomerIdStillDropped() throws Exception {
        List<AforoGrpcBilling.DropReason> reasons = new CopyOnWriteArrayList<>();
        try (AforoGrpcBilling b = builder().flushCount(1).onDrop((e, r) -> reasons.add(r)).build()) {
            b.record("m".repeat(200), "UNARY", "c".repeat(65), "OK", 1L);
            assertThat(b.droppedCount()).isEqualTo(1);
            Thread.sleep(100);
        }
        assertThat(received).isEmpty();
        assertThat(reasons).containsExactly(AforoGrpcBilling.DropReason.INVALID);
    }

    private final ObjectMapper mapper = new ObjectMapper();
    private final List<JsonNode> received = new CopyOnWriteArrayList<>();
    private final List<String> warnings = new CopyOnWriteArrayList<>();
    private final Logger sdkLog = Logger.getLogger(AforoGrpcBilling.class.getName());
    private final Handler capture = new Handler() {
        @Override public void publish(LogRecord r) {
            if (r.getLevel() == Level.WARNING) warnings.add(r.getMessage());
        }
        @Override public void flush() { }
        @Override public void close() { }
    };
    private HttpServer server;
    private int port;

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        port = server.getAddress().getPort();
        server.createContext("/", exchange -> {
            JsonNode body = mapper.readTree(exchange.getRequestBody().readAllBytes());
            body.get("events").forEach(received::add);
            exchange.sendResponseHeaders(202, -1);
            exchange.close();
        });
        server.start();
        sdkLog.addHandler(capture);
    }

    @AfterEach
    void stopServer() {
        sdkLog.removeHandler(capture);
        server.stop(0);
    }

    private List<String> truncationWarnings() {
        return warnings.stream().filter(w -> w.contains("truncated to")).toList();
    }

    /** The key without its {@code :<epochMillis>:<8 hex>} suffix. */
    private static String naturalPart(String key) {
        int last = key.lastIndexOf(':');
        return key.substring(0, key.lastIndexOf(':', last - 1));
    }

    /** Room left for the natural part: 255 minus {@code :<13-digit millis>:<8 hex>}. */
    private static final int ROOM = 255 - 1 - 13 - 1 - 8;

    @Test
    @DisplayName("fitKeyPart: short input unchanged; long input is head + SHA-256 of the whole value")
    void fitKeyPartIsDeterministicAndCollisionFree() {
        assertThat(AforoGrpcBilling.fitKeyPart("abc:def", ROOM)).isEqualTo("abc:def");
        String exact = "k".repeat(ROOM);
        assertThat(AforoGrpcBilling.fitKeyPart(exact, ROOM)).isEqualTo(exact);

        String a = "p".repeat(400) + "A";
        String b = "p".repeat(400) + "B";
        String fa = AforoGrpcBilling.fitKeyPart(a, ROOM);
        assertThat(fa).hasSize(ROOM).isEqualTo(AforoGrpcBilling.fitKeyPart(a, ROOM))
                .endsWith(":" + AforoGrpcBilling.sha256Hex(a));
        assertThat(AforoGrpcBilling.fitKeyPart(b, ROOM)).isNotEqualTo(fa);
    }

    @Test
    @DisplayName("truncateLabel counts UTF-16 units and never splits a surrogate pair")
    void truncateLabelKeepsPairsWhole() {
        assertThat(AforoGrpcBilling.truncateLabel(null, 5)).isNull();
        assertThat(AforoGrpcBilling.truncateLabel("abcdef", 5)).isEqualTo("abcde");
        assertThat(AforoGrpcBilling.truncateLabel("abcd\uD83D\uDE00", 5)).isEqualTo("abcd");
        assertThat(AforoGrpcBilling.truncateLabel("abc\uD83D\uDE00x", 5)).isEqualTo("abc\uD83D\uDE00");
    }

    private static void waitFor(java.util.function.BooleanSupplier cond, long timeoutMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (!cond.getAsBoolean() && System.currentTimeMillis() < deadline) Thread.sleep(20);
    }
}
