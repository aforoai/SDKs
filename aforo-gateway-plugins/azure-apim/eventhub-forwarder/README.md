# Aforo APIM Event Hub forwarder

**Version:** 2.3.1 · Apache-2.0 · ships with `azure-apim` 2.3.1

Use this when an ingest outage or a `429` must not cost you usage. In the default mode the APIM policy posts each event with `send-one-way-request`, which has no retry. In Event Hub mode the policy writes the event to Azure Event Hubs instead, and this Azure Function reads the hub, sends the events to the Aforo ingestor in batches, and moves its checkpoint only after the ingestor accepted them. While the ingestor is down, events wait in the hub (up to 7 days on the Standard tier) and are sent when it is back.

```
APIM ──log-to-eventhub──► Event Hub ──trigger (batch)──► forwarder Function ──POST /v1/ingest/batch──► Aforo
        (aforo-metering-eventhub)       checkpoint after 2xx                     X-API-Key, retries
```

## What it does with each batch

| Ingestor answer | Forwarder |
|---|---|
| 2xx | done; events named in `errors[]` with `retryable: true` are re-sent with the same keys (at most `AFORO_MAX_RETRIES` times), the rest are dropped and logged with their keys |
| 408, 429, 5xx, network error, timeout | retried with full jitter (base 500 ms, max 30 s), `Retry-After` honoured (seconds or HTTP-date, cap 60 s); after `AFORO_MAX_RETRIES` the invocation fails |
| 413 | batch split in half; a single event that still gets 413 is dropped and logged |
| 401, 403, any 3xx | the invocation fails at once (a wrong key or URL must not lose usage); redirects are never followed |
| other 4xx | batch dropped and logged with its keys |

A failed invocation is re-run by the Functions retry policy (`maxRetryCount: -1`, back-off 5 s to 5 min) on the same events; the checkpoint does not move until a run succeeds. Events the ingestor already accepted are sent again on that re-run and deduplicated by the ingestor (the policy freezes `idempotencyKey` and the compound `correlationId` per APIM request). Compound events go to `/api/v1/ingest/compound/batch`. A compound result the ingestor did not store for a temporary reason (`retryable: true`; from an ingestor that does not send the field yet, the errors `Server busy, retry the batch` or `Processing timeout`) is resent with the same `correlationId`, within the same retry budget as usage events; still not stored after the retries, the invocation fails and the checkpoint stays. Only a permanent rejection is dropped and logged. A redelivered event whose measurements were all stored before (`accepted` 0, `duplicates` > 0) counts as delivered.

The API key is sent only as `X-API-Key` and never logged.

## Settings (app settings)

| Setting | Default | |
|---|---|---|
| `AFORO_API_KEY` | — (required) | Aforo key with scope `usage:ingest`. Use a Key Vault reference. |
| `AFORO_INGEST_URL` | `https://api.aforo.ai/v1/ingest/batch` | https only (http allowed for localhost or with `AFORO_ALLOW_INSECURE_HTTP=true`) |
| `AFORO_COMPOUND_URL` | ingest origin + `/api/v1/ingest/compound/batch` | |
| `AFORO_EVENTHUB_CONNECTION__fullyQualifiedNamespace` | — | `<namespace>.servicebus.windows.net`; the Function's managed identity needs **Azure Event Hubs Data Receiver** |
| `AFORO_EVENTHUB_NAME` | — | |
| `AFORO_EVENTHUB_CONSUMER_GROUP` | — | `aforo-forwarder` in the template |
| `AFORO_BATCH_MAX_EVENTS` | 500 | at most 1000 |
| `AFORO_REQUEST_TIMEOUT_MS` | 10000 | total per request, response body included. The body is read up to 256 KiB; a 2xx answer over that is retried with the same keys. |
| `AFORO_MAX_RETRIES` | 5 | |
| `AFORO_INVOCATION_BUDGET_MS` | 480000 | keep below `functionTimeout` (10 min in `host.json`) |

## Install

1. Turn on the system-assigned managed identity of the APIM instance.
2. Deploy the template into the APIM instance's resource group:

   ```bash
   az deployment group create -g <rg> \
     --template-file deploy/aforo-eventhub-forwarder.json \
     --parameters apimName=<apim> namespaceName=<ns> functionAppName=<app> \
                  storageAccountName=<storage> \
                  aforoApiKey='@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/aforo-api-key/)'
   ```

   It creates the Event Hubs namespace (SAS keys off), the hub (`aforo-metering`, 4 partitions, 7 days), the consumer group, the APIM logger `aforo-metering-logger`, the Function app (Linux Consumption, Node 20) and both role assignments. With a Key Vault reference, give the Function's identity **Key Vault Secrets User** on the secret.

   On a first deployment the logger step can fail with an authorization error (for example `Unauthorized` or `does not have authorization to perform action 'Microsoft.EventHub/namespaces/eventhubs/...'`): the template creates APIM's **Azure Event Hubs Data Sender** role assignment just before the logger, and Azure can take a few minutes to apply a new role assignment. ARM's `dependsOn` already orders the two; it cannot wait for the assignment to take effect. Run the same `az deployment group create` again after a few minutes: everything already created is left as it is and the logger is created. The template has no sleep or deployment script for this on purpose.
3. Deploy the code: `cd eventhub-forwarder && npm ci --omit=dev && func azure functionapp publish <app>` (or zip deploy).
4. In APIM, import `../eventhub-delivery-policy-fragment.xml` as fragment `aforo-metering-eventhub` (format `rawxml`), then:

   ```xml
   <inbound>
       <base />
       <set-variable name="aforo-delivery-mode" value="eventhub" />
   </inbound>
   <outbound>
       <base />
       <include-fragment fragment-id="aforo-metering" />
       <include-fragment fragment-id="aforo-metering-eventhub" />
   </outbound>
   ```

5. Check: call an API, then look for `aforo-forwarder: accepted=1` in the Function's logs.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| First `az deployment group create` fails on `aforo-metering-logger` with an authorization error | The Data Sender role assignment created in the same deployment has not taken effect yet | Run the deployment again after a few minutes (step 2). |
| Saving the policy fails: logger not found | `aforo-metering-logger` does not exist | Deploy the template (step 2) before importing the fragment. |
| No events reach Aforo, the hub has messages | The Function is not running or cannot read the hub | Check the Function's logs; the identity needs Event Hubs Data Receiver. |
| Logs show `refused with HTTP 401` and the Function keeps retrying | `AFORO_API_KEY` is wrong or lacks `usage:ingest` | Fix the key; the retried run then delivers everything that waited. |
| No messages in the hub | `aforo-delivery-mode` is not `eventhub`, or `aforo-metering-eventhub` is not included after `aforo-metering` | Add both. In eventhub mode `aforo-metering` sends nothing itself. |
| `dropped N event(s): rejected by the ingestor` | Unknown metric or customer | Fix the catalog or the mappings; those events are not retried. |

## Tests

```bash
npm test
```

Runs against the fault-injecting mock ingestor in `aforo-metering-sdks/mock-ingestor/` (set `AFORO_MOCK_INGESTOR` to its `bin/mock-ingestor.mjs` if that repo is not checked out next to this one). Covers recovery from an outage with keys unchanged, an outage that outlasts the retries (the invocation fails; the re-run delivers each event once), 429 with `Retry-After` in both forms, 401, redirects, 413 splits, per-event `retryable`, hung and dripping responses, batching, and the compound endpoint (BUSY / TIMEOUT resends, all-duplicate redelivery, retries that never clear).

## What this does not cover

- It has not run on Azure yet; the Functions binding and the template are checked by `azure-arm-templates/tests/deny-policy.test.cjs` and by reading, not by a deployment.
- Event Hub retention bounds the outage it can absorb (7 days on Standard).
- `log-to-eventhub` itself buffers inside APIM; if Event Hubs is unreachable from APIM for long enough, APIM can still drop messages. That is a smaller window than the ingest path, not zero.
- Linux Consumption is the cheapest plan the template uses; Flex Consumption works too (change the plan resource).
