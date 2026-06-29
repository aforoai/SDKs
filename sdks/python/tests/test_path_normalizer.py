"""Tests for aforo.path_normalizer."""

from aforo.path_normalizer import normalize_path


class TestNormalizePath:
    def test_uses_route_template(self):
        assert normalize_path("/users/123", "/users/:id") == "/users/:id"

    def test_replaces_numeric_ids(self):
        assert normalize_path("/users/42") == "/users/:id"
        assert normalize_path("/orders/123/items/456") == "/orders/:id/items/:id"

    def test_replaces_uuids(self):
        assert normalize_path("/users/550e8400-e29b-41d4-a716-446655440000") == "/users/:id"

    def test_replaces_mongo_ids(self):
        assert normalize_path("/docs/507f1f77bcf86cd799439011") == "/docs/:id"

    def test_keeps_path_words(self):
        assert normalize_path("/api/v1/users") == "/api/v1/users"
        assert normalize_path("/health") == "/health"

    def test_root_path(self):
        assert normalize_path("/") == "/"

    def test_preserves_versions(self):
        assert normalize_path("/api/v1/data") == "/api/v1/data"
        assert normalize_path("/api/v2/teams/42") == "/api/v2/teams/:id"
