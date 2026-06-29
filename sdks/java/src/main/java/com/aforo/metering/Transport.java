package com.aforo.metering;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * HTTP transport that sends batched usage events to the Aforo ingestor.
 *
 * <ul>
 *   <li>POST /v1/ingest/batch with Authorization header</li>
 *   <li>Retry on 5xx, 408, 429 with exponential backoff</li>
 *   <li>No retry on other 4xx</li>
 * </ul>
 */
class Transport {

    private static final Logger LOG = Logger.getLogger(Transport.class.getName());

    private final String url;
    private final String apiKey;
    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;
    private final int maxRetries;
    private final long retryBaseMs;

    Transport(String baseUrl, String apiKey, long timeoutMs, int maxRetries, long retryBaseMs) {
        this(baseUrl, apiKey, timeoutMs, maxRetries, retryBaseMs, new ObjectMapper());
    }

    Transport(String baseUrl, String apiKey, long timeoutMs, int maxRetries, long retryBaseMs,
              ObjectMapper objectMapper) {
        this.url = baseUrl.replaceAll("/+$", "") + "/v1/ingest/batch";
        this.apiKey = apiKey;
        this.maxRetries = maxRetries;
        this.retryBaseMs = retryBaseMs;
        this.objectMapper = objectMapper;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofMillis(timeoutMs))
                .build();
    }

    FlushResult send(List<ResolvedEvent> events) {
        if (events.isEmpty()) return FlushResult.empty();

        try {
            List<Map<String, Object>> eventMaps = events.stream()
                    .map(ResolvedEvent::toMap)
                    .toList();
            String body = objectMapper.writeValueAsString(Map.of("events", eventMaps));

            for (int attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    HttpRequest request = HttpRequest.newBuilder()
                            .uri(URI.create(url))
                            .header("Content-Type", "application/json")
                            .header("Authorization", "Bearer " + apiKey)
                            .POST(HttpRequest.BodyPublishers.ofString(body))
                            .timeout(Duration.ofSeconds(10))
                            .build();

                    HttpResponse<String> response = httpClient.send(request,
                            HttpResponse.BodyHandlers.ofString());

                    int status = response.statusCode();

                    if (status >= 200 && status < 300) {
                        return FlushResult.success(events.size());
                    }

                    // 4xx except 408/429 — don't retry
                    if (status >= 400 && status < 500 && status != 408 && status != 429) {
                        LOG.warning("Ingestor returned " + status + " — not retrying");
                        return FlushResult.failure(events.size());
                    }

                    // Retryable — backoff
                    if (attempt < maxRetries) {
                        long delay = retryBaseMs * (long) Math.pow(2, attempt);
                        if (status == 429) {
                            String retryAfter = response.headers()
                                    .firstValue("Retry-After").orElse(null);
                            if (retryAfter != null) {
                                try { delay = Long.parseLong(retryAfter) * 1000; }
                                catch (NumberFormatException e) {
                                    LOG.fine("Invalid Retry-After header: " + retryAfter);
                                }
                            }
                        }
                        Thread.sleep(delay);
                    }

                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return FlushResult.failure(events.size());
                } catch (Exception e) {
                    LOG.log(Level.FINE, "Request failed (attempt " + (attempt + 1) + ")", e);
                    if (attempt < maxRetries) {
                        try { Thread.sleep(retryBaseMs * (long) Math.pow(2, attempt)); }
                        catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            return FlushResult.failure(events.size());
                        }
                    }
                }
            }

            return FlushResult.failure(events.size());

        } catch (Exception e) {
            LOG.log(Level.WARNING, "Failed to serialize events", e);
            return FlushResult.failure(events.size());
        }
    }
}
