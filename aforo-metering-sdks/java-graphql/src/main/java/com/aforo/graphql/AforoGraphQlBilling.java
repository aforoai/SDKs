package com.aforo.graphql;

import com.fasterxml.jackson.databind.ObjectMapper;
import graphql.ExecutionResult;
import graphql.execution.instrumentation.Instrumentation;
import graphql.execution.instrumentation.InstrumentationContext;
import graphql.execution.instrumentation.InstrumentationState;
import graphql.execution.instrumentation.SimpleInstrumentationContext;
import graphql.execution.instrumentation.parameters.InstrumentationCreateStateParameters;
import graphql.execution.instrumentation.parameters.InstrumentationExecutionParameters;
import graphql.language.Document;
import graphql.language.Field;
import graphql.language.NodeTraverser;
import graphql.language.OperationDefinition;
import graphql.parser.Parser;
import graphql.util.TraversalControl;
import graphql.util.TraverserContext;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BiConsumer;
import java.util.function.Function;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Aforo GraphQL Metering SDK for Java.
 *
 * <p>Install as a graphql-java {@code Instrumentation} on your schema. Every
 * GraphQL operation (query, mutation, subscription) emits one billing event
 * with AST-accurate complexity scoring (field_count + 5 × max_depth).</p>
 *
 * <p>Usage:</p>
 * <pre>
 *   AforoGraphQlBilling billing = AforoGraphQlBilling.newBuilder()
 *       .tenantId("tenant_acme")
 *       .productId("prod_graphql_unified_gateway")
 *       .apiKey(System.getenv("AFORO_API_KEY"))
 *       .ingestorUrl("https://api.aforo.ai")
 *       .schemaVersion("v2.1")
 *       .build();
 *
 *   GraphQL gql = GraphQL.newGraphQL(schema)
 *       .instrumentation(billing.instrumentation())
 *       .build();
 * </pre>
 */
public final class AforoGraphQlBilling implements AutoCloseable {

    private static final Logger LOG = Logger.getLogger(AforoGraphQlBilling.class.getName());
    private static final String SDK_VERSION = "1.2.2";
    /** The ingestor rejects {@code /v1/ingest/batch} requests with more than 1000 events. */
    static final int MAX_EVENTS_PER_REQUEST = 1000;
    private static final int MAX_IDEMPOTENCY_KEY = 255;
    /** Ingestor limit on {@code gqlOperationName}. */
    static final int MAX_GQL_OPERATION_NAME = 255;
    /** Default top-level {@code productType}; override with {@link Builder#productType(String)}. */
    public static final String DEFAULT_PRODUCT_TYPE = "GRAPHQL_API";

    private final String tenantId, productId, apiKey, schemaVersion;
    private final URI ingestorUri;
    private final String productType;
    private final int flushCount;
    private final long flushIntervalMs;
    private final Function<InstrumentationExecutionParameters, String> customerIdExtractor;

    private final ConcurrentLinkedQueue<Map<String, Object>> buffer = new ConcurrentLinkedQueue<>();
    private final AtomicInteger bufferSize = new AtomicInteger();
    private final AtomicLong dropped = new AtomicLong();
    private final BiConsumer<java.util.List<Map<String, Object>>, DropReason> onDrop;
    /** Retry backoff base in ms — package-private so tests can skip real sleeps. */
    long retryBackoffBaseMs = 1000L;
    private final ObjectMapper mapper = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "aforo-graphql-flush");
        t.setDaemon(true);
        return t;
    });

    private AforoGraphQlBilling(Builder b) {
        this.tenantId = require(b.tenantId, "tenantId");
        this.productId = require(b.productId, "productId");
        this.apiKey = require(b.apiKey, "apiKey");
        this.schemaVersion = b.schemaVersion;
        this.ingestorUri = URI.create(stripTrailingSlash(require(b.ingestorUrl, "ingestorUrl")) + "/v1/ingest/batch");
        this.productType = normalizeProductType(b.productType, DEFAULT_PRODUCT_TYPE);
        this.flushCount = b.flushCount;
        this.flushIntervalMs = b.flushIntervalMs;
        this.onDrop = b.onDrop;
        this.customerIdExtractor = b.customerIdExtractor != null ? b.customerIdExtractor : DEFAULT_CUSTOMER_EXTRACTOR;
        scheduler.scheduleAtFixedRate(this::flushQuietly, flushIntervalMs, flushIntervalMs, TimeUnit.MILLISECONDS);
    }

    /** Returns a graphql-java {@link Instrumentation} that meters every operation. */
    public Instrumentation instrumentation() {
        return new Instrumentation() {
            @Override
            public InstrumentationState createState(InstrumentationCreateStateParameters parameters) {
                return new TimingState();
            }

            @Override
            public InstrumentationContext<ExecutionResult> beginExecution(InstrumentationExecutionParameters parameters,
                                                                          InstrumentationState state) {
                ((TimingState) state).startMs = System.currentTimeMillis();
                return SimpleInstrumentationContext.whenCompleted((result, throwable) -> {
                    try {
                        if (result == null) return;
                        String customerId = customerIdExtractor.apply(parameters);
                        if (customerId == null || customerId.isBlank()) return;

                        long durationMs = System.currentTimeMillis() - ((TimingState) state).startMs;
                        boolean hasErrors = throwable != null
                                || (result.getErrors() != null && !result.getErrors().isEmpty());
                        String outcome = throwable != null ? "ERROR" : outcomeFromGraphQlResult(result);
                        record(customerId, parameters.getQuery(), parameters.getOperation(), durationMs, hasErrors,
                                outcome);
                    } catch (Exception e) {
                        LOG.log(Level.FINE, "[aforo-graphql] instrumentation error", e);
                    }
                });
            }
        };
    }

    /**
     * Record one operation manually. Public for non-graphql-java integrations.
     * Sends no {@code executionStatus} — a boolean {@code hasErrors} can't tell a
     * partial result from a failed one. Use the overload below to set one.
     */
    public void record(String customerId, String query, String operationName, long durationMs, boolean hasErrors) {
        record(customerId, query, operationName, durationMs, hasErrors, null);
    }

    /**
     * Record one operation manually with an outcome status for OUTCOME_BASED
     * pricing (each event bills at the weight set for its status; events
     * without one bill at full price). Trimmed and upper-cased; {@code null} or
     * blank leaves it off the event. Derive it with
     * {@link #outcomeFromGraphQlResult(ExecutionResult)} or
     * {@link #outcomeFromHttpStatus(int)}. Accepted values: SUCCESS, PARTIAL,
     * TIMEOUT, ERROR, VALIDATION_FAILED, FAILED, FAILURE, CANCELLED, PENDING,
     * BLOCKED, HITL_REQUIRED. Any other value is logged and left off the event.
     */
    public void record(String customerId, String query, String operationName, long durationMs, boolean hasErrors,
                       String executionStatus) {
        record(customerId, query, operationName, durationMs, hasErrors, executionStatus, null);
    }

    /**
     * Record one operation with an outcome status (see the overload above) and a
     * per-call {@code productType} override ({@code null}/blank → the client-level
     * {@link Builder#productType(String)}).
     *
     * <p>A blank {@code customerId} or {@code query} is not metered. An event that
     * breaks an ingestor field limit on a caller-set field (customerId over 64
     * characters, productType over 20) is dropped with {@link DropReason#INVALID};
     * this method never throws.</p>
     *
     * <p>The operation name is read from the query document, i.e. from the request,
     * whether this is called by {@link #instrumentation()} or by your own code.
     * One over 255 characters is truncated to 255 on {@code gqlOperationName} and the
     * event is still sent (one warning per instance). The idempotency key is built
     * from the full name.</p>
     */
    public void record(String customerId, String query, String operationName, long durationMs, boolean hasErrors,
                       String executionStatus, String productTypeOverride) {
        if (customerId == null || customerId.isBlank() || query == null || query.isBlank()) return;
        String outcome = canonicalExecutionStatus(executionStatus);
        try {
            Document doc = Parser.parse(query);
            OperationDefinition op = findOperation(doc, operationName);
            if (op == null) return;

            int[] fc = {0};
            int[] maxDepth = {0};
            int[] depth = {0};
            // doc.accept() by itself only fires on the Document node (not its children).
            // Use NodeTraverser to recursively walk into Field nodes; enter/leave track depth.
            new NodeTraverser().depthFirst(new graphql.language.NodeVisitorStub() {
                @Override
                public TraversalControl visitField(Field node, TraverserContext<graphql.language.Node> context) {
                    if (context.getPhase() == TraverserContext.Phase.ENTER) {
                        fc[0]++;
                        depth[0]++;
                        if (depth[0] > maxDepth[0]) maxDepth[0] = depth[0];
                    } else if (context.getPhase() == TraverserContext.Phase.LEAVE) {
                        depth[0]--;
                    }
                    return TraversalControl.CONTINUE;
                }
            }, doc);

            int complexity = fc[0] + 5 * maxDepth[0];
            String opType = op.getOperation().name(); // QUERY, MUTATION, SUBSCRIPTION
            String opName = op.getName() != null ? op.getName() : "anonymous";

            Instant now = Instant.now();
            Map<String, Object> event = new HashMap<>();
            event.put("customerId", customerId);
            event.put("metricName", "graphql_api.operations");
            event.put("quantity", 1);
            event.put("occurredAt", now.toString());
            event.put("idempotencyKey", idempotencyKey("gql:" + tenantId + ":" + productId + ":" + opName, now));
            event.put("productType", normalizeProductType(productTypeOverride, productType));
            event.put("gqlOperationType", opType);
            event.put("gqlOperationName", boundedLabel("gqlOperationName", opName, MAX_GQL_OPERATION_NAME));
            event.put("gqlComplexity", complexity);
            event.put("gqlFieldCount", fc[0]);
            event.put("gqlHasErrors", hasErrors);
            event.put("executionDurationMs", (int) Math.max(0, Math.min(durationMs, Integer.MAX_VALUE)));
            if (outcome != null) event.put("executionStatus", outcome);

            Map<String, Object> meta = new HashMap<>();
            meta.put("sdkVersion", SDK_VERSION);
            meta.put("productId", productId);
            if (schemaVersion != null) meta.put("schemaVersion", schemaVersion);
            event.put("metadata", meta);

            enqueue(event);
        } catch (Exception ignored) {
            // Never fail the response due to metering
        }
    }

    /**
     * Execution status from a GraphQL result, per the GraphQL spec's use of the
     * {@code data} key:
     * <ul>
     *   <li>no errors → SUCCESS</li>
     *   <li>errors + non-null data → PARTIAL</li>
     *   <li>errors + data present but null (failed during execution) → ERROR</li>
     *   <li>errors + data absent (failed before execution: parse/validation) → VALIDATION_FAILED</li>
     * </ul>
     * {@code null} result → {@code null}.
     */
    public static String outcomeFromGraphQlResult(ExecutionResult result) {
        if (result == null) return null;
        if (result.getErrors() == null || result.getErrors().isEmpty()) return "SUCCESS";
        if (!result.isDataPresent()) return "VALIDATION_FAILED";
        return result.getData() != null ? "PARTIAL" : "ERROR";
    }

    /**
     * Execution status from an HTTP status, for integrations that only see the
     * response code: 2xx/3xx → SUCCESS; 408/504 → TIMEOUT; 499 → CANCELLED;
     * 400/422 → VALIDATION_FAILED; 401/403/429 → BLOCKED; other 4xx/5xx →
     * ERROR; anything else → {@code null} (not sent).
     */
    public static String outcomeFromHttpStatus(int status) {
        if (status >= 200 && status < 400) return "SUCCESS";
        switch (status) {
            case 408: case 504: return "TIMEOUT";
            case 499: return "CANCELLED";
            case 400: case 422: return "VALIDATION_FAILED";
            case 401: case 403: case 429: return "BLOCKED";
            default: return status >= 400 && status < 600 ? "ERROR" : null;
        }
    }

    /**
     * Canonical outcome statuses the ingestor accepts (contract/ingest-contract.json,
     * max 20 chars). Anything else would make it reject the event.
     */
    static final java.util.Set<String> ALLOWED_EXECUTION_STATUSES = java.util.Set.of(
            "SUCCESS", "PARTIAL", "TIMEOUT", "ERROR", "VALIDATION_FAILED", "FAILED",
            "FAILURE", "CANCELLED", "PENDING", "BLOCKED", "HITL_REQUIRED");

    /** Trim + upper-case; blank or {@code null} becomes {@code null} (omitted from the wire body). */
    static String normalizeExecutionStatus(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed.toUpperCase(java.util.Locale.ROOT);
    }

    /**
     * {@link #normalizeExecutionStatus} plus an allowlist check. An unknown value is
     * logged and returned as {@code null} so the field is left off the event — sending
     * it would make the ingestor reject the event, losing its usage.
     */
    static String canonicalExecutionStatus(String value) {
        String normalized = normalizeExecutionStatus(value);
        if (normalized == null || ALLOWED_EXECUTION_STATUSES.contains(normalized)) return normalized;
        LOG.warning("[aforo-graphql] Ignoring unknown executionStatus \"" + normalized + "\" — expected one of "
                + new java.util.TreeSet<>(ALLOWED_EXECUTION_STATUSES) + "; the event is sent without it.");
        return null;
    }

    private OperationDefinition findOperation(Document doc, String operationName) {
        OperationDefinition first = null;
        for (graphql.language.Definition<?> d : doc.getDefinitions()) {
            if (d instanceof OperationDefinition op) {
                if (first == null) first = op;
                if (operationName != null && operationName.equals(op.getName())) return op;
            }
        }
        return first;
    }

    /**
     * Why an event was permanently dropped. The buffer is unbounded (drained
     * at flush start), so unlike the core SDK there is no OVERFLOW reason.
     * <ul>
     *   <li>{@code RETRY_EXHAUSTED} — the batch failed after all transport attempts</li>
     *   <li>{@code REJECTED} — the ingestor refused the batch (non-retryable 4xx) or
     *       refused this event individually in a partial response</li>
     *   <li>{@code INVALID} — the event breaks an ingestor field limit; it was never
     *       buffered or sent</li>
     * </ul>
     */
    public enum DropReason { RETRY_EXHAUSTED, REJECTED, INVALID }

    /** Number of events permanently dropped since this instance was created. */
    public long droppedCount() { return dropped.get(); }

    /**
     * Account for a permanently lost batch: bump the counter, WARN-log, and
     * invoke the opt-in onDrop hook. The buffer is drained at flush start, so
     * drops here are bounded by flush cadence — no log throttle needed.
     */
    private void recordDrop(java.util.List<Map<String, Object>> events, DropReason reason) {
        long total = dropped.addAndGet(events.size());
        LOG.warning("[aforo-graphql] Dropped " + events.size() + " event(s) — " + reason + " (" + total + " total dropped).");
        if (onDrop != null) {
            try {
                onDrop.accept(events, reason);
            } catch (Exception e) {
                // A hook bug must never break flushing.
                LOG.log(Level.FINE, "onDrop hook threw", e);
            }
        }
    }

    private final AtomicLong invalidDrops = new AtomicLong();

    /**
     * Ingestor field limits ({@code IngestUsageEventRequest} {@code @Size} constraints).
     * An event over one of these would be rejected server-side, so it is dropped
     * here instead. Caller-set fields are never truncated, because a truncated id
     * bills the wrong thing; the request-derived operation name is bounded before
     * it gets here (see {@code boundedLabel}).
     */
    private static final Map<String, Integer> FIELD_LIMITS = Map.ofEntries(
            Map.entry("customerId", 64), Map.entry("metricName", 255),
            Map.entry("idempotencyKey", 255), Map.entry("productType", 20),
            Map.entry("grpcService", 255), Map.entry("grpcMethod", 128),
            Map.entry("gqlOperationName", 255), Map.entry("wsConnectionId", 64),
            Map.entry("mqttTopic", 500), Map.entry("mqttClientId", 128));

    /** The first field limit this event breaks, or {@code null} when it is within every limit. */
    static String limitViolation(Map<String, Object> event) {
        for (String field : new java.util.TreeSet<>(FIELD_LIMITS.keySet())) {
            Object v = event.get(field);
            int max = FIELD_LIMITS.get(field);
            if (v instanceof String s && s.length() > max) {
                return field + " is " + s.length() + " characters, exceeding the ingestor's " + max
                        + "-character limit (value: \"" + (s.length() <= 80 ? s : s.substring(0, 80) + "...") + "\")";
            }
        }
        return null;
    }

    /**
     * An event the ingestor would refuse: not buffered, not sent, counted in
     * {@link #droppedCount()}, logged (first, then every 1000th, so a tight loop
     * can't storm the log) and handed to the onDrop hook with {@link DropReason#INVALID}.
     */
    private void recordInvalid(Map<String, Object> event, String violation) {
        long total = dropped.incrementAndGet();
        long invalids = invalidDrops.incrementAndGet();
        if (invalids == 1 || invalids % 1000 == 0) {
            LOG.warning("[aforo-graphql] Dropping invalid event: " + violation + " (" + invalids
                    + " invalid, " + total + " total dropped).");
        }
        if (onDrop != null) {
            try {
                onDrop.accept(java.util.List.of(event), DropReason.INVALID);
            } catch (Exception e) {
                LOG.log(Level.FINE, "onDrop hook threw", e);
            }
        }
    }

    /** Buffers an event, or drops it as {@link DropReason#INVALID} when it breaks a field limit. */
    private void enqueue(Map<String, Object> event) {
        String violation = limitViolation(event);
        if (violation != null) {
            recordInvalid(event, violation);
            return;
        }
        buffer.offer(event);
        if (bufferSize.incrementAndGet() >= flushCount) {
            scheduler.execute(this::flushQuietly);
        }
    }

    private final Object drainLock = new Object();

    private void flushQuietly() {
        try { flush(); } catch (Exception e) { LOG.log(Level.WARNING, "[aforo-graphql] flush failed", e); }
    }

    private void flush() throws Exception {
        if (bufferSize.get() == 0) return;
        java.util.List<Map<String, Object>> batch = new java.util.ArrayList<>();
        Map<String, Object> ev;
        // One drain at a time: a size-triggered flush on the scheduler thread and
        // close()'s flush on the caller thread would otherwise split one batch into
        // two interleaved requests.
        synchronized (drainLock) {
            while ((ev = buffer.poll()) != null) { batch.add(ev); bufferSize.decrementAndGet(); }
        }
        if (batch.isEmpty()) return;

        // Slice into requests of at most MAX_EVENTS_PER_REQUEST; a failed slice does
        // not stop the remaining slices from being delivered.
        Exception failure = null;
        for (int from = 0; from < batch.size(); from += MAX_EVENTS_PER_REQUEST) {
            try {
                send(java.util.List.copyOf(batch.subList(from, Math.min(batch.size(), from + MAX_EVENTS_PER_REQUEST))));
            } catch (Exception e) {
                failure = e;
            }
        }
        if (failure != null) throw failure;
    }

    /**
     * POSTs one slice. The body is serialized once, so every retry resends the same
     * idempotency keys. Every way the slice can be lost goes through recordDrop.
     */
    private void send(java.util.List<Map<String, Object>> events) throws Exception {
        String body = mapper.writeValueAsString(Map.of("events", events));
        HttpRequest req = HttpRequest.newBuilder(ingestorUri)
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .header("X-API-Key", apiKey)
                .header("X-Tenant-Id", tenantId)
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        for (int attempt = 1; attempt <= 3; attempt++) {
            long delayMs = (long) Math.pow(2, attempt - 1) * retryBackoffBaseMs;
            try {
                HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
                int status = resp.statusCode();
                if (status >= 200 && status < 300) {
                    recordPartialRejections(events, resp.body());
                    return;
                }
                // 4xx other than 408/429 (bad key, invalid event, unknown metric) cannot succeed on retry.
                if (status >= 400 && status < 500 && status != 408 && status != 429) {
                    LOG.warning("[aforo-graphql] ingestor returned " + status + " — not retrying"
                            + errorMessages(resp.body()));
                    recordDrop(events, DropReason.REJECTED);
                    return;
                }
                if (status == 429) delayMs = retryAfterMs(resp, delayMs);
            } catch (Exception e) {
                if (attempt == 3) {
                    recordDrop(events, DropReason.RETRY_EXHAUSTED);
                    throw e;
                }
            }
            if (attempt == 3) break;
            try {
                Thread.sleep(delayMs);
            } catch (InterruptedException ie) {
                // Interrupted mid-backoff (e.g. close() racing shutdownNow) — the
                // batch is already drained and will never be retried; account for
                // it before propagating, and restore the interrupt flag for the
                // caller's subsequent blocking calls.
                recordDrop(events, DropReason.RETRY_EXHAUSTED);
                Thread.currentThread().interrupt();
                throw ie;
            }
        }
        recordDrop(events, DropReason.RETRY_EXHAUSTED);
        LOG.warning("[aforo-graphql] flush exhausted retries — dropped " + events.size() + " events");
    }

    /**
     * A 2xx batch response can still report events the ingestor refused individually
     * ({@code failed} / {@code errors[{index,message}]}). Those events are dropped with
     * {@link DropReason#REJECTED}; only events the response identifies by index are
     * handed to the hook — any others are counted but not guessed at.
     */
    private void recordPartialRejections(java.util.List<Map<String, Object>> events, String body) {
        if (body == null || body.isBlank()) return;
        java.util.List<Map<String, Object>> rejected = new java.util.ArrayList<>();
        int failed;
        try {
            com.fasterxml.jackson.databind.JsonNode root = unwrapEnvelope(mapper.readTree(body));
            com.fasterxml.jackson.databind.JsonNode errors = root.path("errors");
            java.util.Set<Integer> seen = new java.util.HashSet<>();
            if (errors.isArray()) {
                for (com.fasterxml.jackson.databind.JsonNode err : errors) {
                    com.fasterxml.jackson.databind.JsonNode idx = err.get("index");
                    if (idx != null && idx.isInt() && idx.asInt() >= 0 && idx.asInt() < events.size()
                            && seen.add(idx.asInt())) {
                        rejected.add(events.get(idx.asInt()));
                    }
                }
            }
            failed = Math.min(events.size(), Math.max(root.path("failed").asInt(0), rejected.size()));
        } catch (Exception e) {
            return; // not a batch-response body — treat as accepted
        }
        if (failed == 0) return;
        LOG.warning("[aforo-graphql] ingestor rejected " + failed + " of " + events.size() + " event(s)"
                + errorMessages(body));
        if (!rejected.isEmpty()) recordDrop(rejected, DropReason.REJECTED);
        int unidentified = failed - rejected.size();
        if (unidentified > 0) dropped.addAndGet(unidentified);
    }

    /** {@code errors[].message} from an ingestor batch response, formatted for a log line; "" if none. */
    private String errorMessages(String body) {
        if (body == null || body.isBlank()) return "";
        try {
            com.fasterxml.jackson.databind.JsonNode errors = unwrapEnvelope(mapper.readTree(body)).path("errors");
            if (!errors.isArray() || errors.isEmpty()) return "";
            StringBuilder sb = new StringBuilder(":");
            int shown = 0;
            for (com.fasterxml.jackson.databind.JsonNode err : errors) {
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

    /** Honours a delta-seconds {@code Retry-After} header on 429; otherwise keeps {@code fallbackMs}. */
    private static long retryAfterMs(HttpResponse<String> resp, long fallbackMs) {
        String retryAfter = resp.headers().firstValue("Retry-After").orElse(null);
        if (retryAfter == null) return fallbackMs;
        try {
            return Math.max(0, Long.parseLong(retryAfter.trim())) * 1000;
        } catch (NumberFormatException e) {
            return fallbackMs;
        }
    }

    @Override
    public void close() {
        scheduler.shutdown();
        try {
            flushQuietly();
            if (!scheduler.awaitTermination(5, TimeUnit.SECONDS)) scheduler.shutdownNow();
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    private static class TimingState implements InstrumentationState {
        long startMs;
    }

    @SuppressWarnings("unchecked")
    private static final Function<InstrumentationExecutionParameters, String> DEFAULT_CUSTOMER_EXTRACTOR = params -> {
        Object ctx = params.getContext();
        if (ctx instanceof Map<?, ?> map) {
            Object v = ((Map<String, Object>) map).get("x-customer-id");
            if (v == null) v = ((Map<String, Object>) map).get("customerId");
            if (v instanceof String s) return s;
        }
        return null;
    };

    /**
     * Joins {@code natural:suffix}. The key is minted once per event, here, from the
     * untruncated inputs; a retry resends the serialized event and so the same key.
     */
    private static String idempotencyKey(String natural, Instant now) {
        String suffix = now.toEpochMilli() + ":" + UUID.randomUUID().toString().substring(0, 8);
        return fitKeyPart(natural, MAX_IDEMPOTENCY_KEY - suffix.length() - 1) + ":" + suffix;
    }

    /**
     * {@code natural} unchanged when it fits in {@code room} characters. Otherwise its
     * head followed by {@code ":"} and the SHA-256 hex digest of the whole value, exactly
     * {@code room} characters or one fewer: the same input always gives the same result,
     * and two inputs that share a long prefix give different ones. Nothing is cut off
     * without being covered by the digest.
     */
    static String fitKeyPart(String natural, int room) {
        if (natural.length() <= room) return natural;
        String digest = sha256Hex(natural);
        return truncateLabel(natural, Math.max(room - digest.length() - 1, 0)) + ":" + digest;
    }

    static String sha256Hex(String value) {
        try {
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required by every Java runtime", e);
        }
    }

    /**
     * {@code value} cut to at most {@code max} UTF-16 code units — the unit the
     * ingestor's {@code @Size} counts. A surrogate pair is never split: when the cut
     * would land inside one, the result is one unit shorter.
     */
    static String truncateLabel(String value, int max) {
        if (value == null || value.length() <= max) return value;
        int end = Math.max(max, 0);
        if (end > 0 && Character.isHighSurrogate(value.charAt(end - 1))
                && Character.isLowSurrogate(value.charAt(end))) {
            end--;
        }
        return value.substring(0, end);
    }

    /** Request-derived labels already reported as truncated — one warning per label per instance. */
    private final java.util.Set<String> truncationWarned = java.util.concurrent.ConcurrentHashMap.newKeySet();

    /**
     * A label taken from the incoming request, cut to the ingestor's limit so the
     * event is still sent. Warns once per label. Not for caller-set fields.
     */
    private String boundedLabel(String label, String value, int max) {
        if (value == null || value.length() <= max) return value;
        if (truncationWarned.add(label)) {
            LOG.warning("[aforo-graphql] " + label + " from the request was longer than " + max
                    + " characters and was truncated to " + max + "; the event is still sent."
                    + " Later truncations of " + label + " are not logged.");
        }
        return truncateLabel(value, max);
    }

    /** Trim + uppercase; {@code fallback} for null/blank. Unknown values pass through. */
    private static String normalizeProductType(String s, String fallback) {
        return s == null || s.isBlank() ? fallback : s.trim().toUpperCase(java.util.Locale.ROOT);
    }

    private static String require(String s, String name) {
        if (s == null || s.isBlank()) throw new IllegalArgumentException(name + " is required");
        return s;
    }

    private static String stripTrailingSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    /** The client-level {@code productType} stamped on events without a per-call override. */
    public String getProductType() { return productType; }

    public static Builder newBuilder() { return new Builder(); }

    public static final class Builder {
        private String productType;
        private String tenantId, productId, apiKey, ingestorUrl, schemaVersion;
        private int flushCount = 50;
        private long flushIntervalMs = 5_000L;
        private BiConsumer<java.util.List<Map<String, Object>>, DropReason> onDrop;
        private Function<InstrumentationExecutionParameters, String> customerIdExtractor;

        public Builder tenantId(String s) { this.tenantId = s; return this; }
        public Builder productId(String s) { this.productId = s; return this; }
        public Builder apiKey(String s) { this.apiKey = s; return this; }
        /**
         * Top-level {@code productType} on every event (default {@code GRAPHQL_API}).
         * Trimmed and uppercased; unknown values are passed through.
         */
        public Builder productType(String s) { this.productType = s; return this; }
        public Builder ingestorUrl(String s) { this.ingestorUrl = s; return this; }
        public Builder schemaVersion(String s) { this.schemaVersion = s; return this; }
        public Builder flushCount(int n) { this.flushCount = n; return this; }
        public Builder flushIntervalMs(long n) { this.flushIntervalMs = n; return this; }
        /**
         * Opt-in hook receiving events that were permanently dropped (retry
         * exhaustion, a terminal rejection, or an event that breaks an ingestor
         * field limit — {@code DropReason.INVALID}). Events keep their idempotency
         * keys, so persisting and re-submitting them after recovery is
         * dedup-safe. Exceptions thrown by the hook are swallowed. Default:
         * none (drops are still counted in droppedCount() and WARN-logged).
         */
        public Builder onDrop(BiConsumer<java.util.List<Map<String, Object>>, DropReason> fn) { this.onDrop = fn; return this; }
        public Builder customerIdExtractor(Function<InstrumentationExecutionParameters, String> fn) {
            this.customerIdExtractor = fn; return this;
        }
        public AforoGraphQlBilling build() { return new AforoGraphQlBilling(this); }
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
