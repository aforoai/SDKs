package com.aforo.metering;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("PathNormalizer")
class PathNormalizerTest {

    @Test
    void usesRouteTemplate() {
        assertThat(PathNormalizer.normalize("/users/123", "/users/{id}")).isEqualTo("/users/{id}");
    }

    @Test
    void replacesNumericIds() {
        assertThat(PathNormalizer.normalize("/users/42")).isEqualTo("/users/:id");
    }

    @Test
    void replacesUuids() {
        assertThat(PathNormalizer.normalize("/users/550e8400-e29b-41d4-a716-446655440000"))
                .isEqualTo("/users/:id");
    }

    @Test
    void preservesVersionSegments() {
        assertThat(PathNormalizer.normalize("/api/v1/users")).isEqualTo("/api/v1/users");
    }

    @Test
    void handlesRootPath() {
        assertThat(PathNormalizer.normalize("/")).isEqualTo("/");
    }

    @Test
    void nestedPathsWithMixedSegments() {
        assertThat(PathNormalizer.normalize("/api/v1/teams/42/members/99"))
                .isEqualTo("/api/v1/teams/:id/members/:id");
    }
}
