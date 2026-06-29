# EMQ X Plugin — Production Hardening Checklist

Status after Session 3:
- ✅ All 5 hook callbacks implemented (`client.connected`, `client.disconnected`, `message.publish`, `message.delivered`, `session.subscribed`, `session.unsubscribed`)
- ✅ ETS buffer + timer-based flush with 3× exponential retry
- ✅ `aforo_metering_metrics` module — 6 counters wired through `emqx_metrics` (scrapeable via `/api/v5/prometheus/stats`)
- ✅ Hocon config with env-var substitution
- ✅ OTP supervision tree + app/sup modules
- ✅ System-topic exclusion (`$SYS/#`, `$share/#`)

Remaining before production deploy:

## ✅ 1. ETS Retention Policy — LANDED Session 4

`enforce_retention_cap/0` runs before every insert. When the buffer hits `max_buffer_size` (default 50_000), the oldest 50% of events are dropped and counted via `aforo.metering.events.dropped`. Drop events are logged at most once per minute to avoid log spam.

Config: `max_buffer_size` in `aforo_metering.hocon`.

## ✅ 2. Backpressure / Circuit Breaker — LANDED Session 4

`persistent_term`-backed circuit breaker around `ship_to_ingestor/1`. After `circuit_failure_threshold` consecutive failures (default 5), the circuit opens for `circuit_cooldown_seconds` (default 60). When open, flushes skip the POST and re-buffer events (subject to the retention cap from item 1). After cooldown the circuit moves to `half_open`; one probe attempt closes (on success) or reopens (on failure) the circuit.

Config: `circuit_failure_threshold` and `circuit_cooldown_seconds` in `aforo_metering.hocon`.

> Future: add `aforo.metering.circuit.state` gauge (0=closed, 1=open, 2=half-open). Currently only the `flush.error` counter increments on circuit-open events.

## 3. Customer-ID Cache

Current behavior: `aforo_customer_id/2` reads from `ClientInfo` each time. If the customer-ID resolution requires a lookup (DB, auth service), the hook runs on every message.

**Hardening path:**
- Add an ETS cache keyed by `{tenant, clientid}` → `customer_id`.
- Populate on `client.connected`, invalidate on `client.disconnected`.
- Fall back to full lookup on cache miss.
- Add `aforo.metering.customer_lookup.hit` / `.miss` counters.

✅ **LANDED Session 5** — see `aforo_metering_cache.erl`. Public-set ETS table with `read_concurrency` + `write_concurrency`. Populated on first lookup, invalidated on `client.disconnected`. Both counters wired through `aforo_metering_metrics`.

## ✅ 4. Customer-ID Resolution Options — LANDED Session 5

`aforo_metering_customer_resolver.erl` provides 4 pluggable backends, selected via `aforo_metering.customer_resolver`:
- `username` — MQTT CONNECT username (default; matches pre-Session-5 behaviour)
- `clientid_prefix` — parse `cust_<id>_<rest>` from clientid (separator configurable)
- `jwt` — decode the JWT in CONNECT v5's Authentication Data property; reads the `sub` claim by default
- `http` — POST `{clientId, username, tenantId}` to an auth-service URL; expects `{"customerId": "..."}` back

All backends wrapped by `aforo_metering_cache` so heavy paths (JWT decode, HTTP call) run at most once per (tenant, clientid).

> Future: lookup table loaded from S3/file on plugin start (case currently subsumed by the `http` backend pointing at a static endpoint).

## ✅ 5. Concurrent Safety — LANDED Session 5

Two-table swap implemented in `aforo_metering_buffer.erl`. Two ETS `ordered_set` tables (`A` and `B`) with the active-table pointer held in `persistent_term`. Hot-path writers always insert into the active table. `swap_and_drain/0` atomically swaps the pointer, then drains the now-inactive table without contending with writers.

Eliminates the race window in the previous single-table design where `ets:foldl` + `ets:delete` could miss rows inserted between the two operations.

## 6. Load Test

**Hardening path:**
- 10K msg/sec sustained, 100K msg/sec peak (per broker node)
- Verify flush latency < 500ms p95 under load
- Verify no event loss at sustained 50% of peak
- Verify ETS memory growth is bounded under failure

> Status: not yet executed — needs an EMQ X dev environment + a load generator (mqtt-bench, mzbench, or k6 with the kawaii-mqtt extension).

## ✅ 7. Observability — LANDED Session 5 (partial)

- [x] Prometheus counters via `emqx_metrics` (Session 3)
- [x] **Customer-lookup hit/miss counters** (Session 5)
- [x] **Circuit-state gauge** `aforo.metering.circuit.state` (0=closed, 1=half_open, 2=open) (Session 5)
- [x] **Structured logs** with `tenant_id`, `product_id`, and config snapshot at plugin load. Buffer-cap-reached and circuit-open events log a structured map (Session 5)
- [x] **Health-check function** `aforo_metering:health/0` returns a status map suitable for a dashboard plugin endpoint (buffer depth, cache size, circuit state, full counter snapshot) (Session 5)
- [ ] HTTP endpoint that exposes `health/0` — requires an EMQ X dashboard plugin module (separate from the metering plugin itself); deferred to release engineering
- [ ] Alerts: circuit-open > 5 min, dropped > 1000/hour, buffer > 80% capacity — defined as Prometheus rules in the operator's monitoring stack, not in the plugin

## 8. Release Engineering

- [ ] CI pipeline: rebar3 compile + eunit + ct on every push
- [ ] Release tarball signing (GPG)
- [ ] Publish to EMQ X marketplace (or internal registry)
- [ ] Upgrade path: support online upgrade from 1.0.0 → 1.x (`code_change/3`)

---

The plugin is now production-ready for a proof-of-concept deployment. Items 6 (load test) and 8 (release engineering) are infrastructure work that requires an EMQ X dev environment and a CI pipeline, respectively.
