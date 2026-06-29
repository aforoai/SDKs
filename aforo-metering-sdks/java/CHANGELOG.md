# Changelog

All notable changes to `com.aforo:metering` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.0.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning.

- `AforoClient` (`AutoCloseable`): buffered, batched event delivery to `POST https://ingest.aforo.ai/v1/ingest/batch` with size/time-threshold flush, 3× retry on 5xx/408/429 (honoring `Retry-After`), and a JVM shutdown hook.
- `AforoOptions` fluent configuration; `TrackEvent` builder; `FlushResult` record.
- Spring Boot auto-configuration (`aforo.enabled=true`) wiring an `AforoClient` bean and `AforoServletFilter` (request-end, non-blocking, default path excludes).
- `PathNormalizer` for route-template / id-segment normalization; deterministic idempotency-key derivation.
