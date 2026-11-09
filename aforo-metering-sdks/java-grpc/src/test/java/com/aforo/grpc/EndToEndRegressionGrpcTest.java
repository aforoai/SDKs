package com.aforo.grpc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import io.grpc.CallOptions;
import io.grpc.ManagedChannel;
import io.grpc.MethodDescriptor;
import io.grpc.Server;
import io.grpc.ServerServiceDefinition;
import io.grpc.netty.shaded.io.grpc.netty.NettyChannelBuilder;
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder;
import io.grpc.stub.ClientCalls;
import io.grpc.stub.ServerCalls;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Regression for the 2026-11-09 end-to-end test: the README told streaming handlers to call
 * {@code record(...)} for exact message counts, but no overload took a count (always 1).
 */
class EndToEndRegressionGrpcTest {
    static final MethodDescriptor.Marshaller<String> STR = new MethodDescriptor.Marshaller<>() {
        public InputStream stream(String v) { return new ByteArrayInputStream(v.getBytes(StandardCharsets.UTF_8)); }
        public String parse(InputStream in) {
            try { return new String(in.readAllBytes(), StandardCharsets.UTF_8); } catch (Exception e) { throw new RuntimeException(e); }
        }
    };

    @Test
    void aStreamingHandlerRecordsItsRealMessageCount() throws Exception {
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
                .tenantId("t").productId("p").apiKey("k").serviceName("e2e.Svc")
                .ingestorUrl("http://127.0.0.1:" + ingest.getAddress().getPort())
                .customerResolver((call, headers) -> "cust_1").flushIntervalMs(60_000).build();

        MethodDescriptor<String, String> list = MethodDescriptor.<String, String>newBuilder()
                .setType(MethodDescriptor.MethodType.SERVER_STREAMING).setFullMethodName("e2e.Svc/ListItems")
                .setRequestMarshaller(STR).setResponseMarshaller(STR).build();
        // The README pattern: the handler reports its own count (1 request received + 5 responses sent).
        ServerServiceDefinition svc = ServerServiceDefinition.builder("e2e.Svc")
                .addMethod(list, ServerCalls.asyncServerStreamingCall((req, obs) -> {
                    long start = System.currentTimeMillis();
                    int sent = 0;
                    for (int i = 0; i < 5; i++) { obs.onNext("item" + i); sent++; }
                    obs.onCompleted();
                    billing.record("ListItems", "SERVER_STREAM", "cust_1", "OK",
                            System.currentTimeMillis() - start, 1 + sent);
                }))
                .build();
        Server server = NettyServerBuilder.forAddress(new InetSocketAddress("127.0.0.1", 0)).addService(svc).build().start();
        ManagedChannel ch = NettyChannelBuilder.forAddress("127.0.0.1", server.getPort()).usePlaintext().build();
        try {
            Iterator<String> it = ClientCalls.blockingServerStreamingCall(ch, list, CallOptions.DEFAULT, "q");
            int got = 0;
            while (it.hasNext()) { it.next(); got++; }
            assertThat(got).isEqualTo(5);

            billing.record("Upload", "CLIENT_STREAM", "cust_1", "OK", 4L, 9, "PARTIAL", "AGENTIC_API");
            billing.record("Neg", "BIDI_STREAM", "cust_1", "OK", 1L, -3);
            billing.record("Legacy", "UNARY", "cust_1", "OK", 1L, null);   // existing callers still compile: 1
            billing.record("Legacy2", "UNARY", "cust_1", "OK", 1L, "SUCCESS");
        } finally {
            ch.shutdownNow().awaitTermination(5, TimeUnit.SECONDS);
            server.shutdownNow().awaitTermination(5, TimeUnit.SECONDS);
            billing.close();
            ingest.stop(0);
        }

        assertThat(events).hasSize(5);
        JsonNode stream = byMethod(events, "ListItems");
        assertThat(stream.get("messageCount").asInt()).isEqualTo(6);
        assertThat(stream.get("grpcCallType").asText()).isEqualTo("SERVER_STREAM");
        assertThat(stream.get("executionStatus").asText()).isEqualTo("SUCCESS");
        JsonNode upload = byMethod(events, "Upload");
        assertThat(upload.get("messageCount").asInt()).isEqualTo(9);
        assertThat(upload.get("executionStatus").asText()).isEqualTo("PARTIAL");
        assertThat(upload.get("productType").asText()).isEqualTo("AGENTIC_API");
        assertThat(byMethod(events, "Neg").get("messageCount").asInt()).isZero();
        assertThat(byMethod(events, "Legacy").get("messageCount").asInt()).isEqualTo(1);
        assertThat(byMethod(events, "Legacy2").get("messageCount").asInt()).isEqualTo(1);
    }

    private static JsonNode byMethod(List<JsonNode> events, String method) {
        return events.stream().filter(e -> e.get("grpcMethod").asText().equals(method)).findFirst().orElseThrow();
    }
}
