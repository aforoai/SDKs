package com.aforo.metering.internal.transport;

import com.aforo.metering.internal.transport.Fakes.FakeTiming;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Wave 8, G269: gzip on the wire, as the core hands it to the JDK sender. */
@DisplayName("TransportCore — request compression")
class TransportCoreCompressionTest {

    /** Records the bytes and headers exactly as the core passes them to postBytes. */
    static final class WireSender implements HttpSender {
        final List<byte[]> bodies = Collections.synchronizedList(new ArrayList<>());
        final List<Map<String, String>> headers = Collections.synchronizedList(new ArrayList<>());
        final List<Integer> statuses = Collections.synchronizedList(new ArrayList<>());

        @Override
        public Response post(URI uri, Map<String, String> h, String body, long timeoutMs) {
            throw new AssertionError("the core must send through postBytes");
        }

        @Override
        public Response postBytes(URI uri, Map<String, String> h, byte[] body, long timeoutMs) {
            bodies.add(body);
            headers.add(h);
            int status = statuses.isEmpty() ? 202 : statuses.remove(0);
            return new Response(status, "", null);
        }

        @Override
        public void close() {
        }
    }

    private final WireSender sender = new WireSender();
    private final List<TransportCore<String>> open = new ArrayList<>();

    @AfterEach
    void closeAll() {
        open.forEach(TransportCore::close);
    }

    private TransportCore<String> core(TransportConfig.Builder b) {
        TransportCore<String> c = new TransportCore<>(b.build(),
                e -> "{\"idempotencyKey\":\"" + e + "\",\"customerId\":\"c1\",\"metricName\":\"api_calls\"}",
                (events, reason) -> { }, sender, new FakeTiming());
        open.add(c);
        return c;
    }

    private static TransportConfig.Builder config() {
        return TransportConfig.builder()
                .baseUrl("https://ingest.example.test")
                .apiKey("sk_live_secret_value")
                .flushIntervalMs(3_600_000)
                .breakerInitialMs(1_000_000)
                .flushCount(100);
    }

    private static String gunzip(byte[] body) throws IOException {
        try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(body))) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    void largeBatchIsGzipWithContentEncoding() throws IOException {
        TransportCore<String> c = core(config());
        for (int i = 0; i < 100; i++) c.track("k" + i);
        c.flush();
        assertThat(sender.headers.get(0)).containsEntry("Content-Encoding", "gzip");
        String json = gunzip(sender.bodies.get(0));
        assertThat(json).startsWith("{\"events\":[").contains("\"k0\"", "\"k99\"");
        assertThat(sender.bodies.get(0).length).isLessThan(json.length());
    }

    @Test
    void smallBatchIsPlainJson() {
        TransportCore<String> c = core(config());
        c.track("k1");
        c.flush();
        assertThat(sender.headers.get(0)).doesNotContainKey("Content-Encoding");
        assertThat(new String(sender.bodies.get(0), StandardCharsets.UTF_8)).startsWith("{\"events\":[");
    }

    @Test
    void retrySendsTheSameBytes() {
        sender.statuses.add(503);
        TransportCore<String> c = core(config().retryBaseMs(0));
        for (int i = 0; i < 100; i++) c.track("k" + i);
        c.flush();
        assertThat(sender.bodies).hasSize(2);
        assertThat(sender.bodies.get(1)).isEqualTo(sender.bodies.get(0));
    }

    @Test
    void compressionNoneAndCallerHeaderCannotForceAnEncoding() {
        TransportCore<String> c = core(config().compression("none").header("Content-Encoding", "br"));
        for (int i = 0; i < 100; i++) c.track("k" + i);
        c.flush();
        assertThat(sender.headers.get(0)).doesNotContainKey("Content-Encoding");
        assertThat(new String(sender.bodies.get(0), StandardCharsets.UTF_8)).startsWith("{\"events\":[");
    }

    @Test
    void unknownCompressionIsAConfigurationError() {
        assertThatThrownBy(() -> config().compression("br").build())
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("compression");
    }
}
