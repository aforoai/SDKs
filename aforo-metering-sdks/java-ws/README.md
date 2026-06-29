# com.aforo:ws-metering

Aforo WebSocket Metering SDK for Java. Framework-agnostic — call `openConnection`, `recordFrame`, and `closeConnection` from your Jakarta WebSocket / Spring WebSocket / Netty / Undertow handlers.

## Install

```xml
<dependency>
  <groupId>com.aforo</groupId>
  <artifactId>ws-metering</artifactId>
  <version>1.0.0</version>
</dependency>
```

## Usage — Jakarta WebSocket

```java
import com.aforo.ws.AforoWsBilling;
import jakarta.websocket.*;
import jakarta.websocket.server.ServerEndpoint;

AforoWsBilling billing = AforoWsBilling.newBuilder()
    .tenantId("tenant_acme")
    .productId("prod_ws_market_feed")
    .apiKey(System.getenv("AFORO_API_KEY"))
    .ingestorUrl("https://ingestor.aforo.ai")
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

## Billing strategy

Default mode emits **one** `CONNECTION_OPENED` event on `openConnection` and **one** `CONNECTION_CLOSED` event on `closeConnection`, with aggregated `messageCount` (frames in + frames out), `dataBytes`, and `durationMs`.

For per-frame events, set `perFrameEvents(true)` on the builder.

## Close-code mapping

Standard WebSocket close codes (1000-1011) map to descriptor enum: `NORMAL_CLOSURE`, `GOING_AWAY`, `PROTOCOL_ERROR`, `UNSUPPORTED_DATA`, `ABNORMAL_CLOSURE`, `POLICY_VIOLATION`, `MESSAGE_TOO_BIG`, `INTERNAL_ERROR`. Codes ≥ 4000 → `IDLE_TIMEOUT`.

## Batching & retry

100 events / 3 s by default — more aggressive than HTTP SDKs because WebSocket traffic is higher-volume. 3× exponential retry. AutoCloseable.

## License

MIT
