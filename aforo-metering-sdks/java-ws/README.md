# com.aforo:ws-metering

Meter WebSocket connections, frames, and bytes from any Java WebSocket stack. Call three methods from your open/message/close handlers — Jakarta WebSocket, Spring WebSocket, Netty, Undertow — and Aforo handles aggregation, batching, and retry.

**Version:** 1.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

## Install

Intended (once published to Maven Central):

```xml
<dependency>
  <groupId>com.aforo</groupId>
  <artifactId>ws-metering</artifactId>
  <version>1.0.0</version>
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
        .ingestorUrl("https://ingest.aforo.ai")
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

Events POST to `<ingestorUrl>/v1/ingest/events` with `Authorization: Bearer <apiKey>` and `X-Tenant-Id: <tenantId>`. The buffer flushes every 3 seconds or once 100 events queue — more aggressive than the HTTP SDKs because WebSocket traffic is higher-volume — with 3× exponential retry.

> ⚠ `openConnection(customerId, ...)` returns `null` when `customerId` is blank, and every subsequent call short-circuits on a `null` connection id. Resolve the customer at open time from your auth, not from a frame payload. Keep the returned `connectionId` for the life of the socket — it's how `recordFrame` and `closeConnection` find the in-memory counters.

## Configuration

Builder options on `AforoWsBilling.newBuilder()`:

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `String` | *(required)* | Sent as the `X-Tenant-Id` header. |
| `productId` | `String` | *(required)* | Stamped into `metadata.productId`. |
| `apiKey` | `String` | *(required)* | Bearer token. |
| `ingestorUrl` | `String` | *(required)* | Ingestion host. The SDK appends `/v1/ingest/events`. Use `https://ingest.aforo.ai`. |
| `perFrameEvents` | `boolean` | `false` | When `true`, each `recordFrame` emits its own event. When `false`, only OPEN and CLOSE events are emitted, with frame/byte totals aggregated on CLOSE. |
| `flushCount` | `int` | `100` | Buffered events that trigger an immediate flush. |
| `flushIntervalMs` | `long` | `3000` | Background flush cadence (ms). |

Every required field is validated at build time — a blank value throws `IllegalArgumentException`.

## Billing model

Default mode emits **one** `CONNECTION_OPENED` event on `openConnection` and **one** `CONNECTION_CLOSED` event on `closeConnection`. The CLOSE event carries the aggregated `messageCount` (frames in + out), `dataBytes`, `durationMs`, `closeCode`, and a mapped `wsCloseReason`. Set `perFrameEvents(true)` to also emit one event per frame.

Close codes map to descriptor reasons: `1000 → NORMAL_CLOSURE`, `1001 → GOING_AWAY`, `1002/1007 → PROTOCOL_ERROR`, `1003 → UNSUPPORTED_DATA`, `1006 → ABNORMAL_CLOSURE`, `1008 → POLICY_VIOLATION`, `1009 → MESSAGE_TOO_BIG`, `1011 → INTERNAL_ERROR`, codes ≥ 4000 → `IDLE_TIMEOUT`.

## Walk me through it

Step-by-step from zero to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Automatic frame interception.** You call `recordFrame` from your handlers — the SDK can't see frames you don't report. The byte count is whatever you pass.
- **Guaranteed delivery.** Aggregated counters live in memory per connection; a hard crash before `closeConnection` loses that connection's CLOSE event, and a flush exhausting all 3 retries drops that batch. There is no on-disk spool.
- **The matching client SDK.** This meters the server side of a socket. Client-side metering needs a different integration.
