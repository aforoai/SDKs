# Aforo Apigee Pub/Sub forwarder

**Version:** 3.1.2 · Apache-2.0 · ships with the Apigee shared flows 3.1.2

Use this when an ingest outage or a `429` must not cost you usage. In the default `async` mode, `aforo-metering` posts each call's events with a ServiceCallout that nobody waits for: an event the ingestor does not store is lost and nothing logs it. With `delivery_mode = pubsub` the flow publishes each call's events to a Pub/Sub topic instead, and this service reads a pull subscription, sends the events to the Aforo ingestor in batches, and acks a message only after the ingestor accepted (or permanently rejected) its events. While the ingestor is down, messages wait in the subscription (7 days by default) and are redelivered.

```
Apigee ──PublishMessage──► topic ──pull subscription──► forwarder (Cloud Run) ──POST /v1/ingest/batch──► Aforo
        (AforoMeteringPublish)        ack after 2xx                                  X-API-Key, retries
```

## What it does with each batch

The forwarder collects up to `AFORO_BATCH_MAX_MESSAGES` messages (or waits `AFORO_BATCH_MAX_WAIT_MS` after the first), then sends their events in requests of at most 500 events and 4 MiB. One batch is in flight at a time.

| Ingestor answer | Forwarder |
|---|---|
| 2xx | done, messages acked; events named in `errors[]` with `retryable: true` are re-sent with the same keys (at most `AFORO_MAX_RETRIES` times), the rest are dropped and logged with their keys |
| 408, 429, 5xx, network error, timeout | retried with full jitter (base 500 ms, max 30 s), `Retry-After` honoured (seconds or HTTP-date, cap 60 s); after `AFORO_MAX_RETRIES` the batch is an outage |
| 413 | split in half; a single event that still gets 413 is dropped and logged |
| 401, 403, any 3xx | outage at once (a wrong key or URL must not lose usage); redirects are never followed |
| other 4xx | dropped and logged with its keys |

On an outage every message of the batch is **nacked**: Pub/Sub redelivers it after the subscription's retry delay. The forwarder then pauses for `max(250 ms, random(0, 5 s · 2^n))`, capped at 5 min, reset by the next successful batch. Events the ingestor already accepted are sent again on redelivery and deduplicated by the ingestor: the flow sets `idempotencyKey` to Apigee's `messageid`, which is the same on every redelivery.

A message that is not JSON or has no `events` array can never be delivered; it is acked and logged. The API key is sent only as `X-API-Key` and never logged.

On `SIGTERM` (Cloud Run gives 10 s) it stops reading, flushes for up to `AFORO_SHUTDOWN_MS`, and nacks what is left so another instance picks it up.

## Settings (environment variables)

| Variable | Default | |
|---|---|---|
| `AFORO_API_KEY` | — (required) | Aforo key with scope `usage:ingest`. Mount it from Secret Manager. |
| `AFORO_PUBSUB_SUBSCRIPTION` | — (required) | `projects/{project}/subscriptions/{subscription}` |
| `AFORO_INGEST_URL` | `https://api.aforo.ai/v1/ingest/batch` | https only (http allowed for localhost or with `AFORO_ALLOW_INSECURE_HTTP=true`) |
| `AFORO_BATCH_MAX_MESSAGES` | 500 | messages per batch, at most 1000; flow control holds twice that (at least 1000) |
| `AFORO_BATCH_MAX_WAIT_MS` | 1000 | how long the first message of a batch waits for more |
| `AFORO_BATCH_MAX_EVENTS` | 500 | events per request, at most 1000 |
| `AFORO_REQUEST_TIMEOUT_MS` | 10000 | total per request, response body included |
| `AFORO_MAX_RETRIES` | 5 | |
| `AFORO_FLUSH_BUDGET_MS` | 120000 | longest one batch may take before it counts as an outage |
| `AFORO_SHUTDOWN_MS` | 8000 | keep below Cloud Run's 10 s termination grace |

## Install

Run these in the Google Cloud project of your Apigee X org.

1. Topic and subscription. The retry policy is what spaces out redeliveries during an outage; without it Pub/Sub redelivers at once.

   ```bash
   gcloud pubsub topics create aforo-metering
   gcloud pubsub subscriptions create aforo-metering-forwarder --topic aforo-metering \
     --ack-deadline 60 --message-retention-duration 7d \
     --min-retry-delay 10s --max-retry-delay 600s
   ```

2. Service accounts:

   ```bash
   gcloud iam service-accounts create aforo-apigee-publisher
   gcloud pubsub topics add-iam-policy-binding aforo-metering \
     --member serviceAccount:aforo-apigee-publisher@$PROJECT.iam.gserviceaccount.com --role roles/pubsub.publisher
   gcloud iam service-accounts create aforo-forwarder
   gcloud pubsub subscriptions add-iam-policy-binding aforo-metering-forwarder \
     --member serviceAccount:aforo-forwarder@$PROJECT.iam.gserviceaccount.com --role roles/pubsub.subscriber
   ```

3. The API key in Secret Manager (`aforo-api-key`), readable by `aforo-forwarder` (`roles/secretmanager.secretAccessor`).

4. Deploy the forwarder. A pull subscriber works between HTTP requests, so CPU must stay allocated and one instance must stay up:

   ```bash
   gcloud run deploy aforo-apigee-pubsub-forwarder --source . --region $REGION \
     --service-account aforo-forwarder@$PROJECT.iam.gserviceaccount.com \
     --no-allow-unauthenticated --no-cpu-throttling --min-instances 1 --max-instances 3 \
     --set-env-vars AFORO_PUBSUB_SUBSCRIPTION=projects/$PROJECT/subscriptions/aforo-metering-forwarder \
     --set-secrets AFORO_API_KEY=aforo-api-key:latest
   ```

5. Redeploy `aforo-metering` with the publisher service account (PublishMessage authenticates as the deployment's service account). Your user needs `iam.serviceAccounts.actAs` on it:

   ```bash
   curl -X POST -H "Authorization: Bearer $TOKEN" \
     "https://apigee.googleapis.com/v1/organizations/$ORG/environments/$ENV/sharedflows/aforo-metering/revisions/$REV/deployments?override=true&serviceAccount=aforo-apigee-publisher@$PROJECT.iam.gserviceaccount.com"
   ```

6. KVM: `pubsub_topic = projects/$PROJECT/topics/aforo-metering`, then `delivery_mode = pubsub`. Set the topic first: `pubsub` without a topic falls back to `async`.

7. Check: call an API, then look for `aforo-forwarder: messages=1 accepted=1` in the service's logs.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Messages pile up in the subscription | The service is not running, or runs with CPU throttling | `--no-cpu-throttling --min-instances 1`; check the service's logs |
| Logs show `refused with HTTP 401` and messages keep coming back | `AFORO_API_KEY` is wrong or lacks `usage:ingest` | Fix the secret and redeploy; the waiting messages are then delivered |
| Nothing in the topic | `delivery_mode` is not `pubsub`, `pubsub_topic` is missing, or the shared flow was deployed without the publisher service account | Debug the call: the `AforoMeteringPublish` step must run and not fail |
| `dropped N event(s): rejected by the ingestor` | Unknown metric or customer | Fix the catalog or the KVM mappings; those events are not retried |

## Tests

```bash
node --test tests/*.test.js      # no npm install; Node 22+ (the runtime the service needs)
```

They run against the fault-injecting mock ingestor in `aforo-metering-sdks/mock-ingestor/` (set `AFORO_MOCK_INGESTOR` to its `bin/mock-ingestor.mjs` if that repo is not checked out next to this one), and drive the subscriber with a fake subscription: outage → nack → redelivery accepted once per key, 429 `Retry-After` in both forms, 401, redirects, 413 splits, per-event `retryable`, hung and dripping responses, the breaker, one flusher at a time, and shutdown.

## What this does not cover

- It has not run on Google Cloud yet. `server.js` (the `@google-cloud/pubsub` wiring, flow control, the Cloud Run lifecycle) is not exercised by the tests; only the batching and delivery logic is.
- A failed publish inside Apigee (Pub/Sub unreachable, missing permission) loses that call's events, as `async` does. The publish is far less likely to fail than an ingest call, but it is not zero.
- Subscription retention (7 days here) bounds the outage it can absorb.
