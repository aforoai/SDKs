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
 * Drop observability + onDrop hook (A+ delivery-guarantee prompt 6 —
 * transport-variant mirror of the core SDK's drop hardening).
 *
 * The buffer is unbounded and drained at flush start, so the only drop
 * sites are retry exhaustion and terminal rejection — no OVERFLOW.
 * retryBackoffBaseMs is set to 1ms so tests skip the real backoff.
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

    private AforoGrpcBilling newBilling(String url, BiConsumer<List<Map<String, Object>>, AforoGrpcBilling.DropReason> onDrop) {
        AforoGrpcBilling.Builder b = AforoGrpcBilling.newBuilder()
                .tenantId("tenant-001")
                .productId("prod-grpc-001")
                .apiKey("sk_test_abc")
                .ingestorUrl(url)
                .serviceName("acme.v1.UserService")
                .flushCount(100)
                .flushIntervalMs(60_000L);
        if (onDrop != null) b.onDrop(onDrop);
        AforoGrpcBilling billing = b.build();
        billing.retryBackoffBaseMs = 1L; // skip real retry sleeps in tests
        return billing;
    }

    private void recordOne(AforoGrpcBilling billing, String customerId) {
        billing.record("GetUser", "UNARY", customerId, "OK", 5);
    }

    @Test
    void terminal5xxDropsCountsAndFiresHookWithKeys() {
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
        assertThat(reasons).containsExactly(AforoGrpcBilling.DropReason.RETRY_EXHAUSTED);
        assertThat(dropped).hasSize(2);
        // Events keep their keys — dedup-safe replay is possible
        assertThat(dropped.get(0).get("idempotencyKey").toString()).startsWith("grpc:");
        assertThat(hits.get()).isEqualTo(3); // retry count unchanged
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
    void networkFailureClassifiedRetryExhaustedAndCloseCompletes() throws IOException {
        int closedPort;
        try (ServerSocket s = new ServerSocket(0)) {
            closedPort = s.getLocalPort();
        }
        List<AforoGrpcBilling.DropReason> reasons = new CopyOnWriteArrayList<>();
        AforoGrpcBilling billing = newBilling("http://localhost:" + closedPort, (events, reason) -> reasons.add(reason));

        recordOne(billing, "cust_1");
        billing.close(); // flushQuietly swallows the rethrown exception

        assertThat(billing.droppedCount()).isEqualTo(1);
        assertThat(reasons).containsExactly(AforoGrpcBilling.DropReason.RETRY_EXHAUSTED);
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
    void interruptedBackoffStillAccountsTheDrop() throws Exception {
        status.set(503);
        AforoGrpcBilling billing = newBilling("http://localhost:" + port, null);
        billing.retryBackoffBaseMs = 60_000L; // park the flush in the backoff sleep

        recordOne(billing, "cust_1");
        Thread closer = new Thread(billing::close); // close() flushes on the calling thread
        closer.start();
        Thread.sleep(500); // let the first attempt complete and reach the sleep
        closer.interrupt();
        closer.join(5_000);

        assertThat(closer.isAlive()).isFalse();
        assertThat(billing.droppedCount()).isEqualTo(1); // batch accounted despite the interrupt
    }
}
