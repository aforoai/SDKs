package com.aforo.grpc.internal.transport;

import java.io.IOException;
import java.lang.reflect.Method;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Sends one ingest request. The default implementation, {@link #jdk(long)}, owns a
 * single pooled {@link HttpClient} that is reused for every request and shut down
 * on {@link #close()}. Tests pass their own implementation.
 *
 * <p>This file is the transport core. Edit it in the {@code java} module only and
 * run {@code scripts/sync-transport.sh java}; the variants carry copies.</p>
 */
public interface HttpSender extends AutoCloseable {

    /** Status, body, {@code Retry-After} and {@code Location} headers of one response. */
    final class Response {
        private final int status;
        private final String body;
        private final String retryAfter;
        private final String location;

        public Response(int status, String body, String retryAfter) {
            this(status, body, retryAfter, null);
        }

        public Response(int status, String body, String retryAfter, String location) {
            this.status = status;
            this.body = body;
            this.retryAfter = retryAfter;
            this.location = location;
        }

        public int status() { return status; }
        public String body() { return body; }
        public String retryAfter() { return retryAfter; }
        /** {@code Location} of a 3xx answer; redirects are never followed. */
        public String location() { return location; }
    }

    /**
     * POSTs {@code body} with a total deadline of {@code timeoutMs}.
     *
     * @throws IOException          network error, connection reset or timeout
     * @throws InterruptedException the calling thread was interrupted
     */
    Response post(URI uri, Map<String, String> headers, String body, long timeoutMs)
            throws IOException, InterruptedException;

    /**
     * POSTs raw bytes (the core uses this for every batch; wave 8, G269). The default is for
     * senders that work on text, such as test fakes: a gzip body is decoded and handed to
     * {@link #post(URI, Map, String, long)} without the {@code Content-Encoding} header, so a
     * text sender always sees the JSON. The JDK sender overrides it and sends the bytes as they are.
     */
    default Response postBytes(URI uri, Map<String, String> headers, byte[] body, long timeoutMs)
            throws IOException, InterruptedException {
        String encoding = null;
        Map<String, String> plain = new java.util.LinkedHashMap<>();
        for (Map.Entry<String, String> h : headers.entrySet()) {
            if (h.getKey().equalsIgnoreCase("Content-Encoding")) encoding = h.getValue();
            else plain.put(h.getKey(), h.getValue());
        }
        byte[] json = body;
        if ("gzip".equalsIgnoreCase(encoding)) {
            try (java.util.zip.GZIPInputStream in = new java.util.zip.GZIPInputStream(new java.io.ByteArrayInputStream(body))) {
                json = in.readAllBytes();
            }
        }
        return post(uri, java.util.Collections.unmodifiableMap(plain), new String(json, StandardCharsets.UTF_8), timeoutMs);
    }

    @Override
    void close();

    /** One {@link HttpClient} for the life of the SDK client. */
    static HttpSender jdk(long connectTimeoutMs) {
        return new JdkSender(connectTimeoutMs);
    }

    /** Default sender on {@code java.net.http}. */
    final class JdkSender implements HttpSender {
        private static final Logger LOG = Logger.getLogger(JdkSender.class.getName());
        private final HttpClient client;

        JdkSender(long connectTimeoutMs) {
            this.client = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofMillis(Math.max(1, connectTimeoutMs)))
                    .followRedirects(HttpClient.Redirect.NEVER)
                    .build();
        }

        /**
         * {@code timeoutMs} covers the whole exchange: connect, headers and reading the
         * body. {@code HttpRequest.timeout} alone stops at the headers, so a server that
         * stalls mid-body or drips one byte at a time would hold the request forever.
         * An interrupt (close() at the shutdown deadline) cancels the exchange.
         */
        @Override
        public Response post(URI uri, Map<String, String> headers, String body, long timeoutMs)
                throws IOException, InterruptedException {
            return postBytes(uri, headers, body.getBytes(StandardCharsets.UTF_8), timeoutMs);
        }

        @Override
        public Response postBytes(URI uri, Map<String, String> headers, byte[] body, long timeoutMs)
                throws IOException, InterruptedException {
            long deadline = Math.max(1, timeoutMs);
            HttpRequest.Builder b = HttpRequest.newBuilder(uri)
                    .timeout(Duration.ofMillis(deadline))
                    .POST(HttpRequest.BodyPublishers.ofByteArray(body));
            headers.forEach(b::header);
            CompletableFuture<HttpResponse<String>> exchange =
                    client.sendAsync(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            HttpResponse<String> r;
            try {
                r = exchange.get(deadline, TimeUnit.MILLISECONDS);
            } catch (TimeoutException e) {
                exchange.cancel(true);
                throw new HttpTimeoutException("ingest request did not complete within " + deadline + " ms");
            } catch (InterruptedException e) {
                exchange.cancel(true);
                throw e;
            } catch (ExecutionException e) {
                Throwable cause = e.getCause();
                if (cause instanceof IOException io) throw io;
                throw new IOException("ingest request failed: " + (cause == null ? e : cause).getClass().getSimpleName(),
                        cause == null ? e : cause);
            }
            return new Response(r.statusCode(), r.body(), r.headers().firstValue("Retry-After").orElse(null),
                    r.headers().firstValue("Location").orElse(null));
        }

        /**
         * Shuts the client down on Java 21+ ({@code HttpClient.shutdownNow()}); on
         * Java 17 the client has no close method and its threads end when idle.
         */
        @Override
        public void close() {
            try {
                Method m = HttpClient.class.getMethod("shutdownNow");
                m.invoke(client);
            } catch (NoSuchMethodException e) {
                LOG.log(Level.FINE, "HttpClient.shutdownNow is not available on this Java version", e);
            } catch (ReflectiveOperationException | RuntimeException e) {
                LOG.log(Level.FINE, "Closing the HTTP client failed", e);
            }
        }

        @Override
        public String toString() {
            return "HttpSender.JdkSender";
        }
    }
}
