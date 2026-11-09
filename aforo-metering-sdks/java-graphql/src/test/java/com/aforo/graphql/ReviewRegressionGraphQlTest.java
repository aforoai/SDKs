package com.aforo.graphql;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import graphql.ExecutionInput;
import graphql.ExecutionResult;
import graphql.GraphQL;
import graphql.execution.preparsed.persisted.ApolloPersistedQuerySupport;
import graphql.execution.preparsed.persisted.InMemoryPersistedQueryCache;
import graphql.execution.preparsed.persisted.PersistedQuerySupport;
import graphql.schema.GraphQLSchema;
import graphql.schema.idl.RuntimeWiring;
import graphql.schema.idl.SchemaGenerator;
import graphql.schema.idl.SchemaParser;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;

/** Regression test for review finding 10: persisted queries are metered; unreadable operations are counted. */
class ReviewRegressionGraphQlTest {
    @Test
    void persistedQueriesAreMeteredAndUnreadableOperationsAreCounted() throws Exception {
        ObjectMapper om = new ObjectMapper();
        List<JsonNode> events = new CopyOnWriteArrayList<>();
        List<String> drops = new CopyOnWriteArrayList<>();
        HttpServer ingest = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        ingest.createContext("/", ex -> {
            om.readTree(com.aforo.testsupport.RequestBodies.read(ex)).get("events").forEach(events::add);
            ex.sendResponseHeaders(202, -1);
            ex.close();
        });
        ingest.start();
        AforoGraphQlBilling billing = AforoGraphQlBilling.newBuilder().tenantId("t").productId("p").apiKey("k")
                .ingestorUrl("http://127.0.0.1:" + ingest.getAddress().getPort())
                .customerResolver(params -> "cust_1").flushIntervalMs(60_000)
                .onDrop((ev, reason) -> drops.add(reason + "x" + ev.size())).build();
        GraphQLSchema schema = new SchemaGenerator().makeExecutableSchema(
                new SchemaParser().parse("type Query { hello: String user: User } type User { name: String }"),
                RuntimeWiring.newRuntimeWiring().type("Query", b -> b.dataFetcher("hello", env -> "world")).build());
        String query = "query Who { user { name } }";
        String hash = AforoGraphQlBilling.sha256Hex(query);
        GraphQL gql = GraphQL.newGraphQL(schema).instrumentation(billing.instrumentation())
                .preparsedDocumentProvider(new ApolloPersistedQuerySupport(
                        new InMemoryPersistedQueryCache(Map.of(hash, query))))
                .build();

        ExecutionResult apq = gql.execute(ExecutionInput.newExecutionInput(PersistedQuerySupport.PERSISTED_QUERY_MARKER)
                .extensions(Map.of("persistedQuery", Map.of("version", 1, "sha256Hash", hash))).build());
        ExecutionResult plain = gql.execute(ExecutionInput.newExecutionInput("{ hello }").build());
        ExecutionResult invalid = gql.execute(ExecutionInput.newExecutionInput("{ nope }").build());
        assertThat(apq.getErrors()).isEmpty();
        assertThat(plain.getErrors()).isEmpty();
        assertThat(invalid.getErrors()).isNotEmpty();
        billing.record("cust_1", "query {", null, 1, true, "ERROR"); // unparsable: counted, not silent
        billing.close();
        ingest.stop(0);

        assertThat(events).hasSize(3);
        JsonNode first = events.get(0);
        assertThat(first.get("gqlOperationName").asText()).isEqualTo("Who");
        assertThat(first.get("gqlOperationType").asText()).isEqualTo("QUERY");
        assertThat(first.get("gqlFieldCount").asInt()).isEqualTo(2);
        assertThat(first.get("executionStatus").asText()).isEqualTo("SUCCESS");
        assertThat(events.get(2).get("executionStatus").asText()).isEqualTo("VALIDATION_FAILED");
        assertThat(billing.droppedCount()).isEqualTo(1);
        assertThat(drops).containsExactly("INVALIDx1");
    }
}
