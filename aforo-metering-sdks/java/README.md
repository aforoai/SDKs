# ai.aforo:metering

Track API usage from any Java service and let Aforo handle batching, retry, and delivery. Drop in a Spring Boot servlet filter to meter every request automatically, or call `AforoClient.track(...)` by hand when you decide what counts.

**Version:** 1.1.2 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended (once published to Maven Central):

```xml
<dependency>
  <groupId>ai.aforo</groupId>
  <artifactId>metering</artifactId>
  <version>1.1.2</version>
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

`track(...)` returns immediately — it pushes onto an in-memory ring buffer that a daemon thread flushes to `https://api.aforo.ai/v1/ingest/batch` every 5 seconds, or sooner once 50 events are queued. The constructor also registers a JVM shutdown hook, so events aren't lost if the process exits without an explicit `close()`.

Spring Boot — add the dependency and set two properties; the auto-configuration wires an `AforoClient` bean and a request-end servlet filter:

```yaml
# application.yml
aforo:
  enabled: true          # auto-config is off unless this is exactly "true"
  api-key: ${AFORO_API_KEY}
  base-url: https://api.aforo.ai
  metric-name: api_calls   # must exist in your Aforo catalog
  product-type: API        # default; top-level productType on every event
```

The filter runs **after** the response is committed, so metering adds no latency to the API call. It records `aforo.metric-name` (default `api_calls`) or the result of an `AforoServletFilter.MetricNameResolver` bean. It resolves the customer from an `AforoServletFilter.CustomerIdResolver` bean if one exists, otherwise from the `X-Customer-Id` header (`aforo.customer-id-header`); the Spring Security principal is used only when `aforo.use-principal-as-customer-id: true`. The caller's `X-Api-Key` header is never used — it is a secret, not a customer id. Requests with no customer, and `OPTIONS` (CORS preflight) requests, are skipped. Each event also carries top-level `endpointPath` (the matched route pattern, else the normalized path, without query string, at most 512 chars), `httpMethod`, `statusCode`, `responseTimeMs`, and `productType` (`AforoServletFilter.productType(...)`, else the client default).

> ⚠ The metric must exist in your tenant's Aforo catalog: the ingestor rejects events for an unknown metric, and they are dropped with reason `REJECTED` (see [Dropped events](#dropped-events)). Earlier versions recorded `"<METHOD> <normalized-path>"`, which no catalog contains.

> ⚠ The customer id comes from the authenticated principal or a server-trusted header — not from request body fields a client controls. Tenancy is determined by your `api-key`; there is no separate `tenant_id` config field in this SDK.

## Configuration

`AforoOptions` (manual path) — constructor takes the API key; everything else is a fluent setter:

| Option | Type | Default | What it does |
|---|---|---|---|
| `apiKey` | `String` | *(required)* | Sent as `X-API-Key: <apiKey>`. Blank throws `IllegalArgumentException`. |
| `baseUrl(...)` | `String` | `https://api.aforo.ai` | Ingestion host. The SDK appends `/v1/ingest/batch`. Override per environment. |
| `productType(...)` | `String` | `API` | Sent as top-level `productType` on every event (required by the ingestor): `API`, `AGENTIC_API`, `AI_AGENT`, `MCP_SERVER`, `GRPC_API`, `GRAPHQL_API`, `WEBSOCKET_API`, `MQTT_BROKER`. Trimmed and uppercased; unknown values are passed through. Override per event with `TrackEvent.builder(...).productType(...)`. |
| `flushCount(...)` | `int` | `50` | Buffered events that trigger an immediate async flush; also the batch size. Clamped to 1–1000 (the ingestor's batch limit). |
| `flushIntervalMs(...)` | `long` | `5000` | Background flush cadence in ms. |
| `maxQueueSize(...)` | `int` | `10000` | Ring-buffer capacity. When full, the oldest event is evicted and reported as dropped (`OVERFLOW`). |
| `maxRetries(...)` | `int` | `3` | Retry attempts per batch on 5xx / 408 / 429. |
| `retryBaseMs(...)` | `long` | `1000` | Base backoff in ms; doubles per attempt. A `429` honors `Retry-After` when present. |
| `onDrop(...)` | `BiConsumer<List<ResolvedEvent>, DropReason>` | *(none)* | Called with events the SDK is about to lose. See [Dropped events](#dropped-events). |
| `timeoutMs(...)` | `long` | `10000` | HTTP connect timeout in ms. |
| `shutdownTimeoutMs(...)` | `long` | `5000` | Reserved for shutdown wait tuning. |

Spring Boot properties (prefix `aforo`) — a subset of the above:

| Property | Default | What it does |
|---|---|---|
| `aforo.enabled` | *(unset → off)* | Auto-config activates only when set to `true`. |
| `aforo.api-key` | *(required)* | Aforo API key, sent as `X-API-Key`. |
| `aforo.base-url` | `https://api.aforo.ai` | Ingestion host. |
| `aforo.product-type` | `API` | Top-level `productType` on every event. |
| `aforo.flush-count` | `50` | Events per immediate flush. |
| `aforo.flush-interval-ms` | `5000` | Background flush cadence. |
| `aforo.metric-name` | `api_calls` | Metric recorded per request by the filter. Must exist in your Aforo catalog. Declare an `AforoServletFilter.MetricNameResolver` bean for a per-request metric. |
| `aforo.customer-id-header` | `X-Customer-Id` | Header carrying the Aforo customer id. Declare an `AforoServletFilter.CustomerIdResolver` bean for anything else. |
| `aforo.use-principal-as-customer-id` | `false` | Opt in to using the authenticated principal's name as the customer id (ahead of the header). |

## Execution status (outcome-based pricing)

OUTCOME_BASED rate plans bill each event at the weight set for its `executionStatus`; an event without one bills at full price. Set it per event:

```java
client.track(TrackEvent.builder("cust_acme_001", "api_calls")
        .executionStatus("TIMEOUT")
        .build());
```

The value is trimmed and upper-cased; `null` or blank means "not set" and the field is left off the event. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value (or one longer than 20 characters) is logged and left off the event; the event is still sent, because the ingestor would reject an event carrying an unknown status. The servlet filter does not set a status.

## Dropped events

Events the SDK cannot deliver are counted, logged at `WARNING`, and passed to an optional hook. `track(...)` never throws for event content — it throws only `IllegalStateException` on a closed client.

```java
AforoClient client = new AforoClient(new AforoOptions(apiKey)
        .onDrop((events, reason) -> deadLetter.save(events, reason)));

long lost = client.droppedCount();
```

| `DropReason` | When |
|---|---|
| `OVERFLOW` | The ring buffer was full; the oldest event was evicted. |
| `RETRY_EXHAUSTED` | The batch failed every attempt (network error, 5xx, 408, 429). |
| `REJECTED` | The ingestor answered a non-retryable 4xx for the batch, or accepted the batch (2xx) but refused individual events in `errors[]`. Only the events the response identifies by index are passed to the hook; `FlushResult.failed()` counts them. |
| `INVALID` | The event would be refused by the ingestor and was never buffered: blank `customerId` or `metricName`, `quantity <= 0` (or NaN / infinite), `customerId` over 64 characters, `metricName` or `idempotencyKey` over 255, `productType` over 20, a `quantity` with more than 14 integer digits or 6 decimal places. Nothing passed to `track(...)` is truncated or rounded. |

The servlet filter is the one exception to "nothing is truncated": `endpointPath` (512 characters) and `httpMethod` (16) come from the incoming request, so an over-long value is cut to the limit and the event is still sent, with one `WARNING` per label. The customer id and metric name are never cut.

Dropped events keep their `idempotencyKey`, so storing them and calling `track(...)` again later is dedup-safe. An exception thrown by the hook is swallowed. `OVERFLOW` and `INVALID` log lines are throttled (first occurrence, then every 1000th).

## Walk me through it

Step-by-step from zero to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Broker / gateway-side metering.** This is an in-process Java SDK. For protocol-level metering see the sibling SDKs (`graphql-metering`, `grpc-metering`, `ws-metering`, `mqtt-metering`) or the gateway plugins.
- **Guaranteed delivery.** Events live in an in-memory ring buffer. A hard `kill -9` loses what is buffered, and a buffer overflow past `maxQueueSize` drops the oldest events (reported through `onDrop`); there is no on-disk spool.
- **Reading usage back.** This SDK only writes events. Querying metered usage, rating, and invoicing happen in the Aforo platform, not here.
