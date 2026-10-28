package com.aforo.grpc;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiConsumer;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Drop accounting and the onDrop hook on the wave 5 transport core (G266, G267, G307).
 * An outage no longer drops events: they stay queued with their keys and are only
 * reported (SHUTDOWN) when close() reaches its deadline.
 */
class AforoGrpcDropTest {

    private HttpServer server;
    private int port;
    private final AtomicInteger status = new AtomicInteger(204);
    private final AtomicInteger hits = new AtomicInteger();

    @BeforeEach
    void start() throws IOException {
        hits.set(0);
        status.set(204);
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/", ex -> {
            hits.incrementAndGet();
            ex.getRequestBody().readAllBytes();
            ex.sendResponseHeaders(status.get(), -1);
            ex.close();
        });
        server.start();
        port = server.getAddress().getPort();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private AforoGrpcBilling.Builder builder(String url, BiConsumer<List<Map<String, Object>>, AforoGrpcBilling.DropReason> onDrop) {
        AforoGrpcBilling.Builder b = AforoGrpcBilling.newBuilder()
                .tenantId("tenant-001")
                .productId("prod-grpc-001")
                .apiKey("sk_test_abc")
                .ingestorUrl(url)
                .serviceName("acme.v1.UserService")
                .trustCustomerHeader(true)
                .flushCount(100)
                .flushIntervalMs(60_000L)
                .maxRetries(2)
                .retryBaseMs(1)
                .breakerCooldownMs(60_000)
                .shutdownTimeoutMs(300);
        if (onDrop != null) b.onDrop(onDrop);
        return b;
    }

    private AforoGrpcBilling newBilling(String url, BiConsumer<List<Map<String, Object>>, AforoGrpcBilling.DropReason> onDrop) {
        return builder(url, onDrop).build();
    }

    private void recordOne(AforoGrpcBilling billing, String customerId) {
        billing.record("GetUser", "UNARY", customerId, "OK", 5);
    }

    @Test
    void outageKeepsEventsQueuedAndReportsThemAtShutdownWithKeys() {
        status.set(503);
        List<Map<String, Object>> dropped = new CopyOnWriteArrayList<>();
        List<AforoGrpcBilling.DropReason> reasons = new CopyOnWriteArrayList<>();
        AforoGrpcBilling billing = newBilling("http://localhost:" + port, (events, reason) -> {
            dropped.addAll(events);
            reasons.add(reason);
        });

        recordOne(billing, "cust_1");
        recordOne(billing, "cust_2");
        billing.close();

        assertThat(billing.droppedCount()).isEqualTo(2);
        assertThat(reasons).containsExactly(AforoGrpcBilling.DropReason.SHUTDOWN);
        assertThat(dropped).hasSize(2);
        // Events keep their keys — dedup-safe replay is possible
        assertThat(dropped.get(0).get("idempotencyKey").toString()).startsWith("grpc:");
        assertThat(hits.get()).isGreaterThanOrEqualTo(3); // 1 attempt + 2 retries before the breaker opened
    }

    @Test
    void terminal4xxClassifiedRejected() {
        status.set(400);
        List<AforoGrpcBilling.DropReason> reasons = new CopyOnWriteArrayList<>();
        AforoGrpcBilling billing = newBilling("http://localhost:" + port, (events, reason) -> reasons.add(reason));

        recordOne(billing, "cust_1");
        billing.close();

        assertThat(billing.droppedCount()).isEqualTo(1);
        assertThat(reasons).containsExactly(AforoGrpcBilling.DropReason.REJECTED);
        assertThat(hits.get()).isEqualTo(1); // a 400 cannot succeed on retry — sent once
    }

    @Test
    void networkFailureKeepsTheEventUntilTheShutdownDeadline() throws IOException {
        int closedPort;
        try (ServerSocket s = new ServerSocket(0)) {
            closedPort = s.getLocalPort();
        }
        List<AforoGrpcBilling.DropReason> reasons = new CopyOnWriteArrayList<>();
        AforoGrpcBilling billing = newBilling("http://localhost:" + closedPort, (events, reason) -> reasons.add(reason));

        recordOne(billing, "cust_1");
        long start = System.nanoTime();
        billing.close();

        assertThat((System.nanoTime() - start) / 1_000_000).isLessThan(2_000); // bounded by shutdownTimeoutMs
        assertThat(billing.droppedCount()).isEqualTo(1);
        assertThat(reasons).containsExactly(AforoGrpcBilling.DropReason.SHUTDOWN);
    }

    @Test
    void throwingHookIsHarmless() {
        status.set(503);
        AforoGrpcBilling billing = newBilling("http://localhost:" + port, (events, reason) -> {
            throw new RuntimeException("hook bug");
        });

        recordOne(billing, "cust_1");
        billing.close(); // must not throw

        assertThat(billing.droppedCount()).isEqualTo(1);
    }

    @Test
    void defaultNoHookStillCounts() {
        status.set(503);
        AforoGrpcBilling billing = newBilling("http://localhost:" + port, null);

        recordOne(billing, "cust_1");
        billing.close();

        assertThat(billing.droppedCount()).isEqualTo(1);
    }

    @Test
    void happyPathUnchangedNoDrops() {
        List<AforoGrpcBilling.DropReason> reasons = new CopyOnWriteArrayList<>();
        AforoGrpcBilling billing = newBilling("http://localhost:" + port, (events, reason) -> reasons.add(reason));

        recordOne(billing, "cust_1");
        billing.close();

        assertThat(billing.droppedCount()).isZero();
        assertThat(reasons).isEmpty();
        assertThat(hits.get()).isEqualTo(1);
    }

    @Test
    void recordingAfterCloseIsReportedAsClosedAndDoesNotThrow() {
        List<AforoGrpcBilling.DropReason> reasons = new CopyOnWriteArrayList<>();
        AforoGrpcBilling billing = newBilling("http://localhost:" + port, (events, reason) -> reasons.add(reason));
        billing.close();

        recordOne(billing, "cust_1");

        assertThat(reasons).containsExactly(AforoGrpcBilling.DropReason.CLOSED);
        assertThat(billing.droppedCount()).isEqualTo(1);
    }

    @Test
    void fullQueueEvictsTheOldest() {
        List<Map<String, Object>> dropped = new CopyOnWriteArrayList<>();
        List<AforoGrpcBilling.DropReason> reasons = new CopyOnWriteArrayList<>();
        AforoGrpcBilling billing = builder("http://localhost:" + port, (events, reason) -> {
            dropped.addAll(events);
            reasons.add(reason);
        }).maxQueueSize(2).build();

        recordOne(billing, "cust_1");
        recordOne(billing, "cust_2");
        recordOne(billing, "cust_3");

        assertThat(reasons).containsExactly(AforoGrpcBilling.DropReason.OVERFLOW);
        assertThat(dropped.get(0).get("customerId")).isEqualTo("cust_1");
        assertThat(billing.bufferedCount()).isEqualTo(2);
        billing.close();
    }

    @Test
    void onErrorIsTypedByKind() {
        status.set(400);
        List<AforoGrpcBilling.MeteringError> errors = new CopyOnWriteArrayList<>();
        AforoGrpcBilling billing = builder("http://localhost:" + port, null).onError(errors::add).build();
        recordOne(billing, "cust_1");
        billing.close();
        assertThat(errors).extracting(AforoGrpcBilling.MeteringError::kind).containsExactly(AforoGrpcBilling.ErrorKind.REJECTED);
        assertThat(errors.get(0).status()).isEqualTo(400);
        assertThat(errors.get(0).willRetry()).isFalse();
        assertThat(errors.get(0).events()).hasSize(1);
    }

    @Test
    void onAcceptedRunsForAnAcceptedBatch() {
        List<Map<String, Object>> bodies = new CopyOnWriteArrayList<>();
        List<List<Map<String, Object>>> batches = new CopyOnWriteArrayList<>();
        AforoGrpcBilling billing = builder("http://localhost:" + port, null)
                .onAccepted((body, events) -> { bodies.add(body); batches.add(events); }).build();
        recordOne(billing, "cust_1");
        billing.close();
        assertThat(bodies).hasSize(1);
        assertThat(bodies.get(0)).isEmpty(); // a 204 has no body
        assertThat(batches.get(0)).hasSize(1);
    }
}
