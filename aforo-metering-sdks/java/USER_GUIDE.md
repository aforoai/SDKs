# ai.aforo:metering — User Guide

**Version:** 1.1.2 · **Updated:** 2026-10-01 · **Audience:** Java backend engineers wiring usage metering into a service (plain Java or Spring Boot 3.x).

## What you'll build

A Java service that emits one Aforo usage event per billable action and ships those events in batches to `https://api.aforo.ai/v1/ingest/batch`. By the end you'll have a metered event confirmed as landed in Aforo.

## Prerequisites

- JDK 17 or newer (the SDK uses `java.net.http.HttpClient` and records).
- An Aforo API key (`AFORO_API_KEY`) for the environment you're metering into. Tenancy is keyed by this API key — there is no separate `tenant_id` field in this SDK.
- A metric (billable unit) defined in Aforo whose name matches the `metricName` you'll send (e.g. `api_calls`). The platform rejects unknown metric names.
- For the Spring path: a Spring Boot 3.2+ app on a servlet stack.

## Step 1 — Build the SDK into your local Maven repo

Not yet on Maven Central, so install from source once:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/java
mvn clean install
```

Then add the dependency to your service's `pom.xml`:

```xml
<dependency>
  <groupId>ai.aforo</groupId>
  <artifactId>metering</artifactId>
  <version>1.1.2</version>
</dependency>
```

## Step 2 — Export your credentials

```bash
export AFORO_API_KEY="sk_live_xxxxxxxxxxxxxxxxxxxx"
```

> ⚠ Don't hard-code the key. The SDK reads it from `AforoOptions` (manual) or `aforo.api-key` (Spring) — wire both from the environment, not from source.

## Step 3 — Send your first event by hand

Use try-with-resources so the buffer flushes when the block exits:

```java
import com.aforo.metering.AforoClient;
import com.aforo.metering.AforoOptions;
import com.aforo.metering.TrackEvent;
import java.util.Map;

public class Demo {
    public static void main(String[] args) {
        try (AforoClient client = new AforoClient(new AforoOptions(System.getenv("AFORO_API_KEY")))) {
            client.track(TrackEvent.builder("cust_acme_001", "api_calls")
                    .quantity(1)
                    .metadata(Map.of("route", "POST /v1/charges", "region", "us-east-1"))
                    .build());
            // close() (end of try block) force-flushes synchronously
        }
    }
}
```

`track(...)` is non-blocking — it enqueues and returns. The event ships on the next 5-second flush, on reaching 50 buffered events, or when `close()` runs. The first two builder args are required (`customerId`, `metricName`); `quantity` defaults to `1` and must be `> 0`. Every event carries a top-level `productType`: the client default (`API`, or `AforoOptions.productType(...)`) unless you override it per event with `.productType("AI_AGENT")`. An event the ingestor would refuse — blank `customerId`/`metricName`, `quantity <= 0`, or a field over its length limit — is not sent: `track(...)` does not throw; the event is counted in `client.droppedCount()`, logged, and passed to the `onDrop` hook with `DropReason.INVALID`. Add `.executionStatus("SUCCESS")` (or another of the 11 accepted statuses) when the metric is priced by outcome. Both are described in the [README](README.md#dropped-events).

> **Idempotency keys.** If you don't pass an `idempotencyKey`, the SDK mints a fresh random UUID v4 per event, so two genuinely distinct events are never confused — even when they share customer, metric, quantity and `occurredAt`. (It used to derive the key by hashing those four fields, so two identical events in the same millisecond collapsed into one and the second was silently dropped.) The key is minted once, when `track(...)` enqueues the event, and never changes, so a retried batch is still deduplicated. **If you want dedup — e.g. an at-least-once pipeline replaying the same logical event — pass your own `.idempotencyKey(...)`;** that value is sent verbatim and is the only thing the ingestor dedupes on.

## Step 4 — (Spring Boot) meter every request automatically

Add the same dependency, then set the properties:

```yaml
# application.yml
aforo:
  enabled: true                 # MUST be exactly "true" — auto-config is off otherwise
  api-key: ${AFORO_API_KEY}
  base-url: https://api.aforo.ai
  product-type: API             # default; e.g. AGENTIC_API
```

That's the whole wiring. `AforoMeteringAutoConfiguration` registers:

- an `AforoClient` bean, and
- `AforoServletFilter` mapped to `/*` at `order = Integer.MAX_VALUE` (runs last).

The filter records one event per request **after** `filterChain.doFilter(...)` returns:

- `metricName` = `aforo.metric-name` (default `api_calls`), or whatever an `AforoServletFilter.MetricNameResolver` bean returns for the request. The metric must exist in your tenant's Aforo catalog: the ingestor rejects events for an unknown metric, and they are dropped with reason `REJECTED`. (Earlier versions sent `"<METHOD> <normalized-path>"`, which no catalog contains.)
- `quantity` = `1`, `metadata` = `{"gateway":"java-servlet","status":<httpStatus>}`, plus top-level `endpointPath` (matched route pattern, else the normalized path; no query string; at most 512 chars), `httpMethod`, `statusCode`, `responseTimeMs`, and `productType` (`AforoServletFilter.productType(...)`, else `aforo.product-type`, default `API`).
- These paths are skipped by default: `/health`, `/ready`, `/metrics`, `/favicon.ico`, `/actuator`. `OPTIONS` (CORS preflight) requests are never metered.

> ⚠ The filter resolves the customer in this order: an `AforoServletFilter.CustomerIdResolver` bean if you declared one; otherwise the Spring Security principal (only when `aforo.use-principal-as-customer-id: true`) → the `aforo.customer-id-header` header (default `X-Customer-Id`). The caller's `X-Api-Key` is never used — it is a secret, not a customer id. If none resolves, the request is **not** metered (so health checks and unauthenticated probes stay silent).

## Step 5 — Force a flush and verify it landed

In the manual path, call `flush()` to send synchronously and inspect the result:

```java
import com.aforo.metering.FlushResult;

FlushResult result = client.flush();
System.out.println("sent=" + result.sent() + " failed=" + result.failed());
System.out.println("stillBuffered=" + client.bufferedCount());
```

A `sent` count equal to what you tracked and `failed == 0` means the ingestor returned 2xx. Then confirm on the Aforo side:

- Open the Aforo console → **Ingestion → Recent Events** and filter by your `customerId` (`cust_acme_001`) and `metricName` (`api_calls`). Your event appears within a few seconds of the flush.

To watch the wire during local debugging, point `base-url` / `baseUrl` at a request inspector and confirm the body is `{"events":[{"customerId":...,"metricName":...,"quantity":...,"idempotencyKey":...,"occurredAt":...,"productType":"API"}]}` with `X-API-Key: <key>`.

## Configuration reference

| Option (manual) | Spring property | Type | Default | What it does |
|---|---|---|---|---|
| `apiKey` (ctor) | `aforo.api-key` | `String` | *(required)* | Aforo API key, sent as `X-API-Key`. |
| `baseUrl(...)` | `aforo.base-url` | `String` | `https://api.aforo.ai` | Ingestion host; SDK appends `/v1/ingest/batch`. |
| `productType(...)` | `aforo.product-type` | `String` | `API` | Top-level `productType` on every event; per-event `TrackEvent.Builder.productType(...)` wins. |
| `flushCount(...)` | `aforo.flush-count` | `int` | `50` | Buffer size that triggers an immediate flush; clamped to 1–1000 per batch. |
| `flushIntervalMs(...)` | `aforo.flush-interval-ms` | `long` | `5000` | Background flush cadence (ms). |
| `maxQueueSize(...)` | — | `int` | `10000` | Ring-buffer capacity; the oldest event is evicted (and reported as `OVERFLOW`) when full. |
| `onDrop(...)` | — | `BiConsumer<List<ResolvedEvent>, DropReason>` | *(none)* | Receives events the SDK is about to lose (`OVERFLOW`, `RETRY_EXHAUSTED`, `REJECTED`, `INVALID`). |
| `maxRetries(...)` | — | `int` | `3` | Retries per batch on 5xx / 408 / 429. |
| `retryBaseMs(...)` | — | `long` | `1000` | Base backoff (ms), doubles per attempt; `429` honors `Retry-After`. |
| `timeoutMs(...)` | — | `long` | `10000` | HTTP connect timeout (ms). |
| `aforo.enabled` | `aforo.enabled` | — | *(unset → off)* | Spring auto-config activates only when `true`. |
| `metricName(...)` / `metricNameResolver(...)` on `AforoServletFilter` | `aforo.metric-name` | `String` | `api_calls` | Metric per request; must exist in your Aforo catalog. |
| `customerIdHeader(...)` / `customerIdResolver(...)` | `aforo.customer-id-header` | `String` | `X-Customer-Id` | Where the customer id comes from. |
| `usePrincipalAsCustomerId(...)` | `aforo.use-principal-as-customer-id` | `boolean` | `false` | Use the principal's name as the customer id. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Spring auto-config does nothing | `aforo.enabled` is unset or not the literal `true` | Set `aforo.enabled: true`. It's gated by `@ConditionalOnProperty(havingValue = "true")`. |
| `IllegalArgumentException: apiKey is required` at startup | `AFORO_API_KEY` is empty / not exported | Export the env var and confirm it reaches `aforo.api-key` / `AforoOptions`. |
| `flush()` returns `failed > 0` | The ingestor returned a non-2xx, or a 2xx that refused some events in `errors[]`. 4xx (except 408/429) is **not** retried — usually a bad/expired key or an unknown `metricName` | Check the key; create the metric in Aforo so its name matches `metricName`. The `WARNING` log line carries the status code and the ingestor's `errors[].message`; an `onDrop` hook receives the affected events. |
| `droppedCount()` grows but nothing is sent | Events are failing client-side validation (`DropReason.INVALID`) | Read the `Dropping invalid event: ...` warning — it names the field, the limit and the value. |
| Events tracked but never appear in Aforo | Process exited before a flush, or the customer resolved to `null` in the filter | Use try-with-resources / `close()`; ensure `X-Customer-Id` (or your resolver / opted-in principal) is present so the filter doesn't skip the request. |
| `IllegalStateException: AforoClient is closed` | `track(...)` called after `close()` | Don't reuse a closed client; build a new `AforoClient` (or keep the Spring-managed bean for the app lifetime). |
| Health checks show up as metered traffic | A custom filter path or non-default excludes | The default excludes are `/health /ready /metrics /favicon.ico /actuator`. Construct `AforoServletFilter(client, yourExcludeList)` directly if you need different ones. |

## What this guide does NOT cover

- **Custom servlet exclude lists via properties.** The auto-config registers the filter on `/*` with the built-in exclude list. To change excludes, register `AforoServletFilter(client, excludePaths)` as your own bean.
- **Non-servlet stacks (WebFlux).** The filter is servlet-only. On reactive stacks, call `AforoClient.track(...)` from your handlers.
- **Querying or rating usage.** This SDK writes events only. Usage retrieval, rating, and invoicing live in the Aforo platform.
