/*
 * Real-server integration test for aforo:graphql-metering.
 *
 * Where AforoGraphQlBillingTest uses a mock InstrumentationExecutionParameters,
 * this file:
 *   - builds a REAL graphql-java GraphQL schema with SchemaParser +
 *     RuntimeWiring (real type resolvers, real field fetchers)
 *   - wires billing.instrumentation() on the GraphQL builder
 *   - executes real operations via the graphql-java runtime
 *   - asserts the metering event reaches a real HTTP capture server
 *
 * Catches what mock-based tests can't:
 *   - real Instrumentation lifecycle (beginExecution → whenCompleted)
 *   - real AST walking on a real parsed Document
 *   - real operationType resolution from the runtime
 *   - real flush-over-HTTP round trip
 */
package com.aforo.graphql;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import graphql.ExecutionInput;
import graphql.ExecutionResult;
import graphql.GraphQL;
import graphql.schema.GraphQLSchema;
import graphql.schema.idl.RuntimeWiring;
import graphql.schema.idl.SchemaGenerator;
import graphql.schema.idl.SchemaParser;
import graphql.schema.idl.TypeDefinitionRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static graphql.schema.idl.TypeRuntimeWiring.newTypeWiring;
import static org.assertj.core.api.Assertions.assertThat;

class AforoGraphQlIntegrationTest {

    private static final ObjectMapper OM = new ObjectMapper();

    private HttpServer captureServer;
    private int capturePort;
    private final List<Map<String, Object>> capturedBodies = new ArrayList<>();
    private final List<Map<String, List<String>>> capturedHeaders = new ArrayList<>();

    private AforoGraphQlBilling billing;
    private GraphQL graphql;

    private static final String SCHEMA_SDL = """
            type User { id: ID!, name: String! }
            type Query { user(id: ID!): User, ping: String }
            type Mutation { rename(id: ID!, name: String!): User }
            """;

    @BeforeEach
    void setUp() throws IOException {
        // Capture HTTP server
        captureServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        captureServer.createContext("/", (HttpExchange ex) -> {
            byte[] body = ex.getRequestBody().readAllBytes();
            synchronized (capturedBodies) {
                try {
                    if (body.length > 0) {
                        Map<String, Object> parsed = OM.readValue(body, new TypeReference<>() {});
                        capturedBodies.add(parsed);
                    } else {
                        capturedBodies.add(Map.of());
                    }
                    capturedHeaders.add(Map.copyOf(ex.getRequestHeaders()));
                } catch (Exception ignore) {
                    capturedBodies.add(Map.of());
                }
            }
            ex.sendResponseHeaders(204, -1);
            ex.close();
        });
        captureServer.start();
        capturePort = captureServer.getAddress().getPort();

        billing = AforoGraphQlBilling.newBuilder()
                .tenantId("tenant-int-gql")
                .productId("prod-int-gql")
                .apiKey("sk_int_gql")
                .ingestorUrl("http://127.0.0.1:" + capturePort)
                .flushCount(1)
                .flushIntervalMs(60_000L)
                .build();

        // Real graphql-java schema
        TypeDefinitionRegistry typeRegistry = new SchemaParser().parse(SCHEMA_SDL);
        RuntimeWiring wiring = RuntimeWiring.newRuntimeWiring()
                .type(newTypeWiring("Query")
                        .dataFetcher("user", env -> {
                            String id = env.getArgument("id");
                            return Map.of("id", id, "name", "user-" + id);
                        })
                        .dataFetcher("ping", env -> "pong"))
                .type(newTypeWiring("Mutation")
                        .dataFetcher("rename", env -> Map.of(
                                "id", env.getArgument("id"),
                                "name", env.getArgument("name"))))
                .build();
        GraphQLSchema schema = new SchemaGenerator().makeExecutableSchema(typeRegistry, wiring);

        graphql = GraphQL.newGraphQL(schema)
                .instrumentation(billing.instrumentation())
                .build();
    }

    @AfterEach
    void tearDown() {
        if (billing != null) billing.close();
        if (captureServer != null) captureServer.stop(0);
    }

    private ExecutionResult execute(String query, String operationName, Map<String, Object> variables, String customerId) {
        ExecutionInput.Builder input = ExecutionInput.newExecutionInput()
                .query(query);
        if (operationName != null) input.operationName(operationName);
        if (variables != null) input.variables(variables);
        if (customerId != null) {
            // DEFAULT_CUSTOMER_EXTRACTOR reads params.getContext() — pass a Map
            // matching what it expects.
            @SuppressWarnings("deprecation")
            ExecutionInput.Builder b = input.context(Map.of("x-customer-id", customerId));
            input = b;
        }
        return graphql.execute(input.build());
    }

    private List<Map<String, Object>> waitForEvents(int count, long timeoutMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            List<Map<String, Object>> events = flatten();
            if (events.size() >= count) return events;
            Thread.sleep(25);
        }
        return flatten();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> flatten() {
        List<Map<String, Object>> out = new ArrayList<>();
        synchronized (capturedBodies) {
            for (Map<String, Object> body : capturedBodies) {
                Object evs = body.get("events");
                if (evs instanceof List<?> list) {
                    for (Object o : list) {
                        if (o instanceof Map<?, ?> m) out.add((Map<String, Object>) m);
                    }
                }
            }
        }
        return out;
    }

    // ── Tests ─────────────────────────────────────────────────────────

    @Test
    void QUERY_realExecution_emitsEventWithCorrectShape() throws Exception {
        ExecutionResult result = execute(
                "query GetUser($id: ID!) { user(id: $id) { id name } }",
                "GetUser",
                Map.of("id", "u1"),
                "cust_query_001");

        assertThat(result.getErrors()).isEmpty();
        Map<String, Object> data = result.getData();
        @SuppressWarnings("unchecked")
        Map<String, Object> user = (Map<String, Object>) data.get("user");
        assertThat(user).containsEntry("id", "u1").containsEntry("name", "user-u1");

        List<Map<String, Object>> events = waitForEvents(1, 3000);
        assertThat(events).isNotEmpty();
        Map<String, Object> ev = events.get(0);
        assertThat(ev).containsEntry("productType", "GRAPHQL_API");
        assertThat(ev).containsEntry("gqlOperationType", "QUERY");
        assertThat(ev).containsEntry("gqlOperationName", "GetUser");
        assertThat(ev).containsEntry("customerId", "cust_query_001");
        assertThat(((Number) ev.get("gqlComplexity")).intValue()).isGreaterThan(0);
        assertThat(ev).containsEntry("gqlHasErrors", Boolean.FALSE);
    }

    @Test
    void MUTATION_realExecution_classifiedCorrectly() throws Exception {
        ExecutionResult result = execute(
                "mutation Rename($id: ID!, $n: String!) { rename(id: $id, name: $n) { id name } }",
                "Rename",
                Map.of("id", "u1", "n", "updated"),
                "cust_mut_001");

        assertThat(result.getErrors()).isEmpty();

        List<Map<String, Object>> events = waitForEvents(1, 3000);
        assertThat(events).isNotEmpty();
        Map<String, Object> ev = events.get(0);
        assertThat(ev).containsEntry("gqlOperationType", "MUTATION");
        assertThat(ev).containsEntry("gqlOperationName", "Rename");
        assertThat(ev).containsEntry("customerId", "cust_mut_001");
    }

    @Test
    void noCustomerId_isSilentlySkipped() throws Exception {
        ExecutionResult result = execute("{ ping }", null, null, null);
        assertThat(result.getErrors()).isEmpty();

        // Give the SDK a beat, then close and check no events were captured
        Thread.sleep(200);
        billing.close();
        assertThat(flatten()).isEmpty();
    }

    @Test
    void schemaErrors_areFlagged() throws Exception {
        // Schema-invalid field → graphql-java returns an ExecutionResult
        // with validation errors and the instrumentation still runs.
        ExecutionResult result = execute("{ thisFieldDoesNotExist }", null, null, "cust_err_001");
        assertThat(result.getErrors()).isNotEmpty();

        List<Map<String, Object>> events = waitForEvents(1, 3000);
        assertThat(events).isNotEmpty();
        Map<String, Object> ev = events.get(0);
        assertThat(ev).containsEntry("gqlHasErrors", Boolean.TRUE);
        assertThat(ev).containsEntry("customerId", "cust_err_001");
    }
}
