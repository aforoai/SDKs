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
 *       .ingestorUrl("https://ingestor.aforo.ai")
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
    private static final String SDK_VERSION = "1.0.0";

    private final String tenantId, productId, apiKey, schemaVersion;
    private final URI ingestorUri;
    private final int flushCount;
    private final long flushIntervalMs;
    private final Function<InstrumentationExecutionParameters, String> customerIdExtractor;

    private final ConcurrentLinkedQueue<Map<String, Object>> buffer = new ConcurrentLinkedQueue<>();
    private final AtomicInteger bufferSize = new AtomicInteger();
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
        this.ingestorUri = URI.create(stripTrailingSlash(require(b.ingestorUrl, "ingestorUrl")) + "/v1/ingest/events");
        this.flushCount = b.flushCount;
        this.flushIntervalMs = b.flushIntervalMs;
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
                        record(customerId, parameters.getQuery(), parameters.getOperation(), durationMs, hasErrors);
                    } catch (Exception e) {
                        LOG.log(Level.FINE, "[aforo-graphql] instrumentation error", e);
                    }
                });
            }
        };
    }

    /** Record one operation manually. Public for non-graphql-java integrations. */
    public void record(String customerId, String query, String operationName, long durationMs, boolean hasErrors) {
        if (customerId == null || customerId.isBlank() || query == null || query.isBlank()) return;
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
            event.put("idempotencyKey", "gql:" + tenantId + ":" + productId + ":" + opName + ":"
                    + now.toEpochMilli() + ":" + UUID.randomUUID().toString().substring(0, 8));
            event.put("productType", "GRAPHQL_API");
            event.put("gqlOperationType", opType);
            event.put("gqlOperationName", opName);
            event.put("gqlComplexity", complexity);
            event.put("gqlFieldCount", fc[0]);
            event.put("gqlHasErrors", hasErrors);
            event.put("executionDurationMs", durationMs);

            Map<String, Object> meta = new HashMap<>();
            meta.put("sdkVersion", SDK_VERSION);
            meta.put("productId", productId);
            if (schemaVersion != null) meta.put("schemaVersion", schemaVersion);
            event.put("metadata", meta);

            buffer.offer(event);
            if (bufferSize.incrementAndGet() >= flushCount) {
                scheduler.execute(this::flushQuietly);
            }
        } catch (Exception ignored) {
            // Never fail the response due to metering
        }
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

    private void flushQuietly() {
        try { flush(); } catch (Exception e) { LOG.log(Level.WARNING, "[aforo-graphql] flush failed", e); }
    }

    private void flush() throws Exception {
        if (bufferSize.get() == 0) return;
        java.util.List<Map<String, Object>> batch = new java.util.ArrayList<>();
        Map<String, Object> ev;
        while ((ev = buffer.poll()) != null) { batch.add(ev); bufferSize.decrementAndGet(); }
        if (batch.isEmpty()) return;

        String body = mapper.writeValueAsString(Map.of("events", batch));
        HttpRequest req = HttpRequest.newBuilder(ingestorUri)
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .header("X-Tenant-Id", tenantId)
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        for (int attempt = 1; attempt <= 3; attempt++) {
            try {
                HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
                if (resp.statusCode() >= 200 && resp.statusCode() < 300) return;
            } catch (Exception e) {
                if (attempt == 3) throw e;
            }
            Thread.sleep((long) Math.pow(2, attempt - 1) * 1000);
        }
        LOG.warning("[aforo-graphql] flush exhausted retries — dropped " + batch.size() + " events");
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

    private static String require(String s, String name) {
        if (s == null || s.isBlank()) throw new IllegalArgumentException(name + " is required");
        return s;
    }

    private static String stripTrailingSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    public static Builder newBuilder() { return new Builder(); }

    public static final class Builder {
        private String tenantId, productId, apiKey, ingestorUrl, schemaVersion;
        private int flushCount = 50;
        private long flushIntervalMs = 5_000L;
        private Function<InstrumentationExecutionParameters, String> customerIdExtractor;

        public Builder tenantId(String s) { this.tenantId = s; return this; }
        public Builder productId(String s) { this.productId = s; return this; }
        public Builder apiKey(String s) { this.apiKey = s; return this; }
        public Builder ingestorUrl(String s) { this.ingestorUrl = s; return this; }
        public Builder schemaVersion(String s) { this.schemaVersion = s; return this; }
        public Builder flushCount(int n) { this.flushCount = n; return this; }
        public Builder flushIntervalMs(long n) { this.flushIntervalMs = n; return this; }
        public Builder customerIdExtractor(Function<InstrumentationExecutionParameters, String> fn) {
            this.customerIdExtractor = fn; return this;
        }
        public AforoGraphQlBilling build() { return new AforoGraphQlBilling(this); }
    }
}
