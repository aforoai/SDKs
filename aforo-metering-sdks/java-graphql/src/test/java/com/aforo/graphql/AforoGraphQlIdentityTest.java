package com.aforo.graphql;

import graphql.ExecutionInput;
import graphql.GraphQL;
import graphql.schema.GraphQLSchema;
import graphql.schema.idl.RuntimeWiring;
import graphql.schema.idl.SchemaGenerator;
import graphql.schema.idl.SchemaParser;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static graphql.schema.idl.TypeRuntimeWiring.newTypeWiring;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@DisplayName("AforoGraphQlBilling — customer identity (G265) and GraphQLContext (G309)")
class AforoGraphQlIdentityTest {

    private final List<AforoGraphQlBilling.DropReason> reasons = new CopyOnWriteArrayList<>();

    private AforoGraphQlBilling.Builder builder() {
        return AforoGraphQlBilling.newBuilder().tenantId("tenant-001").productId("prod-gql")
                .apiKey("sk_test").ingestorUrl("http://127.0.0.1:1")
                .flushIntervalMs(60_000).shutdownTimeoutMs(0)
                .onDrop((events, reason) -> reasons.add(reason));
    }

    private static GraphQL graphql(AforoGraphQlBilling billing) {
        GraphQLSchema schema = new SchemaGenerator().makeExecutableSchema(
                new SchemaParser().parse("type Query { ping: String }"),
                RuntimeWiring.newRuntimeWiring().type(newTypeWiring("Query").dataFetcher("ping", env -> "pong")).build());
        return GraphQL.newGraphQL(schema).instrumentation(billing.instrumentation()).build();
    }

    @Test
    void buildFailsWithoutACustomerSource() {
        assertThatThrownBy(() -> builder().build())
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("customerResolver")
                .hasMessageContaining("trustCustomerHeader(true)");
    }

    /** G309: graphql-java 17+ passes a GraphQLContext, not a Map; the opt-in source must read it. */
    @Test
    void trustedSourceReadsTheModernGraphQLContext() {
        try (AforoGraphQlBilling b = builder().trustCustomerHeader(true).build()) {
            graphql(b).execute(ExecutionInput.newExecutionInput().query("{ ping }")
                    .graphQLContext(Map.of("x-customer-id", "cust_ctx")).build());
            assertThat(b.bufferedCount()).isEqualTo(1);
            assertThat(reasons).isEmpty();
        }
    }

    @Test
    void resolverReadsWhatTheHttpLayerAuthenticated() {
        try (AforoGraphQlBilling b = builder()
                .customerResolver(p -> p.getGraphQLContext().get("aforoCustomerId")).build()) {
            graphql(b).execute(ExecutionInput.newExecutionInput().query("{ ping }")
                    .graphQLContext(Map.of("aforoCustomerId", "cust_auth", "x-customer-id", "cust_spoofed")).build());
            assertThat(b.bufferedCount()).isEqualTo(1);
        }
    }

    @Test
    void anOperationWithNoCustomerIsCountedAsInvalidAndStillAnswered() {
        try (AforoGraphQlBilling b = builder().customerResolver(p -> null).build()) {
            var result = graphql(b).execute("{ ping }");
            assertThat(result.getErrors()).isEmpty();
            assertThat(b.bufferedCount()).isZero();
            assertThat(reasons).containsExactly(AforoGraphQlBilling.DropReason.INVALID);
        }
    }
}
