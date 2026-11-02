package com.aforo.graphql;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.aforo.graphql.internal.transport.TransportConfig;
import com.aforo.graphql.internal.transport.TransportCore;
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

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
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
 *       // Who is calling: put the authenticated customer in the GraphQLContext yourself.
 *       .customerResolver(params -> params.getGraphQLContext().get("aforoCustomerId"))
 *       .build();
 *
 *   GraphQL gql = GraphQL.newGraphQL(schema)
 *       .instrumentation(billing.instrumentation())
 *       .build();
 * </pre>
 */
public final class AforoGraphQlBilling implements AutoCloseable {

    private static final Logger LOG = Logger.getLogger(AforoGraphQlBilling.class.getName());
    private static final String SDK_VERSION = "2.1.0";
    private static final int MAX_IDEMPOTENCY_KEY = 255;
    /** Ingestor limit on {@code gqlOperationName}. */
    static final int MAX_GQL_OPERATION_NAME = 255;
    /** Default top-level {@code productType}; override with {@link Builder#productType(String)}. */
    public static final String DEFAULT_PRODUCT_TYPE = "GRAPHQL_API";

    private final String tenantId, productId, apiKey, schemaVersion;
    private final String productType;
    private final CustomerResolver customerResolver;

    private final BiConsumer<java.util.List<Map<String, Object>>, DropReason> onDrop;
    private final java.util.function.Consumer<MeteringError> onError;
    private final BiConsumer<Map<String, Object>, java.util.List<Map<String, Object>>> onAccepted;
    private final ObjectMapper mapper = new ObjectMapper();
    private final TransportCore<Map<String, Object>> core;

    private AforoGraphQlBilling(Builder b) {
        this.tenantId = require(b.tenantId, "tenantId");
        this.productId = require(b.productId, "productId");
        this.apiKey = require(b.apiKey, "apiKey");
        this.schemaVersion = b.schemaVersion;
        this.productType = normalizeProductType(b.productType, DEFAULT_PRODUCT_TYPE);
        this.onDrop = b.onDrop;
        this.onError = b.onError;
        this.onAccepted = b.onAccepted;
        this.core = new TransportCore<>(TransportConfig.builder()
                .baseUrl(require(b.ingestorUrl, "ingestorUrl"))
                .apiKey(apiKey)
                .allowInsecureHttp(b.allowInsecureHttp)
                .compression(b.compression)
                .header("X-Tenant-Id", tenantId)
                .userAgent("aforo-java-graphql/" + SDK_VERSION)
                .flushCount(b.flushCount)
                .flushIntervalMs(b.flushIntervalMs)
                .maxQueueSize(b.maxQueueSize)
                .maxRetries(b.maxRetries)
                .retryBaseMs(b.retryBaseMs)
                .timeoutMs(b.timeoutMs)
                .shutdownTimeoutMs(b.shutdownTimeoutMs)
                .breakerInitialMs(b.breakerCooldownMs)
                .threadName("aforo-graphql-flush")
                .loggerName(AforoGraphQlBilling.class.getName())
                .logPrefix("[aforo-graphql]")
                .build(),
                mapper::writeValueAsString,
                TransportCore.Listeners.<Map<String, Object>>builder()
                        .onDrop((events, reason) -> { if (onDrop != null) onDrop.accept(events, map(reason)); })
                        .onError(onError == null ? null : e -> onError.accept(
                                new MeteringError(map(e.kind()), e.message(), e.events(), e.status())))
                        .onAccepted(onAccepted == null ? null : (body, events) -> onAccepted.accept(asMap(body), events))
                        .build());
        this.customerResolver = b.customerResolver();
    }

    /**
     * Finds the Aforo customer id for an operation from an identity you have verified,
     * typically a value your HTTP layer put in the {@link graphql.GraphQLContext} after
     * authenticating the request. Returning null/blank: the operation is not metered and
     * is counted as {@code INVALID}; the response is never affected.
     */
    @FunctionalInterface
    public interface CustomerResolver {
        String resolve(InstrumentationExecutionParameters parameters);
    }

    /** Message for a builder without a customer source. */
    static final String MISSING_CUSTOMER_SOURCE = "AforoGraphQlBilling needs to know which customer each"
            + " operation belongs to. Set customerResolver(...) to read it from your authentication (for example a"
            + " value your HTTP layer put in the GraphQLContext), or trustCustomerHeader(true) to read the"
            + " \"x-customer-id\" / \"customerId\" context entry; only do that when that entry is set from an"
            + " authenticated source, never copied from a request header the caller controls.";

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
                        String customerId = resolveCustomer(parameters);

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
     * <p>A blank {@code query} is not metered. A blank {@code customerId}, or an event that
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
        if (query == null || query.isBlank()) return;
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

            if (customerId == null || customerId.isBlank()) {
                recordInvalid(event, "customerId is required (the customer resolver found none for " + opName + ")");
                return;
            }
            enqueue(event);
        } catch (Exception e) {
            // Never fail the response due to metering.
            LOG.log(Level.FINE, "[aforo-graphql] could not meter the operation", e);
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
     * Why events were permanently dropped. An ingest outage does not drop anything: the
     * batch goes back to the queue with its idempotency keys and is resent after a
     * cooldown.
     * <ul>
     *   <li>{@code OVERFLOW} — the queue was full ({@link Builder#maxQueueSize(int)}); the oldest event was evicted</li>
     *   <li>{@code REJECTED} — the ingestor refused the batch (non-retryable 4xx) or this event in a partial response</li>
     *   <li>{@code INVALID} — the event breaks an ingestor field limit, or has no customer; it was never sent</li>
     *   <li>{@code SHUTDOWN} — still queued when {@link #close()} reached its shutdown deadline</li>
     *   <li>{@code CLOSED} — recorded after {@link #close()}</li>
     *   <li>{@code RETRY_EXHAUSTED} — kept for compatibility; only reported when a requeue is impossible</li>
     * </ul>
     */
    public enum DropReason { RETRY_EXHAUSTED, REJECTED, INVALID, OVERFLOW, SHUTDOWN, CLOSED }

    /** What a {@link MeteringError} is about. Branch on this, never on the message. */
    public enum ErrorKind {
        /** Ingestor unreachable, 408/429/5xx or a redirect after every retry; the events stay queued and are resent. */
        OUTAGE,
        /** 401/403: the API key is wrong or revoked; the events stay queued and are resent. */
        AUTH,
        /** The ingestor refused the events; they are dropped. */
        REJECTED,
        /** Still queued at the shutdown deadline; dropped. */
        SHUTDOWN,
        /** Recorded after {@code close()}; dropped. */
        CLOSED
    }

    /** A delivery problem reported to {@code Builder.onError}. The message never contains the API key. */
    public static final class MeteringError {
        private final ErrorKind kind;
        private final String message;
        private final java.util.List<Map<String, Object>> events;
        private final int status;

        MeteringError(ErrorKind kind, String message, java.util.List<Map<String, Object>> events, int status) {
            this.kind = kind;
            this.message = message;
            this.events = java.util.List.copyOf(events);
            this.status = status;
        }

        public ErrorKind kind() { return kind; }
        public String message() { return message; }
        /** The events concerned: the queued ones for OUTAGE/AUTH, the dropped ones otherwise (may be empty). */
        public java.util.List<Map<String, Object>> events() { return events; }
        /** HTTP status of the answer that caused the report, or 0. */
        public int status() { return status; }
        /** True when the events are still queued and will be resent. */
        public boolean willRetry() { return kind == ErrorKind.OUTAGE || kind == ErrorKind.AUTH; }

        @Override
        public String toString() {
            return "MeteringError{kind=" + kind + ", status=" + status + ", events=" + events.size()
                    + ", message=" + message + "}";
        }
    }

    private static ErrorKind map(TransportCore.ErrorKind kind) {
        return switch (kind) {
            case OUTAGE -> ErrorKind.OUTAGE;
            case AUTH -> ErrorKind.AUTH;
            case REJECTED -> ErrorKind.REJECTED;
            case SHUTDOWN -> ErrorKind.SHUTDOWN;
            case CLOSED -> ErrorKind.CLOSED;
        };
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object body) {
        return body instanceof Map<?, ?> m ? java.util.Collections.unmodifiableMap((Map<String, Object>) m) : Map.of();
    }

    private static DropReason map(TransportCore.Reason reason) {
        return switch (reason) {
            case OVERFLOW -> DropReason.OVERFLOW;
            case REJECTED -> DropReason.REJECTED;
            case INVALID -> DropReason.INVALID;
            case SHUTDOWN -> DropReason.SHUTDOWN;
            case CLOSED -> DropReason.CLOSED;
            case RETRY_EXHAUSTED -> DropReason.RETRY_EXHAUSTED;
        };
    }

    /** Number of events permanently dropped (every {@link DropReason}) since this instance was created. */
    public long droppedCount() { return core.droppedCount(); }

    /** Events waiting to be sent. */
    public int bufferedCount() { return core.size(); }


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
     * An event the ingestor would refuse: not queued, not sent, counted in
     * {@link #droppedCount()}, logged (first, then every 1000th) and handed to the
     * onDrop hook with {@link DropReason#INVALID}.
     */
    private void recordInvalid(Map<String, Object> event, String violation) {
        core.dropInvalid(event, violation);
    }

    /** Buffers an event, or drops it as {@link DropReason#INVALID} when it breaks a field limit. */
    private void enqueue(Map<String, Object> event) {
        String violation = limitViolation(event);
        if (violation != null) {
            recordInvalid(event, violation);
            return;
        }
        core.track(event);
    }

    /**
     * Sends what is queued until the shutdown deadline ({@link Builder#shutdownTimeoutMs(long)},
     * default 5 s), then stops the background thread and the HTTP client. Events left at the
     * deadline are reported as {@link DropReason#SHUTDOWN}. Idempotent.
     */
    @Override
    public void close() {
        core.close();
    }

    private static class TimingState implements InstrumentationState {
        long startMs;
    }

    /** The resolver's answer; a resolver that throws counts as no customer and never fails the operation. */
    private String resolveCustomer(InstrumentationExecutionParameters parameters) {
        try {
            String id = customerResolver.resolve(parameters);
            return id == null || id.isBlank() ? null : id.trim();
        } catch (RuntimeException e) {
            LOG.log(Level.FINE, "[aforo-graphql] customer resolver threw; the operation is not metered", e);
            return null;
        }
    }

    /**
     * The {@code trustCustomerHeader(true)} source: the {@code x-customer-id} (or
     * {@code customerId}) entry of the {@link graphql.GraphQLContext}, then of a legacy
     * {@code Map} context. graphql-java 17+ passes a {@code GraphQLContext}, which is not a
     * {@code Map}, so reading only the legacy context found nothing (G309).
     */
    @SuppressWarnings("deprecation")
    static String contextCustomerId(InstrumentationExecutionParameters params) {
        graphql.GraphQLContext gql = params.getGraphQLContext();
        if (gql != null) {
            Object v = gql.get("x-customer-id");
            if (v == null) v = gql.get("customerId");
            if (v instanceof String s) return s;
        }
        Object ctx = params.getContext();
        if (ctx instanceof Map<?, ?> map) {
            Object v = map.get("x-customer-id");
            if (v == null) v = map.get("customerId");
            if (v instanceof String s) return s;
        }
        return null;
    }

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


    /** The client-level {@code productType} stamped on events without a per-call override. */
    public String getProductType() { return productType; }

    public static Builder newBuilder() { return new Builder(); }

    public static final class Builder {
        private String productType;
        private String tenantId, productId, apiKey, ingestorUrl, schemaVersion;
        private int flushCount = TransportConfig.DEFAULT_FLUSH_COUNT;
        private long flushIntervalMs = TransportConfig.DEFAULT_FLUSH_INTERVAL_MS;
        private int maxQueueSize = TransportConfig.DEFAULT_QUEUE_CAPACITY;
        private int maxRetries = TransportConfig.DEFAULT_MAX_RETRIES;
        private long retryBaseMs = TransportConfig.DEFAULT_RETRY_BASE_MS;
        private long timeoutMs = TransportConfig.DEFAULT_TIMEOUT_MS;
        private long shutdownTimeoutMs = TransportConfig.DEFAULT_SHUTDOWN_TIMEOUT_MS;
        private long breakerCooldownMs = TransportConfig.DEFAULT_BREAKER_INITIAL_MS;
        private boolean allowInsecureHttp;
        private String compression = "gzip";
        private BiConsumer<java.util.List<Map<String, Object>>, DropReason> onDrop;
        private java.util.function.Consumer<MeteringError> onError;
        private BiConsumer<Map<String, Object>, java.util.List<Map<String, Object>>> onAccepted;
        private CustomerResolver customerResolver;
        private boolean trustCustomerHeader;

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
        /** Events per request (default 500, at most 1000). */
        public Builder flushCount(int n) { this.flushCount = n; return this; }
        /** How often queued events are sent when the batch is not full (default 5 s). */
        public Builder flushIntervalMs(long n) { this.flushIntervalMs = n; return this; }
        /** Queue capacity (default 10 000). When full, the oldest event is dropped as {@code OVERFLOW}. */
        public Builder maxQueueSize(int n) { this.maxQueueSize = n; return this; }
        /** Retries per request on a network error, timeout, 408, 429 or 5xx (default 3). */
        public Builder maxRetries(int n) { this.maxRetries = n; return this; }
        /** Base of the full-jitter retry backoff (default 500 ms). */
        public Builder retryBaseMs(long n) { this.retryBaseMs = n; return this; }
        /** Total deadline of one ingest request (default 10 s). */
        public Builder timeoutMs(long n) { this.timeoutMs = n; return this; }
        /** How long {@link #close()} keeps sending queued events (default 5 s). */
        public Builder shutdownTimeoutMs(long n) { this.shutdownTimeoutMs = n; return this; }
        /** First pause after the ingestor stays unreachable through every retry (default 5 s, doubling to 5 min). */
        public Builder breakerCooldownMs(long n) { this.breakerCooldownMs = n; return this; }
        /** Allow a plain http:// ingestor URL on a host other than localhost. Off by default: the API key is in every request. */
        public Builder allowInsecureHttp(boolean b) { this.allowInsecureHttp = b; return this; }
        /** "gzip" (default): batches of 1 KiB or more are sent with Content-Encoding: gzip (needs usage-ingestor wave 8 or later); "none": always plain JSON. */
        public Builder compression(String c) { this.compression = c; return this; }
        /**
         * Opt-in hook receiving events that were permanently dropped (retry
         * exhaustion, a terminal rejection, or an event that breaks an ingestor
         * field limit — {@code DropReason.INVALID}). Events keep their idempotency
         * keys, so persisting and re-submitting them after recovery is
         * dedup-safe. Exceptions thrown by the hook are swallowed. Default:
         * none (drops are still counted in droppedCount() and WARN-logged).
         */
        public Builder onDrop(BiConsumer<java.util.List<Map<String, Object>>, DropReason> fn) { this.onDrop = fn; return this; }
        /**
         * Opt-in hook for delivery problems, typed by {@link MeteringError#kind()}. Runs on the
         * background sender thread; it may call {@code close()}. Exceptions are caught and logged.
         */
        public Builder onError(java.util.function.Consumer<MeteringError> fn) { this.onError = fn; return this; }
        /**
         * Opt-in hook receiving the envelope-unwrapped body of every accepted (2xx) batch (empty
         * when the body was not a JSON object). Runs on the sender thread; exceptions are caught and logged.
         */
        public Builder onAccepted(BiConsumer<Map<String, Object>, java.util.List<Map<String, Object>>> fn) { this.onAccepted = fn; return this; }
        /** Reads the customer for each operation from your authentication. Required unless {@link #trustCustomerHeader(boolean)}. */
        public Builder customerResolver(CustomerResolver resolver) { this.customerResolver = resolver; return this; }

        /** Kept for 1.x callers; prefer {@link #customerResolver(CustomerResolver)}. */
        @Deprecated
        public Builder customerIdExtractor(Function<InstrumentationExecutionParameters, String> fn) {
            this.customerResolver = fn == null ? null : fn::apply;
            return this;
        }

        /**
         * Opt in to reading the {@code x-customer-id} / {@code customerId} entry of the
         * GraphQLContext (or a legacy Map context). Only when that entry comes from an
         * authenticated source, never from a header the caller sets.
         */
        public Builder trustCustomerHeader(boolean trust) { this.trustCustomerHeader = trust; return this; }

        CustomerResolver customerResolver() {
            if (customerResolver != null) return customerResolver;
            if (trustCustomerHeader) return AforoGraphQlBilling::contextCustomerId;
            throw new IllegalStateException(MISSING_CUSTOMER_SOURCE);
        }

        /** @throws IllegalStateException without {@link #customerResolver} or {@link #trustCustomerHeader} */
        public AforoGraphQlBilling build() { customerResolver(); return new AforoGraphQlBilling(this); }
    }
}
