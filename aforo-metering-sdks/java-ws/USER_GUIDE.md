# com.aforo:ws-metering — User Guide

**Version:** 1.0.0 · **Updated:** 2026-06-29 · **Audience:** Java engineers running a WebSocket server (Jakarta WebSocket, Spring WebSocket, Netty, Undertow) who need connection/frame/byte metering.

## What you'll build

A WebSocket endpoint that reports one Aforo event when a connection opens and one when it closes, carrying aggregated frame counts, bytes, and duration. By the end you'll have a metered connection confirmed as landed in Aforo.

## Prerequisites

- JDK 17 or newer.
- A WebSocket server you can hook open/message/close callbacks on. For the Jakarta path, `jakarta.websocket-api` 2.1+ supplied by your container.
- An Aforo API key (`AFORO_API_KEY`), a `tenant_id`, and a `product_id` for this socket surface.
- A way to resolve the customer id when a connection opens (a query param, a header captured at handshake, or your session).

## Step 1 — Build the SDK into your local Maven repo

```bash
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-metering-sdks/java-ws
mvn clean install
```

Add to your service's `pom.xml`:

```xml
<dependency>
  <groupId>com.aforo</groupId>
  <artifactId>ws-metering</artifactId>
  <version>1.0.0</version>
</dependency>
```

## Step 2 — Export your credentials

```bash
export AFORO_API_KEY="sk_live_xxxxxxxxxxxxxxxxxxxx"
```

## Step 3 — Build one shared billing instance

Build it once and share it across all connections (it's thread-safe and holds the per-connection counters):

```java
import com.aforo.ws.AforoWsBilling;

AforoWsBilling billing = AforoWsBilling.newBuilder()
        .tenantId("tenant_acme")
        .productId("prod_ws_market_feed")
        .apiKey(System.getenv("AFORO_API_KEY"))
        .ingestorUrl("https://ingest.aforo.ai")
        // .perFrameEvents(true)   // opt in for one event per frame
        .build();
```

> ⚠ `ingestorUrl` is the host only — the SDK appends `/v1/ingest/events`. Pass `https://ingest.aforo.ai`, not the full path.

## Step 4 — Open, record frames, and close

```java
@OnOpen
public void open(Session s) {
    String customerId = s.getRequestParameterMap()
            .getOrDefault("customer", java.util.List.of("")).get(0);
    this.connectionId = billing.openConnection(customerId, java.util.Map.of("path", "/ws"));
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
```

> ⚠ Keep `connectionId` for the life of the socket (a per-session field, as above). `recordFrame` and `closeConnection` look up the in-memory counters by that id; a `null` or stale id is silently ignored, so frames and the CLOSE event would be lost. Resolve the customer at open time — `openConnection` returns `null` for a blank customer and the connection won't be metered.

## Step 5 — Drive a connection, then flush and verify

Connect a client, send a message or two, and close. The CLOSE event is queued on `closeConnection`. Flush the buffer before you check:

```java
billing.close();   // flushes synchronously, then shuts down the daemon thread
```

Then confirm on the Aforo side:

- Aforo console → **Ingestion → Recent Events**, filter by your `customerId`. You'll see `websocket_api.message` (the OPEN marker) and `websocket_api.connection_closed` with the aggregated `messageCount`, `dataBytes`, `durationMs`, and `wsCloseReason`.

For a long-running server, register the flush on shutdown:

```java
Runtime.getRuntime().addShutdownHook(new Thread(billing::close));
```

## Configuration reference

| Option | Type | Default | What it does |
|---|---|---|---|
| `tenantId` | `String` | *(required)* | `X-Tenant-Id` header. |
| `productId` | `String` | *(required)* | `metadata.productId`. |
| `apiKey` | `String` | *(required)* | Bearer token. |
| `ingestorUrl` | `String` | *(required)* | Host; SDK appends `/v1/ingest/events`. |
| `perFrameEvents` | `boolean` | `false` | `true` = one event per frame; `false` = OPEN + CLOSE only, aggregated. |
| `flushCount` | `int` | `100` | Events per immediate flush. |
| `flushIntervalMs` | `long` | `3000` | Background flush cadence (ms). |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `IllegalArgumentException: <field> is required` at build | A required builder field (`tenantId` / `productId` / `apiKey` / `ingestorUrl`) is blank | Set all four; they're validated in the constructor. |
| No events for a connection | `openConnection` returned `null` (blank customer), or `connectionId` wasn't kept for later calls | Resolve a non-blank customer at open; store the returned id on the session. |
| CLOSE event missing | `closeConnection` was never called (e.g. abnormal disconnect) or the process died first | Call `closeConnection` from `@OnClose` / your error path; flush before shutdown. |
| Events POST to a 404 | `ingestorUrl` already includes the path | Pass the host only; the SDK appends `/v1/ingest/events`. |
| Far more events than connections | `perFrameEvents(true)` is set | That's per-frame mode. Leave it `false` for aggregated OPEN/CLOSE only. |
| `flush exhausted retries — dropped N events` in logs | Ingestor returned non-2xx on all 3 attempts | Verify the key + `X-Tenant-Id`; ensure the `websocket_api.*` metrics exist in Aforo. |

## What this guide does NOT cover

- **Automatic frame capture.** The SDK meters only the frames you report via `recordFrame`; the byte size is whatever you pass.
- **Client-side socket metering.** This meters the server side. Client metering needs a different integration.
- **Reading metered usage back.** This SDK writes events only — retrieval and rating live in the Aforo platform.
