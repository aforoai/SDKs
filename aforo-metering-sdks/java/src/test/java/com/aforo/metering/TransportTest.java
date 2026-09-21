package com.aforo.metering;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("Transport — ingest authentication")
class TransportTest {

    /**
     * The ingestor authenticates the tenant key from X-API-Key only. A key sent as
     * Authorization: Bearer is parsed as a JWT and rejected 401, even when X-API-Key
     * is also present, so the transport must send X-API-Key alone.
     */
    @Test
    void sendsApiKeyHeaderAndNoBearer() throws Exception {
        AtomicReference<String> apiKey = new AtomicReference<>();
        AtomicReference<String> auth = new AtomicReference<>();
        AtomicReference<String> path = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/", exchange -> {
            apiKey.set(exchange.getRequestHeaders().getFirst("X-API-Key"));
            auth.set(exchange.getRequestHeaders().getFirst("Authorization"));
            path.set(exchange.getRequestURI().getPath());
            exchange.getRequestBody().readAllBytes();
            exchange.sendResponseHeaders(202, -1);
            exchange.close();
        });
        server.start();
        try {
            Transport transport = new Transport("http://localhost:" + server.getAddress().getPort() + "/",
                    "test-key", 5_000, 0, 10);
            FlushResult result = transport.send(List.of(new ResolvedEvent(
                    "cust_1", "api_calls", 1, "idem-1", "2026-09-21T00:00:00Z", Map.of())));

            assertThat(result.sent()).isEqualTo(1);
            assertThat(path.get()).isEqualTo("/v1/ingest/batch");
            assertThat(apiKey.get()).isEqualTo("test-key");
            assertThat(auth.get()).isNull();
        } finally {
            server.stop(0);
        }
    }
}
