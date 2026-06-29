# mqttmetering — Aforo MQTT Metering SDK for Go

Client-side MQTT billing for Go applications. Wrap your `paho.mqtt.golang` (or any other MQTT client) call sites to emit `PUBLISH`, `SUBSCRIBE`, `UNSUBSCRIBE`, `CONNECT`, and `DISCONNECT` events to Aforo.

> For broker-side metering on EMQ X 5.x, use the companion Erlang plugin at `aforo-nextgen-docker/emqx-plugin-aforo-metering/`.

## Install

```bash
go get github.com/aforo/mqtt-metering-go
```

Zero runtime deps.

## Usage — paho.mqtt.golang

```go
package main

import (
    "log"
    "os"
    "time"

    mqttmetering "github.com/aforo/mqtt-metering-go"
    mqtt "github.com/eclipse/paho.mqtt.golang"
)

func main() {
    billing, _ := mqttmetering.New(mqttmetering.Config{
        TenantID:    "tenant_acme",
        ProductID:   "prod_mqtt_iot_telemetry",
        APIKey:      os.Getenv("AFORO_API_KEY"),
        IngestorURL: "https://ingestor.aforo.ai",
    })
    defer billing.Shutdown()

    customerID, clientID := "cust_acme_001", "device-001"

    opts := mqtt.NewClientOptions().
        AddBroker("ssl://broker.example.com:8883").
        SetClientID(clientID).
        SetOnConnectHandler(func(c mqtt.Client) {
            billing.RecordConnect(customerID, clientID)
        }).
        SetConnectionLostHandler(func(c mqtt.Client, err error) {
            billing.RecordDisconnect(customerID, clientID)
        }).
        SetDefaultPublishHandler(func(c mqtt.Client, msg mqtt.Message) {
            billing.RecordDeliver(customerID, clientID, msg.Topic(),
                int(msg.Qos()), msg.Retained(), int64(len(msg.Payload())))
        })

    client := mqtt.NewClient(opts)
    if t := client.Connect(); t.Wait() && t.Error() != nil {
        log.Fatal(t.Error())
    }

    client.Subscribe("sensors/+/temperature", 1, nil)
    billing.RecordSubscribe(customerID, clientID, "sensors/+/temperature", 1)

    payload := []byte(`{"online": true}`)
    client.Publish("devices/001/status", 0, false, payload)
    billing.RecordPublish(customerID, clientID, "devices/001/status", 0, false, int64(len(payload)))

    time.Sleep(time.Hour)
}
```

## Event methods

| Go call             | Event type     |
|---------------------|---------------|
| `RecordPublish`     | `PUBLISH`     |
| `RecordDeliver`     | `DELIVER` (off by default) |
| `RecordSubscribe`   | `SUBSCRIBE`   |
| `RecordUnsubscribe` | `UNSUBSCRIBE` |
| `RecordConnect`     | `CONNECT`     |
| `RecordDisconnect`  | `DISCONNECT`  |

`DELIVER` events are skipped unless `EmitDeliverEvents: true` is set on the config.

## Per-tier filtering

Every event carries `mqttQos` (0/1/2) and `mqttRetained`. Use these in descriptor filter conditions:

- Charge only QoS ≥ 1: `filterCondition: { mqtt_qos: ['1', '2'] }`
- Premium tier for retained: `filterCondition: { mqtt_retained: ['true'] }`

## Batching & retry

200 events / 2 s defaults — most aggressive of the SDKs because MQTT IoT telemetry is highest-volume. 3× exponential retry. Call `Shutdown()` to drain before exit.

## License

MIT
