# Changelog — aforo_metering (EMQX plugin)

Format follows [Keep a Changelog](https://keepachangelog.com); versioning follows [SemVer](https://semver.org). Version is declared in `aforo_metering.app.src` (`vsn`).

## [Unreleased]

- Run 2.0.1 inside a real EMQX 5.7+ broker (install of the package, hooks, `client_attrs`, plugin config and `on_config_changed`) — not yet done.
- Load test (10K msg/sec sustained, 100K peak per node) — not yet run.
- GPG-signed release packages, marketplace publish — not yet built. (CI now runs eunit and builds the package.)
- HTTP endpoint exposing `aforo_metering:health/0` — needs a separate dashboard plugin module.

See [`TODO.md`](TODO.md) for the full production-hardening checklist.

## [2.0.1] — 2026-10-28

**Breaking for 2.0.0 configs** (2.0.0 never read them — see below). Tested on plain Erlang/OTP; **not run inside a real EMQX broker**.

### Fixed

- **Every setting was silently ignored.** 2.0.0 read each key with `emqx_conf:get([aforo_metering, Key], Default)`. `emqx_conf` holds EMQX's own config tree, which has no `aforo_metering` root, so every call returned its default: usage went out as `tenant_default` / `prod_mqtt_default` with an empty API key, whatever the operator configured. The plugin now reads its config the way EMQX plugins do: `emqx_plugin_helper:get_config(<<"aforo_metering-2.0.1">>)`, which calls `emqx_plugins:get_config/1` and accepts both its return shapes (`{ok, Map}` before EMQX 5.9, `Map` from 5.9). If EMQX cannot return the config, the plugin logs `aforo_metering could not read its plugin config` and refuses to start.
- **The package could not be installed.** 2.0.0 built a plain relx tarball (`rebar3 tar`) with no `release.json`, which `emqx ctl plugins install` needs. The build now follows the official EMQX plugin template: `rebar3 emqx_plugrel tar` → `_build/default/emqx_plugrel/aforo_metering-2.0.1.tar.gz` with `release.json` (compatibility `emqx ~> 5.7`), `README.md` and the apps `aforo_metering`, `emqx_plugin_helper` and `jsone`. The EMQX headers come from `emqx_plugin_helper`, so building no longer needs an EMQX source tree; `emqx` is no longer listed as an application dependency (it is the host, not something the package can carry).
- **`${AFORO_API_KEY}` was never substituted.** EMQX does not resolve environment variables in plugin config; the shipped sample sent the literal text as the key. The plugin now refuses `${…}` values with a message saying where to set the key.

### Added

- `priv/config.hocon` (the defaults EMQX installs) and `priv/config_schema.avsc` (Avro schema: every setting with type and default; `tenant_id`, `product_id`, `api_key`, `ingestor_url` required; `api_key` and `customer_resolver_http_authorization` declared as password inputs). EMQX checks every change against the schema; the build checks the defaults against it.
- `on_config_changed/2` on `aforo_metering_app` (EMQX 5.8+): a config change made through the Dashboard or `PUT /api/v5/plugins/aforo_metering-2.0.1/config` is validated and applied to the running plugin with nothing queued dropped — key/URL/TLS/timeouts on the next request (a paused delivery is retried at once, keeping the idempotency keys), batch size, interval and queue size in the flusher (a smaller queue is reached by sending, not evicting), aggregation settings and `exclude_topics` (a new window length or topic dimension sends the open windows at once as partial windows), resolver pool size. Refused: anything `validate` refuses, and a change of `tenant_id` / `product_id` while running. On 5.9+ a refused change is not saved; 5.8 saves it regardless (the running plugin keeps its config and logs the reason); 5.7 has no callback — restart the plugin.
- `on_health_check/1` (EMQX 5.9+): reports a missing CA bundle and a paused delivery.
- Startup refuses an empty or placeholder `tenant_id` (`tenant_default`), `product_id` (`prod_mqtt_default`), `api_key` (empty, `${…}`, `sk_live_...`) and an empty `ingestor_url`, and names unknown config keys in a warning. The config is logged at start with secrets masked.

### Changed

- **The config is top-level keys**, not an `aforo_metering { ... }` block (a wrapped config is refused with a message). It lives in `$EMQX_DATA_DIR/plugins/aforo_metering/config.hocon` and is changed through the Dashboard or REST API, not by editing a file in the release.
- `exclude_topics` and the aggregation settings can change at runtime (were read at start only).
- `emqx ctl plugins install` takes the name-version (`aforo_metering-2.0.1`) of a package in the plugin directory, not a file path; the README and user guide were wrong about this.
- `sdkVersion` in event metadata and the User-Agent are `2.0.1`. Licence in `aforo_metering.app.src` corrected to Apache-2.0 (it said MIT; the repository is Apache-2.0).

### Upgrading from 2.0.0

Install the 2.0.1 package, then set `tenant_id`, `product_id` and `api_key` (and anything you changed in 2.0.0's `aforo_metering.hocon`) through the Dashboard or REST API, as top-level keys. Your 2.0.0 settings were never in effect, so check what 2.0.0 sent before trusting its usage history: it went out under `tenant_default` with an empty key, which the ingestor refuses, so expect none to have been accepted.

## [2.0.0] — 2026-10-27

**Breaking.** Changes the default customer source, the usage-event shape (per-minute totals) and the TLS behaviour, and removes config keys. Read "Upgrading to 2.0.0" below before installing. Wave 6 package W6.6 (gaps G363–G368). Tested on plain Erlang/OTP against stand-ins for the EMQX headers and against the Aforo mock ingestor; **not run inside a real EMQX broker**.

### Fixed

- **Every event crashed before it was buffered (0.1.0).** The metric name was built as `<<"mqtt_broker.", (string:to_lower(...))/binary>>`; `string:to_lower/1` on a list returns a list, so `do_buffer_event` raised `badarg` on every hook call and no usage was ever recorded. The plugin also never compiled with `rebar3 compile`: `aforo_metering.app.src` sat at the repository root instead of `src/`, so rebar3 did not see the application, and the eunit suites failed with `undef` (26 tests, 13 failures, 13 cancelled).
- **A client could bill its traffic to another customer (G363).** The default resolver read the MQTT username, which the client chooses, and the `jwt` resolver decoded tokens without checking their signature. The default is now `client_attrs`: the customer comes from a client attribute EMQX authentication set (a `client_attrs` claim in a JWT that EMQX verified, or the HTTP authenticator's response; EMQX 5.7.0+). `username`, `clientid_prefix` and `jwt_unverified` (the old `jwt`) still exist but the plugin refuses to start with them unless `unsafe_trust_client_identity = true`. An unknown resolver name no longer falls back to the username; it stops the plugin from starting.
- **The http resolver blocked the client for up to 5 s and never cached a miss (G364).** Lookups now run in `aforo_metering_resolver_pool`: a bounded queue (`customer_resolver_http_queue_size`), at most `customer_resolver_http_workers` in flight, a `customer_resolver_http_timeout_ms` deadline each. Hooks return at once; usage recorded meanwhile is held under the client id and attributed when the answer arrives. "No customer" and failed lookups are cached for `customer_resolver_negative_ttl_seconds`. A slower answer for an older connection never overwrites a newer lookup. The Aforo API key is no longer sent to the mapping service (it was sent as `Authorization: Bearer`); set `customer_resolver_http_authorization` if the service needs a credential.
- **The retention cap dropped events from concurrent publishers (G365).** Each publishing process drained and re-inserted the whole buffer when it hit the cap, and dropped half of it each time. The queue is now owned by one process (`aforo_metering_flusher`); hooks only bump counters (`ets:update_counter/4`) and never touch the queue. Overflow evicts only the oldest events beyond `max_buffer_size`, and counts them.
- **A flush process was spawned per event above `flush_count`, and timer flushes overlapped (G366).** There is one flusher with exactly one request in flight.
- **TLS certificates were not verified (G367).** Every https request now uses `verify_peer` with the OS trust store (`public_key:cacerts_get/0`) or `ca_cert_file`, hostname checking and SNI. `http://` is refused except for localhost / 127.0.0.1 / ::1 unless `allow_insecure_http = true`. Redirects are never followed. Requests use a dedicated httpc profile.
- **One usage event per PUBLISH / DELIVER (G368).** Broker events are now counted per (customer, metric, QoS, retain[, topic]) per `aggregation_window_seconds` (default 60) and sent as one usage event with `quantity` = message count and `dataBytes` = summed payload. The idempotency key is a SHA-256 of tenant, product, broker node, plugin incarnation, window, owner, metric, topic and an emission number; it is fixed when the event is built and reused on every re-send (Rule #21). Set `aggregation_window_seconds = 0` for one event per broker event.
- **Events without a topic were rejected by the ingestor.** CONNECT / DISCONNECT events were sent with `mqttTopic = ""`, which the `MQTT_BROKER` descriptor requires to be non-blank. Events without a topic dimension now carry `"#"`. Topics are cut to 500 bytes (the DTO limit) at a UTF-8 boundary.

### Changed

- Delivery follows `aforo-metering-sdks/contract/TRANSPORT-SPEC.md`: full-jitter backoff (500 ms base, 30 s cap), `Retry-After` in both forms (capped at 60 s), every 5xx retried, 401/403/3xx treated as outages (requeue, logged once per pause) instead of dropping the batch, 413 halves the batch, per-event `retryable` errors in a 2xx re-sent, failed batches re-queued at the front with the same keys, breaker pause `max(250 ms, random(0, min(5 min, 5 s · 2ⁿ)))`.
- Plugin stop (`prep_stop/1`) unhooks, closes every open window and sends within `shutdown_timeout_ms`; each send is cut off at the deadline even if the HTTP client does not honour its own timeout. Leftovers are counted as dropped.
- Closing windows takes only as many as the queue has room for (counting the batch in flight); the rest wait in the counter table, so a slow ingestor never evicts freshly closed usage.
- The ETS tables (customer cache, aggregation counters) are owned by `aforo_metering_sup`, so a crash of the resolver pool or the flusher loses neither the resolved customers nor the open windows; the flusher counts the queued events it loses on an abnormal stop.
- Customer-cache rows record which connection they belong to: after a session takeover, the old channel's disconnect no longer expires the new session's entry. Within one connection a re-lookup keeps using the customer already resolved until the new answer arrives (a lookup the queue refuses keeps it too); a new connection never inherits the previous connection's customer.
- The http resolver sends `clientAttrs` (what EMQX authentication set) with `clientId` and `username`, and is retried after the negative TTL from `message.publish` too. A pending lookup lasts `customer_resolver_pending_max_seconds`. Lookups that overrun their deadline are killed.
- `exclude_topics` is now read (MQTT filters with `+` and `#`; read at start).
- For IP-literal hosts no SNI is sent; the certificate is still checked against the IP (iPAddress SAN).
- The configuration is validated at start (`aforo_metering_config:validate/0`); a bad setting stops the plugin with each reason logged.
- Hooks catch their own failures, so metering can never break message delivery.
- New counters: `aforo.metering.events.rejected`, `aforo.metering.events.unresolved`, `aforo.metering.aggregation.keys_dropped`, `aforo.metering.customer_lookup.negative`, `aforo.metering.resolver.dropped`. `health/0` adds `open_aggregation_keys`. `flush_now/0` returns after one send attempt.
- `metadata.sdkVersion` is now `2.0.0`; `rebar.config` release and `vsn` are both `2.0.0`.
- The eunit suites build without EMQX (`test` profile defines `AFORO_NO_EMQX`, using `include/aforo_metering_emqx.hrl`). 142 tests, including delivery tests against the Node mock ingestor and real TLS handshakes.

### Removed

- `aforo_metering_buffer` (the two-table ETS swap buffer) — replaced by the aggregator and the flusher's queue.
- Config keys `circuit_failure_threshold` and `circuit_cooldown_seconds` (ignored if present).
- `customer_resolver = "jwt"` (use EMQX JWT authentication with `client_attrs`, or `jwt_unverified` + `unsafe_trust_client_identity`).

### Upgrading to 2.0.0

1. **Identity.** Make EMQX authentication set the customer attribute (default name `aforo_customer_id`): a `client_attrs` claim in the JWTs your JWT authenticator verifies, or `client_attrs` in your HTTP authenticator's success response. Requires EMQX 5.7.0+. If you relied on the username and your broker authentication really does tie each username to one customer, set `customer_resolver = "username"` and `unsafe_trust_client_identity = true` instead. `customer_resolver = "jwt"` must change.
2. **Billable units.** Usage events now carry per-minute totals. In Aforo, every billable unit on an `mqtt_broker.*` metric must aggregate with **SUM** on quantity; a COUNT unit would bill one per window. To keep one event per message, set `aggregation_window_seconds = 0`.
3. **TLS.** Make sure the broker node trusts the ingestor's certificate (OS trust store, or `ca_cert_file`). Replace any `http://` ingestor or resolver URL with `https://`, or set `allow_insecure_http = true` deliberately.
4. **http resolver.** The mapping service no longer receives the Aforo API key. If it needs a credential, set `customer_resolver_http_authorization`.
5. Remove `circuit_failure_threshold` / `circuit_cooldown_seconds` from your config (they are ignored).
6. Build against EMQX's headers (`ERL_LIBS` pointing at an EMQX build), install `aforo_metering-2.0.0.tar.gz`, start it, and check the log for `aforo_metering plugin loaded` (or `refused to start` with the reason).

## [0.1.0] — 2026-06-29

Initial public distribution packaging — README, user guide, and versioning. **Experimental.**

The Erlang/rebar3 plugin scaffold covers the working metering path on EMQX 5.x:

- Six EMQX 5.x hooks (`client.connected`, `client.disconnected`, `message.publish`, `message.delivered`, `session.subscribed`, `session.unsubscribed`) at `?HP_LOWEST`, emitting `mqtt_broker.*` events.
- Two-table ETS swap buffer with timer/count-based flushing and 3× exponential-backoff retry to the Aforo ingestor.
- Retention cap (`max_buffer_size`, oldest-50%-drop) and a `persistent_term` circuit breaker to bound memory and skip POSTs under a sustained ingestor outage.
- Pluggable customer-ID resolver (`username` / `clientid_prefix` / `jwt` / `http`), cached per `(tenant, clientid)`.
- Prometheus counters via `emqx_metrics` and an `aforo_metering:health/0` status map.

This release sets the application `vsn` to `0.1.0` to reflect pre-production status; the in-code `?SDK_VERSION` event-contract string and the `rebar.config` release-tarball version are independent and unchanged. Source logic was not modified.
