package com.aforo.graphql;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import graphql.ExecutionInput;
import graphql.ExecutionResult;
import graphql.GraphQL;
import graphql.schema.GraphQLSchema;
import graphql.schema.idl.RuntimeWiring;
import graphql.schema.idl.SchemaGenerator;
import graphql.schema.idl.SchemaParser;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Regression for the 2026-11-09 end-to-end test: complexity and field count covered every operation in
 * the document, so a multi-operation document over-billed the operation that ran.
 */
class EndToEndRegressionGraphQlTest {
    private final ObjectMapper om = new ObjectMapper();
    private final List<JsonNode> events = new CopyOnWriteArrayList<>();
    private HttpServer ingest;
    private AforoGraphQlBilling billing;

    @BeforeEach
    void setUp() throws Exception {
        ingest = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        ingest.createContext("/", ex -> {
            om.readTree(com.aforo.testsupport.RequestBodies.read(ex)).get("events").forEach(events::add);
            ex.sendResponseHeaders(202, -1);
            ex.close();
        });
        ingest.start();
        billing = AforoGraphQlBilling.newBuilder().tenantId("t").productId("p").apiKey("k")
                .ingestorUrl("http://127.0.0.1:" + ingest.getAddress().getPort())
                .customerResolver(params -> "cust_1").flushIntervalMs(60_000).build();
    }

    @AfterEach
    void tearDown() {
        billing.close();
        ingest.stop(0);
    }

    private GraphQL graphQl() {
        GraphQLSchema schema = new SchemaGenerator().makeExecutableSchema(new SchemaParser().parse(
                "type Query { users: [User] user: User }"
                        + " type Mutation { createOrder(item: String!): Order }"
                        + " type User { id: ID name: String }  type Order { id: ID }"),
                RuntimeWiring.newRuntimeWiring()
                        .type("Query", b -> b.dataFetcher("users", env -> List.of(Map.of("id", "1")))
                                .dataFetcher("user", env -> Map.of("id", "1", "name", "Ada")))
                        .type("Mutation", b -> b.dataFetcher("createOrder", env -> Map.of("id", "o1")))
                        .build());
        return GraphQL.newGraphQL(schema).instrumentation(billing.instrumentation()).build();
    }

    private JsonNode byName(String name) {
        return events.stream().filter(e -> e.get("gqlOperationName").asText().equals(name)).findFirst().orElseThrow();
    }

    @Test
    void onlyTheOperationThatRunsIsScored() {
        String doc = "query A { users { id } } mutation PickMe { createOrder(item: \"cup\") { id } }";
        ExecutionResult r = graphQl().execute(ExecutionInput.newExecutionInput(doc).operationName("PickMe").build());
        assertThat(r.getErrors()).isEmpty();
        // The same document recorded by hand, selecting the other operation.
        billing.record("cust_1", doc, "A", 3L, false, "SUCCESS");
        billing.close();

        assertThat(events).hasSize(2);
        JsonNode pickMe = byName("PickMe");
        assertThat(pickMe.get("gqlOperationType").asText()).isEqualTo("MUTATION");
        assertThat(pickMe.get("gqlFieldCount").asInt()).isEqualTo(2);   // createOrder, id
        assertThat(pickMe.get("gqlComplexity").asInt()).isEqualTo(12);  // 2 + 5 x depth 2
        JsonNode a = byName("A");
        assertThat(a.get("gqlFieldCount").asInt()).isEqualTo(2);        // users, id
        assertThat(a.get("gqlComplexity").asInt()).isEqualTo(12);
    }

    @Test
    void fragmentsCountWhereTheyAreSpreadAndUnusedOnesDoNot() {
        String doc = "query Q { first: user { ...U } second: user { ...U } } fragment U on User { id name }";
        ExecutionResult r = graphQl().execute(ExecutionInput.newExecutionInput(doc).build());
        assertThat(r.getErrors()).isEmpty();
        // graphql-java refuses a document with an unused fragment, so that case goes through record().
        billing.record("cust_1", "query R { user { ...U } } fragment U on User { id } fragment Unused on User { id name }",
                "R", 2L, false, "SUCCESS");
        billing.close();

        JsonNode q = byName("Q");
        assertThat(q.get("gqlFieldCount").asInt()).isEqualTo(6);   // 2 x (user + id + name)
        assertThat(q.get("gqlComplexity").asInt()).isEqualTo(16);  // 6 + 5 x depth 2
        JsonNode rec = byName("R");
        assertThat(rec.get("gqlFieldCount").asInt()).isEqualTo(2);  // user, id; Unused is not counted
        assertThat(rec.get("gqlComplexity").asInt()).isEqualTo(12);
    }

    @Test
    void aSelfReferencingFragmentIsNotFollowedForever() {
        // Invalid GraphQL (graphql-java refuses it), but record() parses it: measuring must terminate.
        billing.record("cust_1", "query Loop { user { ...L } } fragment L on User { id ...L }", "Loop", 1L, true,
                "VALIDATION_FAILED");
        billing.close();

        JsonNode loop = byName("Loop");
        assertThat(loop.get("gqlFieldCount").asInt()).isEqualTo(2);  // user, id
        assertThat(loop.get("gqlComplexity").asInt()).isEqualTo(12);
    }

    /** The cross-SDK fixtures: go-graphql, python-graphql and node-graphql score them to the same numbers. */
    static final Object[][] FIXTURES = {
            // doc, operationName, fieldCount, complexity
            {"query A { users { id } } mutation PickMe { createOrder(item:\"cup\") { id } }", "PickMe", 2, 12},
            {"query A { users { id } } mutation PickMe { createOrder(item:\"cup\") { id } }", null, 2, 12},
            {"query Q { first: user(id: 1) { ...U } second: user(id: 2) { ...U } }"
                    + " fragment U on User { id profile { bio } } fragment Unused on User { id name email }", null, 8, 23},
            {"query C { user(id: 7) { id ... on User @include(if: true) { name } } }", null, 3, 13},
            {"query D($first: Int = 5) { top: teams(first: $first, filter: {active: true, tags: [\"a\", \"b\"]})"
                    + " { members: users(limit: 10, order: DESC) @skip(if: false) { recent: orders(last: 3, status: [OPEN, PAID])"
                    + " { id total(currency: \"USD\") } } } }", null, 5, 25},
            {"{ me { id name friends(first: 2) { name } } }", null, 5, 20},
            {"query S { # a { b c }\n a(s: \"{ x y }\", b: \"\"\"{ z }\"\"\") }", null, 1, 6},
            {"query M { user { ...Missing id } }", null, 2, 12},
    };

    @Test
    void crossSdkFixturesScoreTheSameEverywhere() {
        for (Object[] f : FIXTURES) billing.record("cust_1", (String) f[0], (String) f[1], 1L, false, "SUCCESS");
        billing.close();

        assertThat(events).hasSize(FIXTURES.length);
        for (int i = 0; i < FIXTURES.length; i++) {
            assertThat(events.get(i).get("gqlFieldCount").asInt()).as("fields of fixture %d", i).isEqualTo(FIXTURES[i][2]);
            assertThat(events.get(i).get("gqlComplexity").asInt()).as("complexity of fixture %d", i).isEqualTo(FIXTURES[i][3]);
        }
    }

    @Test
    void nestedSpreadsAreMeasuredInLinearTimeAndCapped() {
        // F0 spreads F1 twice, F1 spreads F2 twice, ...: 2^40 fields if expanded one by one.
        StringBuilder doc = new StringBuilder("query Bomb { root { ...F0 } }");
        for (int i = 0; i < 40; i++) {
            doc.append(" fragment F").append(i).append(" on T { a ...F").append(i + 1).append(" ...F").append(i + 1).append(" }");
        }
        doc.append(" fragment F40 on T { leaf }");
        long start = System.nanoTime();
        billing.record("cust_1", doc.toString(), "Bomb", 1L, false, "SUCCESS");
        assertThat(System.nanoTime() - start).isLessThan(2_000_000_000L);
        billing.close();

        JsonNode bomb = byName("Bomb");
        assertThat(bomb.get("gqlFieldCount").asInt()).isEqualTo(Integer.MAX_VALUE);
        assertThat(bomb.get("gqlComplexity").asInt()).isEqualTo(Integer.MAX_VALUE);
    }
}
