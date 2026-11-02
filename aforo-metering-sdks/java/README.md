# ai.aforo:metering

Track API usage from any Java service and let Aforo handle batching, retry, and delivery. Drop in a Spring Boot servlet filter to meter every request automatically, or call `AforoClient.track(...)` by hand when you decide what counts.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended (once published to Maven Central):

```xml
<dependency>
  <groupId>ai.aforo</groupId>
  <artifactId>metering</artifactId>
  <version>2.0.0</version>
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

Manual tracking with try-with-resources — `AforoClient` is `AutoCloseable`, so queued events are sent on close:

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

`track(...)` returns immediately and never starts a thread or a request. It puts the event in a bounded queue (10 000 by default); one background thread sends it to `https://api.aforo.ai/v1/ingest/batch` every 5 seconds, or as soon as 500 events are queued. If the ingestor is unreachable, the batch goes back to the queue with the same idempotency keys and is resent after a cooldown, so an outage loses nothing while the queue has room. `close()` keeps sending for up to `shutdownTimeoutMs` (5 s) and reports what is left as `SHUTDOWN`. Outside Spring the constructor registers a JVM shutdown hook that does the same.

Spring Boot — add the dependency, set the properties, and tell the filter who the customer is. The auto-configuration wires an `AforoClient` bean, a request-end servlet filter, and closes the client in Spring's stop phase (no JVM shutdown hook racing it). Every bean backs off if you declare your own:

```yaml
# application.yml
aforo:
  enabled: true          # auto-config is off unless this is exactly "true"
  api-key: ${AFORO_API_KEY}
  base-url: https://api.aforo.ai
  metric-name: api_calls   # must exist in your Aforo catalog
  product-type: API        # default; top-level productType on every event
```

```java
// The customer comes from YOUR authentication, not from a header the caller can set.
@Bean
AforoServletFilter.CustomerIdResolver aforoCustomerIdResolver() {
    return request -> {
        var auth = SecurityContextHolder.getContext().getAuthentication();
        return auth == null ? null : accountService.aforoCustomerIdFor(auth.getName());
    };
}
```

Without a `CustomerIdResolver` bean, `aforo.use-principal-as-customer-id: true` (the principal name is the Aforo customer id) or `aforo.trust-customer-header: true` (a gateway in front of the app sets `X-Customer-Id`), the application fails to start with a message saying so.

The filter runs **after** the response is committed, so metering adds no latency to the API call. It records `aforo.metric-name` (default `api_calls`) or the result of an `AforoServletFilter.MetricNameResolver` bean. It resolves the customer from your `AforoServletFilter.CustomerIdResolver` bean, else the principal name when `aforo.use-principal-as-customer-id: true`, else the `X-Customer-Id` header (`aforo.customer-id-header`) only when `aforo.trust-customer-header: true`. The caller's `X-Api-Key` header is never used — it is a secret, not a customer id. A request with no customer is served as usual; its event is not sent and is reported as `INVALID`. `OPTIONS` (CORS preflight) requests are skipped. Outside Spring, build the filter with `AforoServletFilter.builder(client).customerIdResolver(...).build()`; `build()` throws when no customer source is set. Each event also carries top-level `endpointPath` (the matched route pattern, else the normalized path, without query string, at most 512 chars), `httpMethod`, `statusCode`, `responseTimeMs`, and `productType` (`AforoServletFilter.productType(...)`, else the client default).

> ⚠ The metric must exist in your tenant's Aforo catalog: the ingestor rejects events for an unknown metric, and they are dropped with reason `REJECTED` (see [Dropped events](#dropped-events)). Earlier versions recorded `"<METHOD> <normalized-path>"`, which no catalog contains.

> ⚠ The customer id comes from your authentication. `X-Customer-Id` is set by whoever calls your API, so trusting it lets any caller bill usage to another customer; turn on `trust-customer-header` only when a gateway in front of the app sets the header and strips the caller's value. Tenancy is determined by your `api-key`; there is no separate `tenant_id` config field in this SDK.

## Configuration

`AforoOptions` (manual path) — constructor takes the API key; everything else is a fluent setter:

| Option | Type | Default | What it does |
|---|---|---|---|
| `apiKey` | `String` | *(required)* | Sent as `X-API-Key: <apiKey>`. Blank throws `IllegalArgumentException`. |
| `baseUrl(...)` | `String` | `https://api.aforo.ai` | Ingestion host. The SDK appends `/v1/ingest/batch`. Must be `https://`; plain `http://` is accepted for `localhost`, `127.0.0.1` and `::1`, or with `allowInsecureHttp(true)`. |
| `allowInsecureHttp(...)` | `boolean` | `false` | Accept a plain `http://` base URL on another host. The API key travels in every request. |
| `productType(...)` | `String` | `API` | Sent as top-level `productType` on every event (required by the ingestor): `API`, `AGENTIC_API`, `AI_AGENT`, `MCP_SERVER`, `GRPC_API`, `GRAPHQL_API`, `WEBSOCKET_API`, `MQTT_BROKER`. Trimmed and uppercased; unknown values are passed through. Override per event with `TrackEvent.builder(...).productType(...)`. |
| `flushCount(...)` | `int` | `500` | Queued events that wake the background thread; also the batch size. Clamped to 1–1000 (the ingestor's batch limit). A batch whose body would pass 4 MiB is split. |
| `flushIntervalMs(...)` | `long` | `5000` | Background flush cadence in ms. |
| `maxQueueSize(...)` | `int` | `10000` | Queue capacity. When full, the oldest event is evicted and reported as dropped (`OVERFLOW`). |
| `maxRetries(...)` | `int` | `3` | Retries per request on a network error, timeout, 408, 429 or 5xx. |
| `retryBaseMs(...)` | `long` | `500` | Base of the full-jitter backoff: each wait is random between 0 and `min(30 s, base × 2^attempt)`. `Retry-After` (seconds or HTTP-date) is honoured, up to 60 s. |
| `breakerCooldownMs(...)` | `long` | `5000` | Pause after a batch fails every retry (or gets 401/403); doubles with jitter up to 5 minutes. The batch stays queued. |
| `registerShutdownHook(...)` | `boolean` | `true` | Close the client from a JVM shutdown hook. The Spring auto-configuration turns it off. |
| `onDrop(...)` | `BiConsumer<List<ResolvedEvent>, DropReason>` | *(none)* | Called with events the SDK is about to lose. See [Dropped events](#dropped-events). |
| `onError(...)` | `Consumer<AforoError>` | *(none)* | Delivery problems typed by `kind()`: `OUTAGE`, `AUTH` (events kept, resent), `REJECTED`, `SHUTDOWN`, `CLOSED` (events dropped). Branch on `kind()`, not the message. |
| `onAccepted(...)` | `BiConsumer<Map<String,Object>, List<ResolvedEvent>>` | *(none)* | The envelope-unwrapped body of each accepted batch, for fields such as `killedSessionIds`. |
| `timeoutMs(...)` | `long` | `10000` | Total deadline of one ingest request in ms. |
| `shutdownTimeoutMs(...)` | `long` | `5000` | How long `close()` keeps sending. Each request in that window uses `min(timeoutMs, time left)`; what is still queued at the deadline is reported as `SHUTDOWN`. |

Spring Boot properties (prefix `aforo`) — a subset of the above:

| Property | Default | What it does |
|---|---|---|
| `aforo.enabled` | *(unset → off)* | Auto-config activates only when set to `true`. |
| `aforo.api-key` | *(required)* | Aforo API key, sent as `X-API-Key`. |
| `aforo.base-url` | `https://api.aforo.ai` | Ingestion host. |
| `aforo.product-type` | `API` | Top-level `productType` on every event. |
| `aforo.flush-count` | `500` | Events per request. |
| `aforo.max-queue-size` | `10000` | Queue capacity. |
| `aforo.timeout-ms` | `10000` | Total deadline of one ingest request. |
| `aforo.shutdown-timeout-ms` | `5000` | How long Spring's stop phase keeps sending queued events. |
| `aforo.allow-insecure-http` | `false` | Accept plain `http://` on a host other than localhost. |
| `aforo.flush-interval-ms` | `5000` | Background flush cadence. |
| `aforo.metric-name` | `api_calls` | Metric recorded per request by the filter. Must exist in your Aforo catalog. Declare an `AforoServletFilter.MetricNameResolver` bean for a per-request metric. |
| `aforo.customer-id-header` | `X-Customer-Id` | Header read when `aforo.trust-customer-header` is on. |
| `aforo.trust-customer-header` | `false` | Read the customer id from the header. Only when a gateway in front of the app sets it. |
| `aforo.use-principal-as-customer-id` | `false` | Use the authenticated principal's name as the customer id (ahead of the header). |

## Execution status (outcome-based pricing)

OUTCOME_BASED rate plans bill each event at the weight set for its `executionStatus`; an event without one bills at full price. Set it per event:

```java
client.track(TrackEvent.builder("cust_acme_001", "api_calls")
        .executionStatus("TIMEOUT")
        .build());
```

The value is trimmed and upper-cased; `null` or blank means "not set" and the field is left off the event. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value (or one longer than 20 characters) is logged and left off the event; the event is still sent, because the ingestor would reject an event carrying an unknown status. The servlet filter does not set a status.

## Dropped events

Events the SDK cannot deliver are counted, logged at `WARNING`, and passed to an optional hook. `track(...)` never throws — not for event content and not on a closed client. An ingest outage is not a drop: the events wait in the queue and are resent with the same keys.

```java
AforoClient client = new AforoClient(new AforoOptions(apiKey)
        .onDrop((events, reason) -> deadLetter.save(events, reason)));

long lost = client.droppedCount();
```

| `DropReason` | When |
|---|---|
| `OVERFLOW` | The queue was full (often during a long outage); the oldest event was evicted. |
| `REJECTED` | The ingestor answered a non-retryable 4xx (400, 404, 409, 422, ...) for the batch, a single event still got 413, or a 2xx listed the event in `errors[]` with `retryable: false`. Events listed with `retryable: true` go back to the queue. `FlushResult.failed()` counts rejected events. |
| `SHUTDOWN` | Still queued when `close()` reached `shutdownTimeoutMs`. |
| `CLOSED` | `track(...)` was called after `close()`. |
| `RETRY_EXHAUSTED` | Kept for compatibility; an outage no longer drops events. |
| `INVALID` | No customer for a filtered request, or the event would be refused by the ingestor and was never queued: blank `customerId` or `metricName`, `quantity <= 0` (or NaN / infinite), `customerId` over 64 characters, `metricName` or `idempotencyKey` over 255, `productType` over 20, a `quantity` with more than 14 integer digits or 6 decimal places. Nothing passed to `track(...)` is truncated or rounded. |

The servlet filter is the one exception to "nothing is truncated": `endpointPath` (512 characters) and `httpMethod` (16) come from the incoming request, so an over-long value is cut to the limit and the event is still sent, with one `WARNING` per label. The customer id and metric name are never cut.

Dropped events keep their `idempotencyKey`, so storing them and calling `track(...)` again later is dedup-safe. An exception thrown by the hook is swallowed. `OVERFLOW` and `INVALID` log lines are throttled (first occurrence, then every 1000th).

## Walk me through it

Step-by-step from zero to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Broker / gateway-side metering.** This is an in-process Java SDK. For protocol-level metering see the sibling SDKs (`graphql-metering`, `grpc-metering`, `ws-metering`, `mqtt-metering`) or the gateway plugins.
- **Guaranteed delivery.** Events live in an in-memory queue. A hard `kill -9` loses what is queued, and an overflow past `maxQueueSize` drops the oldest events (reported through `onDrop`); there is no on-disk spool.
- **A `401` / `403` from the ingestor** is treated as an outage, logged at `SEVERE` once per cooldown: fix or rotate the API key and the queued usage is delivered.
- **Reading usage back.** This SDK only writes events. Querying metered usage, rating, and invoicing happen in the Aforo platform, not here.
