# Changelog — aforo_metering (EMQX plugin)

Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org). Version is declared in `aforo_metering.app.src` (`vsn`).

## [Unreleased]

- Load test (10K msg/sec sustained, 100K peak per node) — not yet run.
- CI pipeline (rebar3 compile + eunit + ct), GPG-signed release tarballs, marketplace publish — not yet built.
- HTTP endpoint exposing `aforo_metering:health/0` — needs a separate dashboard plugin module.

See [`TODO.md`](TODO.md) for the full production-hardening checklist.

## [0.1.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning. **Experimental.**

The Erlang/rebar3 plugin scaffold covers the working metering path on EMQX 5.x:

- Six EMQX 5.x hooks (`client.connected`, `client.disconnected`, `message.publish`, `message.delivered`, `session.subscribed`, `session.unsubscribed`) at `?HP_LOWEST`, emitting `mqtt_broker.*` events.
- Two-table ETS swap buffer with timer/count-based flushing and 3× exponential-backoff retry to the Aforo ingestor.
- Retention cap (`max_buffer_size`, oldest-50%-drop) and a `persistent_term` circuit breaker to bound memory and skip POSTs under a sustained ingestor outage.
- Pluggable customer-ID resolver (`username` / `clientid_prefix` / `jwt` / `http`), cached per `(tenant, clientid)`.
- Prometheus counters via `emqx_metrics` and an `aforo_metering:health/0` status map.

This release sets the application `vsn` to `0.1.0` to reflect pre-production status; the in-code `?SDK_VERSION` event-contract string and the `rebar.config` release-tarball version are independent and unchanged. Source logic was not modified.
