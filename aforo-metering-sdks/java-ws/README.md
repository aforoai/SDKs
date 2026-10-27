# ai.aforo:ws-metering

Meter WebSocket connections, frames, and bytes from any Java WebSocket stack. Call three methods from your open/message/close handlers — Jakarta WebSocket, Spring WebSocket, Netty, Undertow — and Aforo handles aggregation, batching, and retry.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended (once published to Maven Central):

```xml
<dependency>
  <groupId>ai.aforo</groupId>
  <artifactId>ws-metering</artifactId>
  <version>2.0.0</version>
</dependency>
```

**Not yet on Maven Central — build from source for now:**

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/java-ws
mvn clean install
```

Java 17+. `jakarta.websocket:jakarta.websocket-api` 2.1+ is a `provided` peer dependency for the Jakarta path — your container supplies it. The SDK itself is framework-agnostic; you can drive it from any WebSocket library.

## Quickstart — Jakarta WebSocket

```java
import com.aforo.ws.AforoWsBilling;
import jakarta.websocket.*;
import jakarta.websocket.server.ServerEndpoint;
import java.util.List;
import java.util.Map;

AforoWsBilling billing = AforoWsBilling.newBuilder()
        .tenantId("tenant_acme")
        .productId("prod_ws_market_feed")
        .apiKey(System.getenv("AFORO_API_KEY"))
        .ingestorUrl("https://api.aforo.ai")
        .build();

@ServerEndpoint("/ws")
public class FeedSocket {
    private String connectionId;

    @OnOpen
    public void open(Session s) {
        // From the identity your handshake authenticated, never a query parameter the client sets.
        String customerId = customers.idFor(s.getUserPrincipal());
        connectionId = billing.openConnection(customerId, Map.of("path", "/ws"));
    }

    @OnMessage
    public void incoming(String msg, Session s) {
        billing.recordFrame(connectionId, "CLIENT_TO_SERVER", "TEXT", msg.length());
        s.getAsyncRemote().sendText("echo: " + msg);
        billing.recordFrame(connectionId, "SERVER_TO_CLIENT", "TEXT", msg.length() + 6);
    }

    @OnClose
    public void close(Session s, CloseReason reason) {
        billing.closeConnection(connectionId, reason.getCloseCode().getCode());
    }
}
```

Events POST to `<ingestorUrl>/v1/ingest/batch` as `{"events": [...]}` (at most 1000 events per request; larger flushes are split) with `X-API-Key: <apiKey>` and `X-Tenant-Id: <tenantId>`. The SDK keeps events in a bounded queue (10 000 by default; overflow evicts the oldest as `OVERFLOW`). One background thread sends them every 5 seconds or as soon as 500 are queued. Retries use full-jitter backoff and honour `Retry-After` (seconds or HTTP-date, up to 60 s). If the ingestor stays unreachable, the batch goes back to the queue with the same idempotency keys and is resent after a cooldown, so an outage loses nothing while the queue has room. `close()` keeps sending for up to `shutdownTimeoutMs` (5 s) and reports what is left as `SHUTDOWN`.

> ⚠ `openConnection(customerId, ...)` returns `null` when `customerId` is blank (the open event is counted as `INVALID`), and every subsequent call short-circuits on a `null` connection id. Resolve the customer at open time from your auth, not from a frame payload. Keep the returned `connectionId` for the life of the socket — it's how `recordFrame` and `closeConnection` find the in-memory counters.

## Configuration

Builder options on `AforoWsBilling.newBuilder()`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `String` | *(required)* | Sent as the `X-Tenant-Id` header. |
| `productId` | `String` | *(required)* | Stamped into `metadata.productId`. |
| `apiKey` | `String` | *(required)* | Aforo API key, sent as `X-API-Key`. |
| `ingestorUrl` | `String` | *(required)* | Ingestion host, `https://` (plain `http://` only for localhost or with `allowInsecureHttp`). The SDK appends `/v1/ingest/batch`. Use `https://api.aforo.ai`. |
| `perFrameEvents` | `boolean` | `false` | When `true`, each `recordFrame` emits its own event. When `false`, only OPEN and CLOSE events are emitted, with frame/byte totals aggregated on CLOSE. |
| `productType` | `String` | `WEBSOCKET_API` | Top-level `productType` on every event (required by the ingestor). Trimmed and uppercased; unknown values are passed through. |
| `flushCount` | `int` | `500` | Events per request (at most 1000); also how many queued events wake the sender. |
| `flushIntervalMs` | `long` | `5000` | How often queued events are sent when the batch is not full (ms). |
| `maxQueueSize` | `int` | `10000` | Queue capacity; when full, the oldest event is dropped as `OVERFLOW`. |
| `maxRetries` | `int` | `3` | Retries per request on a network error, timeout, 408, 429 or 5xx. |
| `retryBaseMs` | `long` | `500` | Base of the full-jitter backoff (each wait is random up to `min(30 s, base × 2^attempt)`). |
| `timeoutMs` | `long` | `10000` | Total deadline of one ingest request (ms). |
| `shutdownTimeoutMs` | `long` | `5000` | How long `close()` keeps sending; leftovers are reported as `SHUTDOWN`. |
| `breakerCooldownMs` | `long` | `5000` | Pause after a batch fails every retry or gets 401/403; doubles with jitter up to 5 minutes. |
| `allowInsecureHttp` | `boolean` | `false` | Accept a plain `http://` `ingestorUrl` on a host other than localhost / 127.0.0.1 / ::1. |

Every required field is validated at build time — a blank value throws `IllegalArgumentException`.

## Execution status (outcome-based pricing)

OUTCOME_BASED rate plans bill each event at the weight set for its `executionStatus`. This SDK never derives one — a close code alone doesn't say whether the session succeeded — so only the value you pass is sent. Each entry point takes it as an optional last argument:

```java
String connId = billing.openConnection(customerId, metadata, null);
billing.recordFrame(connId, "SERVER_TO_CLIENT", "TEXT", bytes, "SUCCESS");  // per-frame mode only
billing.closeConnection(connId, closeCode, "TIMEOUT");
```

The value is trimmed and upper-cased; `null` or blank means "not set" and the field is left off the event. Accepted values: `SUCCESS`, `PARTIAL`, `TIMEOUT`, `ERROR`, `VALIDATION_FAILED`, `FAILED`, `FAILURE`, `CANCELLED`, `PENDING`, `BLOCKED`, `HITL_REQUIRED`. Any other value is logged and left off the event (the event is still sent) — the ingestor would reject an event carrying an unknown status.

## Dropped events

Events the SDK cannot deliver are counted, logged at `WARNING`, and passed to an optional hook. Nothing is thrown from the `record*` / `openConnection` calls for event content.

```java
AforoWsBilling billing = AforoWsBilling.newBuilder()
        // ...
        .onDrop((events, reason) -> deadLetter.save(events, reason))
        .build();

long lost = billing.droppedCount();
```

| `DropReason` | When |
|---|---|
| `OVERFLOW` | The queue was full (usually during a long outage); the oldest event was evicted. |
| `SHUTDOWN` | Still queued when `close()` reached `shutdownTimeoutMs`. |
| `CLOSED` | Recorded after `close()`. Nothing is thrown. |
| `RETRY_EXHAUSTED` | Kept for compatibility. An outage no longer drops events: they wait in the queue and are resent with the same keys. |
| `REJECTED` | The ingestor answered a non-retryable 4xx for the batch, or accepted the batch (2xx) but refused individual events in `errors[]`. Only the events the response identifies by index are passed to the hook. |
| `INVALID` | The event breaks an ingestor field limit and was never sent: `customerId` over 64 characters, `productType` over 20. Values are never truncated. |

Dropped events keep their `idempotencyKey`, so storing them and re-sending later is dedup-safe. An exception thrown by the hook is swallowed.

## Billing model

Default mode emits **one** `CONNECTION_OPENED` event on `openConnection` (`wsFrameType: OPEN`, metric `websocket_api.connection_opened`) and **one** `CONNECTION_CLOSED` event on `closeConnection` (metric `websocket_api.connection_closed`). A connection you never close is closed for you: after `connectionIdleTimeoutMs` without a frame (default 1 h; `ABNORMAL_CLOSURE`, metadata `closedBy: sdk_idle_timeout`), or by `close()` (`GOING_AWAY`, `closedBy: sdk_shutdown`). `openConnections()` returns how many are tracked. The CLOSE event carries the aggregated `messageCount` (frames in + out), `dataBytes`, `executionDurationMs`, `closeCode`, and a mapped `wsCloseReason`. Set `perFrameEvents(true)` to also emit one event per frame.

Close codes map to descriptor reasons: `1000 → NORMAL_CLOSURE`, `1001 → GOING_AWAY`, `1002/1007 → PROTOCOL_ERROR`, `1003 → UNSUPPORTED_DATA`, `1006 → ABNORMAL_CLOSURE`, `1008 → POLICY_VIOLATION`, `1009 → MESSAGE_TOO_BIG`, `1011 → INTERNAL_ERROR`, codes ≥ 4000 → `IDLE_TIMEOUT`.

## Walk me through it

Step-by-step from zero to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Automatic frame interception.** You call `recordFrame` from your handlers — the SDK can't see frames you don't report. The byte count is whatever you pass.
- **Guaranteed delivery.** Events wait in an in-memory queue. A hard crash loses what is queued, and an overflow past `maxQueueSize` drops the oldest events (reported to `onDrop`). There is no on-disk spool. A `401` / `403` from the ingestor is treated as an outage and logged at `SEVERE`: fix the key and the queued events are delivered.
- **The matching client SDK.** This meters the server side of a socket. Client-side metering needs a different integration.
