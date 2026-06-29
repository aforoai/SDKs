# com.aforo:metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Java backend engineers wiring usage metering into a service (plain Java or Spring Boot 3.x).

## What you'll build

A Java service that emits one Aforo usage event per billable action and ships those events in batches to `https://ingest.aforo.ai/v1/ingest/batch`. By the end you'll have a metered event confirmed as landed in Aforo.

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
  <groupId>com.aforo</groupId>
  <artifactId>metering</artifactId>
  <version>1.0.0</version>
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

`track(...)` is non-blocking — it enqueues and returns. The event ships on the next 5-second flush, on reaching 50 buffered events, or when `close()` runs. The first two builder args are required (`customerId`, `metricName`); `quantity` defaults to `1`.

> ⚠ If you don't pass an `idempotencyKey`, the SDK derives a deterministic one from `customerId + metricName + quantity + occurredAt`. Two identical events generated in the same millisecond collapse to one. Pass an explicit `.idempotencyKey(...)` if you need to keep distinct same-instant events apart.

## Step 4 — (Spring Boot) meter every request automatically

Add the same dependency, then set the properties:

```yaml
# application.yml
aforo:
  enabled: true                 # MUST be exactly "true" — auto-config is off otherwise
  api-key: ${AFORO_API_KEY}
  base-url: https://ingest.aforo.ai
```

That's the whole wiring. `AforoMeteringAutoConfiguration` registers:

- an `AforoClient` bean, and
- `AforoServletFilter` mapped to `/*` at `order = Integer.MAX_VALUE` (runs last).

The filter records one event per request **after** `filterChain.doFilter(...)` returns:

- `metricName` = `"<METHOD> <normalized-path>"`, e.g. `GET /users/:id`. Path normalization replaces UUIDs, numeric ids, Mongo ObjectIds, and mixed alphanumeric ids with `:id`. When Spring MVC's matched route pattern is on the request, the SDK uses that instead of the heuristic.
- `quantity` = `1`, `metadata` = `{"gateway":"java-servlet","status":<httpStatus>}`.
- These paths are skipped by default: `/health`, `/ready`, `/metrics`, `/favicon.ico`, `/actuator`.

> ⚠ The filter resolves the customer in this order: Spring Security principal → `X-Customer-Id` header → `X-Api-Key` header. If none resolves, the request is **not** metered (so health checks and unauthenticated probes stay silent). Make sure your auth populates the principal, or your gateway sets `X-Customer-Id`.

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

To watch the wire during local debugging, point `base-url` / `baseUrl` at a request inspector and confirm the body is `{"events":[{"customerId":...,"metricName":...,"quantity":...,"idempotencyKey":...,"occurredAt":...}]}` with `Authorization: Bearer <key>`.

## Configuration reference

| Option (manual) | Spring property | Type | Default | What it does |
|---|---|---|---|---|
| `apiKey` (ctor) | `aforo.api-key` | `String` | *(required)* | Bearer token. |
| `baseUrl(...)` | `aforo.base-url` | `String` | `https://ingest.aforo.ai` | Ingestion host; SDK appends `/v1/ingest/batch`. |
| `flushCount(...)` | `aforo.flush-count` | `int` | `50` | Buffer size that triggers an immediate flush. |
| `flushIntervalMs(...)` | `aforo.flush-interval-ms` | `long` | `5000` | Background flush cadence (ms). |
| `maxQueueSize(...)` | — | `int` | `10000` | Ring-buffer capacity; oldest events overwritten when full. |
| `maxRetries(...)` | — | `int` | `3` | Retries per batch on 5xx / 408 / 429. |
| `retryBaseMs(...)` | — | `long` | `1000` | Base backoff (ms), doubles per attempt; `429` honors `Retry-After`. |
| `timeoutMs(...)` | — | `long` | `10000` | HTTP connect timeout (ms). |
| `aforo.enabled` | `aforo.enabled` | — | *(unset → off)* | Spring auto-config activates only when `true`. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Spring auto-config does nothing | `aforo.enabled` is unset or not the literal `true` | Set `aforo.enabled: true`. It's gated by `@ConditionalOnProperty(havingValue = "true")`. |
| `IllegalArgumentException: apiKey is required` at startup | `AFORO_API_KEY` is empty / not exported | Export the env var and confirm it reaches `aforo.api-key` / `AforoOptions`. |
| `flush()` returns `failed > 0` | Ingestor returned a non-2xx. 4xx (except 408/429) is **not** retried — usually a bad/expired key or an unknown `metricName` | Check the key; create the metric in Aforo so its name matches `metricName`; check service logs at `FINE` for the status code. |
| Events tracked but never appear in Aforo | Process exited before a flush, or the customer resolved to `null` in the filter | Use try-with-resources / `close()`; ensure the principal or `X-Customer-Id` is present so the filter doesn't skip the request. |
| `IllegalStateException: AforoClient is closed` | `track(...)` called after `close()` | Don't reuse a closed client; build a new `AforoClient` (or keep the Spring-managed bean for the app lifetime). |
| Health checks show up as metered traffic | A custom filter path or non-default excludes | The default excludes are `/health /ready /metrics /favicon.ico /actuator`. Construct `AforoServletFilter(client, yourExcludeList)` directly if you need different ones. |

## What this guide does NOT cover

- **Custom servlet exclude lists via properties.** The auto-config registers the filter on `/*` with the built-in exclude list. To change excludes, register `AforoServletFilter(client, excludePaths)` as your own bean.
- **Non-servlet stacks (WebFlux).** The filter is servlet-only. On reactive stacks, call `AforoClient.track(...)` from your handlers.
- **Querying or rating usage.** This SDK writes events only. Usage retrieval, rating, and invoicing live in the Aforo platform.
