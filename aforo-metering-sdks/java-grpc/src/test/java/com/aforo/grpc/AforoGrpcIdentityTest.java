package com.aforo.grpc;

import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import io.grpc.ServerCall;
import io.grpc.Status;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Handler;
import java.util.logging.LogRecord;
import java.util.logging.Logger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@DisplayName("AforoGrpcBilling — customer identity (G265) and call completion (G309)")
class AforoGrpcIdentityTest {

    private static final MethodDescriptor.Marshaller<String> MARSHALLER = new MethodDescriptor.Marshaller<>() {
        @Override public InputStream stream(String value) { return new ByteArrayInputStream(value.getBytes()); }
        @Override public String parse(InputStream stream) { return ""; }
    };
    private static final Metadata.Key<String> CUSTOMER =
            Metadata.Key.of("x-customer-id", Metadata.ASCII_STRING_MARSHALLER);

    private final List<AforoGrpcBilling.DropReason> reasons = new CopyOnWriteArrayList<>();

    private AforoGrpcBilling.Builder builder() {
        return AforoGrpcBilling.newBuilder().tenantId("tenant-001").productId("prod-grpc")
                .apiKey("sk_test").ingestorUrl("http://127.0.0.1:1").serviceName("acme.v1.UserService")
                .flushIntervalMs(60_000).shutdownTimeoutMs(0)
                .onDrop((events, reason) -> reasons.add(reason));
    }

    /** Runs one call through the interceptor; returns whether the underlying call was closed. */
    private static boolean call(AforoGrpcBilling billing, String method, String headerCustomer) {
        MethodDescriptor<String, String> descriptor = MethodDescriptor.<String, String>newBuilder()
                .setType(MethodDescriptor.MethodType.UNARY)
                .setFullMethodName("pkg.Svc/" + method)
                .setRequestMarshaller(MARSHALLER).setResponseMarshaller(MARSHALLER).build();
        AtomicBoolean closed = new AtomicBoolean();
        ServerCall<String, String> raw = new ServerCall<>() {
            @Override public void request(int numMessages) { }
            @Override public void sendHeaders(Metadata headers) { }
            @Override public void sendMessage(String message) { }
            @Override public void close(Status status, Metadata trailers) { closed.set(true); }
            @Override public boolean isCancelled() { return false; }
            @Override public MethodDescriptor<String, String> getMethodDescriptor() { return descriptor; }
        };
        Metadata headers = new Metadata();
        if (headerCustomer != null) headers.put(CUSTOMER, headerCustomer);
        AtomicReference<ServerCall<String, String>> wrapped = new AtomicReference<>();
        billing.interceptor().interceptCall(raw, headers, (c, h) -> {
            wrapped.set(c);
            return new ServerCall.Listener<>() { };
        });
        try {
            wrapped.get().close(Status.OK, new Metadata());
        } catch (RuntimeException e) {
            // A metering failure escaping close() is exactly the G309 bug; the assertion reports it.
            return closed.get();
        }
        return closed.get();
    }

    @Test
    void buildFailsWithoutACustomerSource() {
        assertThatThrownBy(() -> builder().build())
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("customerResolver")
                .hasMessageContaining("trustCustomerHeader(true)");
    }

    @Test
    void theMetadataIsIgnoredWhenAResolverIsSet() {
        try (AforoGrpcBilling b = builder().customerResolver((call, headers) -> "cust_from_mtls").build()) {
            call(b, "GetUser", "cust_spoofed");
            assertThat(b.bufferedCount()).isEqualTo(1);
            assertThat(reasons).isEmpty();
        }
    }

    @Test
    void trustedHeaderIsReadOnlyWithTheOptIn() {
        try (AforoGrpcBilling b = builder().trustCustomerHeader(true).build()) {
            call(b, "GetUser", "cust_header");
            assertThat(b.bufferedCount()).isEqualTo(1);
        }
    }

    @Test
    void aCallWithNoCustomerIsCountedAsInvalidAndStillClosed() {
        try (AforoGrpcBilling b = builder().customerResolver((call, headers) -> null).build()) {
            assertThat(call(b, "GetUser", "cust_spoofed")).isTrue();
            assertThat(b.bufferedCount()).isZero();
            assertThat(reasons).containsExactly(AforoGrpcBilling.DropReason.INVALID);
        }
    }

    @Test
    void aThrowingResolverNeverBreaksTheCall() {
        try (AforoGrpcBilling b = builder().customerResolver((call, headers) -> {
            throw new IllegalStateException("auth lookup failed");
        }).build()) {
            assertThat(call(b, "GetUser", null)).isTrue();
            assertThat(reasons).containsExactly(AforoGrpcBilling.DropReason.INVALID);
        }
    }

    /** G309: when metering throws inside close(), the RPC is still closed (super.close in finally). */
    @Test
    void meteringFailureStillClosesTheCall() {
        Logger logger = Logger.getLogger(AforoGrpcBilling.class.getName());
        Handler throwing = new Handler() {
            @Override public void publish(LogRecord record) { throw new IllegalStateException("log sink down"); }
            @Override public void flush() { }
            @Override public void close() { }
        };
        logger.addHandler(throwing);
        try (AforoGrpcBilling b = builder().trustCustomerHeader(true).build()) {
            // An over-long method logs a truncation warning inside record(); the handler throws.
            assertThat(call(b, "M".repeat(200), "cust_1")).isTrue();
        } finally {
            logger.removeHandler(throwing);
        }
    }
}
