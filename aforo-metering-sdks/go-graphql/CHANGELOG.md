# Changelog

All notable changes to `graphql-metering-go` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning. The version is recorded in the top-level `VERSION` file (Go has no manifest version field) and in the package's `sdkVersion` constant.

Documents the existing package as-is: the `graphqlmetering` package at module path `github.com/aforo/graphql-metering-go` — `New`/`Config`, `Middleware` (wraps a GraphQL-over-HTTP POST handler), `Record` (manual per-operation), and `Shutdown`. Operation type/name detection, an approximate complexity score (`field_count + 5 × max_depth`), per-operation `graphql_api.operations` events with `X-Tenant-Id`, batched delivery with 3× retry to `POST /v1/ingest/events`. No source logic changed.
