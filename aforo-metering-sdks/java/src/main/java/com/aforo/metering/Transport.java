package com.aforo.metering;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * HTTP transport that sends batched usage events to the Aforo ingestor.
 *
 * <ul>
 *   <li>POST /v1/ingest/batch with the tenant key in X-API-Key. Never Authorization: Bearer: the ingestor parses a Bearer value as a JWT and rejects the request 401, even when X-API-Key is also present</li>
 *   <li>Retry on 5xx, 408, 429 with exponential backoff; a delta-seconds Retry-After on 429 is honoured</li>
 *   <li>No retry on other 4xx — the batch is reported as {@link DropReason#REJECTED}</li>
 *   <li>A 2xx whose body reports per-event failures ({@code failed} / {@code errors[]}) is a
 *       partial result: those events are reported as rejected, the rest as sent</li>
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

    /**
     * Outcome of one batch POST.
     *
     * @param sent            events the ingestor accepted (or deduplicated)
     * @param failed          events permanently lost
     * @param reason          why, when {@code failed > 0}
     * @param rejectedIndexes for a partial result: batch indexes the ingestor named in
     *                        {@code errors[]}; {@code null} when the whole batch shares one outcome
     */
    record Outcome(int sent, int failed, DropReason reason, List<Integer> rejectedIndexes) {
        boolean partial() { return rejectedIndexes != null; }
        FlushResult toFlushResult() { return new FlushResult(sent, failed, reason); }
        static Outcome of(FlushResult r) { return new Outcome(r.sent(), r.failed(), r.reason(), null); }
    }

    FlushResult send(List<ResolvedEvent> events) {
        return sendDetailed(events).toFlushResult();
    }

    Outcome sendDetailed(List<ResolvedEvent> events) {
        if (events.isEmpty()) return Outcome.of(FlushResult.empty());

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
                            .header("X-API-Key", apiKey)
                            .POST(HttpRequest.BodyPublishers.ofString(body))
                            .timeout(Duration.ofSeconds(10))
                            .build();

                    HttpResponse<String> response = httpClient.send(request,
                            HttpResponse.BodyHandlers.ofString());

                    int status = response.statusCode();

                    if (status >= 200 && status < 300) {
                        return acceptedOutcome(events.size(), response.body());
                    }

                    // 4xx except 408/429 — don't retry
                    if (status >= 400 && status < 500 && status != 408 && status != 429) {
                        LOG.warning("Ingestor returned " + status + " — not retrying"
                                + errorMessages(response.body()));
                        return Outcome.of(FlushResult.failure(events.size(), DropReason.REJECTED));
                    }

                    // Retryable — backoff
                    if (attempt < maxRetries) {
                        long delay = retryBaseMs * (long) Math.pow(2, attempt);
                        if (status == 429) {
                            String retryAfter = response.headers()
                                    .firstValue("Retry-After").orElse(null);
                            if (retryAfter != null) {
                                try { delay = Math.max(0, Long.parseLong(retryAfter.trim())) * 1000; }
                                catch (NumberFormatException e) {
                                    LOG.fine("Invalid Retry-After header: " + retryAfter);
                                }
                            }
                        }
                        Thread.sleep(delay);
                    }

                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return Outcome.of(FlushResult.failure(events.size()));
                } catch (Exception e) {
                    LOG.log(Level.FINE, "Request failed (attempt " + (attempt + 1) + ")", e);
                    if (attempt < maxRetries) {
                        try { Thread.sleep(retryBaseMs * (long) Math.pow(2, attempt)); }
                        catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            return Outcome.of(FlushResult.failure(events.size()));
                        }
                    }
                }
            }

            return Outcome.of(FlushResult.failure(events.size()));

        } catch (Exception e) {
            LOG.log(Level.WARNING, "Failed to serialize events", e);
            return Outcome.of(FlushResult.failure(events.size(), DropReason.REJECTED));
        }
    }

    /**
     * A 2xx batch response may still report events the ingestor refused
     * ({@code {"accepted":..,"duplicates":..,"failed":N,"errors":[{"index":i,"message":".."}]}}).
     * An empty or non-JSON body means everything was accepted.
     */
    private Outcome acceptedOutcome(int batchSize, String body) {
        if (body == null || body.isBlank()) return Outcome.of(FlushResult.success(batchSize));
        try {
            JsonNode root = unwrapEnvelope(objectMapper.readTree(body));
            JsonNode errors = root.path("errors");
            List<Integer> indexes = new ArrayList<>();
            if (errors.isArray()) {
                for (JsonNode err : errors) {
                    JsonNode idx = err.get("index");
                    if (idx != null && idx.isInt() && idx.asInt() >= 0 && idx.asInt() < batchSize
                            && !indexes.contains(idx.asInt())) {
                        indexes.add(idx.asInt());
                    }
                }
            }
            int failed = Math.min(batchSize, Math.max(root.path("failed").asInt(0), indexes.size()));
            if (failed == 0) return Outcome.of(FlushResult.success(batchSize));
            LOG.warning("Ingestor rejected " + failed + " of " + batchSize + " event(s)" + errorMessages(body));
            return new Outcome(batchSize - failed, failed, DropReason.REJECTED, indexes);
        } catch (Exception e) {
            return Outcome.of(FlushResult.success(batchSize));
        }
    }

    /** {@code errors[].message} from an ingestor response, formatted for a log line; "" if none. */
    private String errorMessages(String body) {
        if (body == null || body.isBlank()) return "";
        try {
            JsonNode errors = unwrapEnvelope(objectMapper.readTree(body)).path("errors");
            if (!errors.isArray() || errors.isEmpty()) return "";
            StringBuilder sb = new StringBuilder(":");
            int shown = 0;
            for (JsonNode err : errors) {
                if (shown++ == 10) { sb.append(" ..."); break; }
                sb.append(" [");
                if (err.has("index")) sb.append(err.get("index").asText()).append(": ");
                sb.append(err.path("message").asText("")).append(']');
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * The ingestor wraps every 2xx JSON body in {@code {success, data, meta}}.
     * Returns the inner {@code data} object when present, else the node itself
     * (bare shape).
     */
    static com.fasterxml.jackson.databind.JsonNode unwrapEnvelope(com.fasterxml.jackson.databind.JsonNode root) {
        if (root != null && root.isObject() && root.path("data").isObject()) {
            return root.get("data");
        }
        return root;
    }
}
