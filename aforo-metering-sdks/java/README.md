# com.aforo:metering

Track API usage from any Java service and let Aforo handle batching, retry, and delivery. Drop in a Spring Boot servlet filter to meter every request automatically, or call `AforoClient.track(...)` by hand when you decide what counts.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended (once published to Maven Central):

```xml
<dependency>
  <groupId>com.aforo</groupId>
  <artifactId>metering</artifactId>
  <version>1.0.0</version>
</dependency>
```

**Not yet on Maven Central — build from source for now.** Clone the SDK repo and install the artifact into your local `~/.m2`:

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/java
mvn clean install
```

After `mvn install`, the `<dependency>` snippet above resolves from your local `~/.m2`. Java 17+ is required (the SDK uses `java.net.http.HttpClient` and records).

Two host-supplied dependencies are `provided`-scope — you bring your own versions:

| Dependency | When you need it |
|---|---|
| `jakarta.servlet:jakarta.servlet-api` 6.0+ | Only if you use `AforoServletFilter` (your servlet container supplies it at runtime) |
| `org.springframework.boot:spring-boot-autoconfigure` 3.2+ | Only if you use the Spring Boot auto-configuration |

The plain `AforoClient` path needs neither — just Jackson, which is bundled.

## Quickstart

Manual tracking with try-with-resources — `AforoClient` is `AutoCloseable`, so the buffer flushes on close:

```java
import com.aforo.metering.AforoClient;
import com.aforo.metering.AforoOptions;
import com.aforo.metering.TrackEvent;

try (AforoClient client = new AforoClient(new AforoOptions(System.getenv("AFORO_API_KEY")))) {
    client.track(TrackEvent.builder("cust_acme_001", "api_calls")
            .quantity(1)
            .metadata(java.util.Map.of("route", "POST /v1/charges"))
            .build());
}
```

`track(...)` returns immediately — it pushes onto an in-memory ring buffer that a daemon thread flushes to `https://ingest.aforo.ai/v1/ingest/batch` every 5 seconds, or sooner once 50 events are queued. The constructor also registers a JVM shutdown hook, so events aren't lost if the process exits without an explicit `close()`.

Spring Boot — add the dependency and set two properties; the auto-configuration wires an `AforoClient` bean and a request-end servlet filter:

```yaml
# application.yml
aforo:
  enabled: true          # auto-config is off unless this is exactly "true"
  api-key: ${AFORO_API_KEY}
  base-url: https://ingest.aforo.ai
```

The filter runs **after** the response is committed, so metering adds no latency to the API call. It resolves the customer from (in order) the Spring Security principal, then the `X-Customer-Id` header, then `X-Api-Key`; requests with none of those are skipped.

> ⚠ The customer id comes from the authenticated principal or a server-trusted header — not from request body fields a client controls. Tenancy is determined by your `api-key`; there is no separate `tenant_id` config field in this SDK.

## Configuration

`AforoOptions` (manual path) — constructor takes the API key; everything else is a fluent setter:

| Option | Type | Default | What it does |
|---|---|---|---|
| `apiKey` | `String` | *(required)* | Bearer token sent as `Authorization: Bearer <apiKey>`. Blank throws `IllegalArgumentException`. |
| `baseUrl(...)` | `String` | `https://ingest.aforo.ai` | Ingestion host. The SDK appends `/v1/ingest/batch`. Override per environment. |
| `flushCount(...)` | `int` | `50` | Buffered events that trigger an immediate async flush. |
| `flushIntervalMs(...)` | `long` | `5000` | Background flush cadence in ms. |
| `maxQueueSize(...)` | `int` | `10000` | Ring-buffer capacity. Oldest events are overwritten when full. |
| `maxRetries(...)` | `int` | `3` | Retry attempts per batch on 5xx / 408 / 429. |
| `retryBaseMs(...)` | `long` | `1000` | Base backoff in ms; doubles per attempt. A `429` honors `Retry-After` when present. |
| `timeoutMs(...)` | `long` | `10000` | HTTP connect timeout in ms. |
| `shutdownTimeoutMs(...)` | `long` | `5000` | Reserved for shutdown wait tuning. |

Spring Boot properties (prefix `aforo`) — a subset of the above:

| Property | Default | What it does |
|---|---|---|
| `aforo.enabled` | *(unset → off)* | Auto-config activates only when set to `true`. |
| `aforo.api-key` | *(required)* | Bearer token. |
| `aforo.base-url` | `https://ingest.aforo.ai` | Ingestion host. |
| `aforo.flush-count` | `50` | Events per immediate flush. |
| `aforo.flush-interval-ms` | `5000` | Background flush cadence. |

## Walk me through it

Step-by-step from zero to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Broker / gateway-side metering.** This is an in-process Java SDK. For protocol-level metering see the sibling SDKs (`graphql-metering`, `grpc-metering`, `ws-metering`, `mqtt-metering`) or the gateway plugins.
- **Guaranteed delivery.** Events live in an in-memory ring buffer. A hard `kill -9` or a buffer overflow past `maxQueueSize` drops events; there is no on-disk spool.
- **Reading usage back.** This SDK only writes events. Querying metered usage, rating, and invoicing happen in the Aforo platform, not here.
