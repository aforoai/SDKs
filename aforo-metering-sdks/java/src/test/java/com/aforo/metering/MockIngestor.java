package com.aforo.metering;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Starts {@code mock-ingestor/bin/mock-ingestor.mjs} as a subprocess (wave 5, G312) and
 * talks to its control API. Skips the test when {@code node} is not on PATH.
 */
final class MockIngestor implements AutoCloseable {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private final Process process;
    private final HttpClient http = HttpClient.newHttpClient();
    final String url;

    private MockIngestor(Process process, String url) {
        this.process = process;
        this.url = url;
    }

    static MockIngestor start() throws Exception {
        Path script = Path.of(System.getProperty("user.dir")).resolve("../mock-ingestor/bin/mock-ingestor.mjs")
                .normalize();
        assumeTrue(Files.isRegularFile(script), "mock ingestor not found at " + script);
        assumeTrue(nodeAvailable(), "node is not on PATH");
        Process p = new ProcessBuilder("node", script.toString(), "--port", "0")
                .redirectError(ProcessBuilder.Redirect.INHERIT)
                .start();
        BufferedReader out = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
        String line = CompletableFuture.supplyAsync(() -> {
            try {
                return out.readLine();
            } catch (IOException e) {
                throw new IllegalStateException(e);
            }
        }).get(20, TimeUnit.SECONDS);
        if (line == null) {
            p.destroyForcibly();
            throw new IllegalStateException("mock ingestor exited before listening");
        }
        JsonNode ready = MAPPER.readTree(line);
        return new MockIngestor(p, ready.get("url").asText());
    }

    private static boolean nodeAvailable() {
        try {
            Process p = new ProcessBuilder("node", "--version").redirectErrorStream(true).start();
            p.getInputStream().readAllBytes();
            return p.waitFor(10, TimeUnit.SECONDS) && p.exitValue() == 0;
        } catch (IOException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    void faults(String faultsJson) throws Exception {
        send("POST", "/__control/faults", "{\"faults\":" + faultsJson + "}");
    }

    void clearFaults() throws Exception {
        send("DELETE", "/__control/faults", null);
    }

    void reset() throws Exception {
        send("POST", "/__control/reset", null);
    }

    JsonNode state() throws Exception {
        return MAPPER.readTree(send("GET", "/__control/state", null));
    }

    private String send(String method, String path, String body) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url + path)).timeout(Duration.ofSeconds(10));
        if (body != null) {
            b.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(body));
        } else {
            b.method(method, HttpRequest.BodyPublishers.noBody());
        }
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString()).body();
    }

    /** Polls {@code condition} until it holds or {@code timeoutMs} passes. */
    static void await(String what, long timeoutMs, BooleanSupplier condition) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        while (!condition.getAsBoolean()) {
            if (System.nanoTime() > deadline) throw new AssertionError("timed out waiting for " + what);
            Thread.sleep(20);
        }
    }

    /** {@code state()} for use inside a condition. */
    JsonNode stateQuietly() {
        try {
            return state();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public void close() throws Exception {
        try {
            process.getOutputStream().close(); // the mock exits when stdin closes
        } catch (IOException alreadyExited) {
            System.err.println("mock ingestor stdin already closed: " + alreadyExited.getMessage());
        }
        process.destroy();
        if (!process.waitFor(5, TimeUnit.SECONDS)) process.destroyForcibly();
    }
}
