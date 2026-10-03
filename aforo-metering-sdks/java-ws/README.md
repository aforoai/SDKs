# ai.aforo:ws-metering

Meter WebSocket connections, frames, and bytes from any Java WebSocket stack. Call three methods from your open/message/close handlers — Jakarta WebSocket, Spring WebSocket, Netty, Undertow — and Aforo handles aggregation, batching, and retry.

**Version:** 1.2.1 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended (once published to Maven Central):

```xml
<dependency>
  <groupId>ai.aforo</groupId>
  <artifactId>ws-metering</artifactId>
  <version>1.2.1</version>
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
        String customerId = s.getRequestParameterMap().getOrDefault("customer", List.of("")).get(0);
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

Events POST to `<ingestorUrl>/v1/ingest/batch` as `{"events": [...]}` (at most 1000 events per request; larger flushes are split) with `X-API-Key: <apiKey>` and `X-Tenant-Id: <tenantId>`. The buffer flushes every 3 seconds or once 100 events queue — more aggressive than the HTTP SDKs because WebSocket traffic is higher-volume — with 3× exponential retry.

> ⚠ `openConnection(customerId, ...)` returns `null` when `customerId` is blank, and every subsequent call short-circuits on a `null` connection id. Resolve the customer at open time from your auth, not from a frame payload. Keep the returned `connectionId` for the life of the socket — it's how `recordFrame` and `closeConnection` find the in-memory counters.

## Configuration

Builder options on `AforoWsBilling.newBuilder()`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `String` | *(required)* | Sent as the `X-Tenant-Id` header. |
| `productId` | `String` | *(required)* | Stamped into `metadata.productId`. |
| `apiKey` | `String` | *(required)* | Aforo API key, sent as `X-API-Key`. |
| `ingestorUrl` | `String` | *(required)* | Ingestion host. The SDK appends `/v1/ingest/batch`. Use `https://api.aforo.ai`. |
| `perFrameEvents` | `boolean` | `false` | When `true`, each `recordFrame` emits its own event. When `false`, only OPEN and CLOSE events are emitted, with frame/byte totals aggregated on CLOSE. |
| `productType` | `String` | `WEBSOCKET_API` | Top-level `productType` on every event (required by the ingestor). Trimmed and uppercased; unknown values are passed through. |
| `flushCount` | `int` | `100` | Buffered events that trigger an immediate flush. |
| `flushIntervalMs` | `long` | `3000` | Background flush cadence (ms). |

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
| `RETRY_EXHAUSTED` | The batch failed all 3 attempts (network error, 5xx, 408, 429). |
| `REJECTED` | The ingestor answered a non-retryable 4xx for the batch, or accepted the batch (2xx) but refused individual events in `errors[]`. Only the events the response identifies by index are passed to the hook. |
| `INVALID` | The event breaks an ingestor field limit and was never sent: `customerId` over 64 characters, `productType` over 20. Values are never truncated. |

Dropped events keep their `idempotencyKey`, so storing them and re-sending later is dedup-safe. An exception thrown by the hook is swallowed.

## Billing model

Default mode emits **one** `CONNECTION_OPENED` event on `openConnection` and **one** `CONNECTION_CLOSED` event on `closeConnection`. The CLOSE event carries the aggregated `messageCount` (frames in + out), `dataBytes`, `executionDurationMs`, `closeCode`, and a mapped `wsCloseReason`. Set `perFrameEvents(true)` to also emit one event per frame.

Close codes map to descriptor reasons: `1000 → NORMAL_CLOSURE`, `1001 → GOING_AWAY`, `1002/1007 → PROTOCOL_ERROR`, `1003 → UNSUPPORTED_DATA`, `1006 → ABNORMAL_CLOSURE`, `1008 → POLICY_VIOLATION`, `1009 → MESSAGE_TOO_BIG`, `1011 → INTERNAL_ERROR`, codes ≥ 4000 → `IDLE_TIMEOUT`.

## Walk me through it

Step-by-step from zero to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Automatic frame interception.** You call `recordFrame` from your handlers — the SDK can't see frames you don't report. The byte count is whatever you pass.
- **Guaranteed delivery.** Aggregated counters live in memory per connection; a hard crash before `closeConnection` loses that connection's CLOSE event, and a flush exhausting all 3 retries drops that batch. There is no on-disk spool.
- **The matching client SDK.** This meters the server side of a socket. Client-side metering needs a different integration.
