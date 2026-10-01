# Aforo metering for Apigee

A shared flow (`sharedflowbundle/`) that sends one usage event per API call to the Aforo usage ingestor.

**Version:** 2.2.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

Apigee bundles have no manifest version field, so the version lives in the [`VERSION`](VERSION) file.

Per call, the flow reads its config from the KVM, builds the event once in `resources/jsc/aforo-metering.js`, sends it, and retries once if the send could not connect or got a 5xx or 408. Both attempts send the same payload and the same `idempotencyKey`, so the retry never bills twice. A metering failure never fails the API call, and adds at most about 4 seconds to it (see [When Aforo ingest is unreachable](#when-aforo-ingest-is-unreachable)).

## Install

**From Aforo (one click).** In Aforo, open the Apigee connection and deploy metering. Aforo imports this bundle as the shared flow `aforo-metering`, deploys it to the connection's environment, writes the KVM entries below, and attaches the flow to that environment's `PostProxyFlowHook`. Deploying again refreshes the KVM every time and imports a new revision only when the bundle changed. Removing it detaches the hook, undeploys the flow and deletes the KVM entries Aforo wrote; the shared flow itself is deleted once no environment has it deployed.

The connection's credential needs permission to manage shared flows, deployments, flow hooks and key value maps (the `Apigee Environment Admin` plus `Apigee API Admin` roles cover it).

Aforo will not replace a shared flow that is already attached to `PostProxyFlowHook` — an environment has one slot. In that case the deploy stops and tells you which flow holds it. Set `meteringAttachMode` to `none` on the connection and call `aforo-metering` yourself with a FlowCallout (from that flow, or from the response PostFlow of the proxies you bill).

**By hand.**

```bash
ORG=my-org; ENV=prod; TOKEN=$(gcloud auth print-access-token)
API=https://apigee.googleapis.com/v1/organizations/$ORG

# 1. Import and deploy the shared flow
(cd apigee && zip -r /tmp/aforo-metering.zip sharedflowbundle)
REV=$(curl -s -X POST "$API/sharedflows?action=import&name=aforo-metering" \
  -H "Authorization: Bearer $TOKEN" -F "file=@/tmp/aforo-metering.zip" | jq -r .revision)
curl -X POST "$API/environments/$ENV/sharedflows/aforo-metering/revisions/$REV/deployments?override=true" \
  -H "Authorization: Bearer $TOKEN"

# 2. Create the organization-scoped KVM and its entries
curl -X POST "$API/keyvaluemaps" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"aforo-metering-config","encrypted":true}'
for kv in "aforo_endpoint=https://api.aforo.ai/v1/ingest/batch" "api_key=$AFORO_API_KEY" "default_metric=api_calls"; do
  curl -X POST "$API/keyvaluemaps/aforo-metering-config/entries" -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -d "{\"name\":\"${kv%%=*}\",\"value\":\"${kv#*=}\"}"
done

# 3. Attach it
curl -X PUT "$API/environments/$ENV/flowhooks/PostProxyFlowHook" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"sharedFlow":"aforo-metering","continueOnError":true}'
```

`apigeecli sharedflows create bundle -n aforo-metering -f apigee/sharedflowbundle` does the same import. [USER_GUIDE.md](USER_GUIDE.md) walks through it step by step.

## Where it runs

Attach the flow on the response path: `PostProxyFlowHook` for every proxy in an environment, or a FlowCallout in a proxy's response PostFlow for one proxy.

It can't run in `PostClientFlow` on Apigee X or hybrid. That flow accepts only FlowCallout, MessageLogging and ServiceCallout, and a shared flow called from it may contain only those; this one reads a KVM and runs JavaScript. So the event is sent before the client gets its response. A healthy ingestor answers in tens of milliseconds, and that is the delay each call sees.

## Who is billed

`customerId` comes from an identity Apigee verified. It is never an API key, a client id, a token or a client IP. Sources, in order:

1. `aforo.customer_id` — the `customer_id` claim of an Aforo JWT that `AforoJwtValidation` verified. Present only when [JWT validation](#jwt-validation) ran.
2. Depending on KVM `customer_id_source`:

| `customer_id_source` | Customer |
|---|---|
| absent, or `consumer` | `developer.app.name`, then `developer.email`, as your `VerifyAPIKey` / `OAuthV2` policy resolved them. The value has to be the customer's id in Aforo. |
| `flow_variable:<name>` | That flow variable, and nothing else. Use one a verified policy fills, e.g. `verifyapikey.VerifyKey.app.aforo_customer_id` (a developer-app custom attribute holding the Aforo customer id). |
| `jwt` | Nothing beyond source 1. |

A `flow_variable:` name is refused when it starts with `request.`, `message.` or `response.` (the client controls those), when it is a client IP, or when its last segment is `client_id`, `consumerkey`, `client_secret`, `apikey`, `access_token`, `password` or similar.

No identity, or one longer than 64 characters: no event is built and no call is made. `aforo.skipReason` is `no customerId`. The ingestor rejects an event for a customer id it does not know.

## Which metric

The first rule that applies:

1. The first `metric_mappings` rule whose `value` matches the path. `matchType` is `EXACT`, `PREFIX` or `CONTAINS`.
2. `metric_name_pattern`, when the KVM has one. Placeholders: `{method}`, `{path}`, `{basepath}`, `{pathsuffix}`.
3. `default_metric`.
4. `api_calls`.

The path is the proxy base path plus the path suffix (`/sms/v1` + `/send`). A name that comes out empty or longer than 255 characters is not sent (`aforo.skipReason`, and a `WARN` line in the debug session).

The ingestor rejects an event whose metric name is not in your Aforo catalog. The flow cannot check that; a rejected event shows up as `USAGE EVENT DROPPED … reason=rejected` with the ingestor's message.

An MCP `tools/call` always uses `mcp_server.tool_invocations`.

## When Aforo ingest is unreachable

The API call still succeeds and its response is unchanged. Every step on the metering path has `continueOnError="true"`, and so does the flow hook. The usage event for that call is not delivered.

The wait is bounded. Each attempt waits at most 1 second to connect and 2 seconds for the response. There is one retry, and only when the first attempt failed to connect or got a 5xx or 408, and failed within 1.2 seconds. Any other 4xx is the ingestor's answer and is not re-sent. A 429 is not re-sent either: waiting for its `Retry-After` would hold the API response, and re-sending at once would ignore it. A response timeout is not retried: an ingestor that accepted the connection and went silent would do the same again.

| Ingest state | Attempts | Delay added to the API call |
|---|---|---|
| Healthy | 1 | tens of milliseconds |
| Unreachable (connect times out) | 2 | about 2 s |
| Unreachable, `max_retries` = `0` | 1 | about 1 s |
| Answers 5xx immediately | 2 | two round trips |
| Accepts the connection, never answers | 1 | about 3 s |
| Upper limit (first attempt fails at 1.2 s, the retry then uses its full 3 s) | 2 | about 4 s |

**The timeouts are fixed.** Apigee accepts only literal values for a ServiceCallout's `connect.timeout.millis`, `io.timeout.millis` and `<Timeout>`; a flow variable is not read there, so they cannot come from the KVM. To change them, edit the two values in `policies/AforoMeteringSendEvent.xml` and `policies/AforoMeteringSendEventRetry1.xml` and redeploy the shared flow. The retry count is configurable: KVM `max_retries`, `0` or `1`.

**The dropped event is recorded.** `AforoMeteringLogDeliveryFailure` prints one line to the debug session (`[aforo-metering] USAGE EVENT DROPPED: messageid=… reason=… last status=… attempts=…`, plus the first 500 characters of the ingestor's response for a 4xx) and sets these flow variables, which a MessageLogging or DataCapture policy in your own flow can read:

| Variable | Value |
|---|---|
| `aforo.meteringDeliveryFailed` | `true` when the event was not delivered |
| `aforo.meteringDeliveryReason` | `unreachable`, `server_error`, `timeout` (408) or `rejected` (any other 4xx) |
| `aforo.meteringDeliveryLastStatus` | last HTTP status, or `no-response` |
| `aforo.meteringDeliveryAttempts` | `1` or `2` |
| `aforo.meteringDeliveryRetryAfter` | the `Retry-After` header of a 429, when there was one |

The flow does not store the event and does not send it later. Usage during an ingest outage is not billed unless you replay it yourself; the `idempotencyKey` is the Apigee `messageid`, so a replay of the same call is deduplicated.

If the KVM is missing or has no `aforo_endpoint`, the flow makes no outbound call and the API call is unaffected.

## Configuration

All settings are entries in the organization-scoped KVM `aforo-metering-config`. The flow caches KVM reads for 300 seconds, so a changed entry takes up to five minutes to apply.

| KVM key | Required | Default | What it does |
|---|---|---|---|
| `aforo_endpoint` | yes | — | Ingest URL the event is posted to: `https://api.aforo.ai/v1/ingest/batch`. |
| `api_key` | yes | — | Aforo API key with scope `usage:ingest`. Sent as `X-API-Key` and nothing else; the ingestor takes the tenant from it. |
| `metric_mappings` | no | — | JSON array `[{"matchType":"EXACT\|PREFIX\|CONTAINS","value":"/path","metricName":"m"}]`. First match wins. See [Which metric](#which-metric). |
| `metric_name_pattern` | no | — | Metric name template, e.g. `{method} {path}`. Used when no mapping matches. The one-click install writes `{method} {path}`. |
| `default_metric` | no | `api_calls` | Metric when no mapping matches and there is no pattern. |
| `customer_id_source` | no | `consumer` | `consumer`, `jwt` or `flow_variable:<name>`. See [Who is billed](#who-is-billed). |
| `product_type` | no | `API` | `productType` on every event, trimmed and upper-cased. See [Product type](#product-type). |
| `quantity_source` | no | `1` | `1` per call, or `response_size` (the response `Content-Length`). Quantity 0 or less is not sent. |
| `include_metadata` | no | `true` | `false` leaves `metadata` off standard events. |
| `exclude_status_codes` | no | `401,403,429` | Comma-separated HTTP status codes that are not metered. |
| `exclude_paths` | no | `/health,/ready,/metrics` | Comma-separated path prefixes that are not metered. |
| `status_outcomes` | no | — | `executionStatus` overrides, e.g. `404=VALIDATION_FAILED,429=ERROR`. See the root README, "Execution status mapping". |
| `max_retries` | no | `1` | Retries after a send that could not connect or got a 5xx or 408: `0` or `1`. A value above 1 is treated as 1, below 0 as 0, anything else as 1. |
| `mcp_enabled` | no | off | `true` turns on MCP `tools/call` detection. |
| `mcp_product_id` | no | — | Recorded as `metadata.productId` on MCP events. |
| `jwt_validation_enabled` | no | — | `true` turns JWT validation on, `false` off. See [JWT validation](#jwt-validation). |
| `aforo_jwks_uri`, `aforo_jwt_issuer` | no | — | JWKS URL and expected `iss` for JWT validation. |
| `margin_guard_enabled`, `margin_guard_url` | no | off | Margin-guard check against the pricing service. Uses the customer and tenant of the verified JWT. |
| `tenant_id` | no | — | Margin guard only, when the JWT has no `tenant_id`. Not sent to the ingestor. |

The flow reads every entry into a `private.aforo.*` variable. Apigee X and hybrid encrypt all KVMs and reject a read into a variable without the `private.` prefix; it also keeps the API key out of debug sessions. For each setting the build script also reads the non-private `aforo.<name>` variable when the KVM has no value, so one proxy can override a setting with an AssignMessage placed before the FlowCallout (`aforo.productType`, `aforo.defaultMetric`, `aforo.mcpEnabled`, …).

`flush_interval_ms` and `flush_count`, which the one-click install also writes, are not read: the flow sends one event per call.

### Product type

Every event carries a top-level `productType`.

| Request | `productType` |
|---|---|
| Any call | KVM `product_type`, default `API` |
| A call with a valid `traceparent` header (or `x-trace-id`), when the configured type is `API` | `AGENTIC_API`, with `traceId` |
| MCP `tools/call` with a tool name and `params._meta.agent_id` | `MCP_SERVER` |
| MCP `tools/call` without `params._meta.agent_id` | the configured type; the ingestor rejects `MCP_SERVER` without an agent |

An event that lacks a field its type requires is not sent, and `aforo.skipReason` names the field. `AI_AGENT` needs an agent id, which has no trusted source outside an MCP payload (`X-Agent-Id` is a client header and is not read). `GRPC_API`, `GRAPHQL_API`, `WEBSOCKET_API` and `MQTT_BROKER` need fields this flow does not see, so setting `product_type` to one of them meters nothing.

### JWT validation

Off unless you turn it on. `AforoJwtValidation` (VerifyJWT, RS256, keys from your JWKS URL, `iss` and `exp` checked) and `AforoJwtAssignHeaders` run when

- `jwt_validation_enabled` is `true`, or
- `aforo_jwks_uri` is set and `jwt_validation_enabled` is not `false`.

With it on, a request without a valid Aforo JWT is rejected with 401, so turn it on only where every caller carries one. It validates the request: attach the flow on the request path (`PreProxyFlowHook` or a request-side FlowCallout), not `PostProxyFlowHook`. Metering needs the response, so that deployment calls the flow twice or splits it; see [What this does not cover](#what-this-does-not-cover).

## Requests that are not metered

A skipped request produces no event and no call to Aforo. The script sets the flow variable `aforo.skip` to `"true"` and `aforo.skipReason` to the reason, builds no payload, and the send, retry and failure-log steps are skipped.

Always skipped: `OPTIONS` requests (CORS preflights), requests with no customer identity, a quantity of 0 or less.

**Status codes.** With no `exclude_status_codes` entry, 401, 403 and 429 are not metered — the same default as Kong and AWS Lambda. A value replaces the default; it does not add to it:

| `exclude_status_codes` | Not metered |
|---|---|
| absent or blank | 401, 403, 429 |
| `404,500` | 404 and 500 only — 401, 403 and 429 are now metered |
| `none` | nothing — every status is metered |

A 401, 403 or 429 that you choose to meter carries `executionStatus: BLOCKED` unless `status_outcomes` says otherwise.

**Paths.** A request is excluded when its path equals an entry or starts with it, so `/health` also excludes `/health/live` (and `/healthz`). The check runs against the proxy path suffix, the base path plus suffix, and the full request path, so an entry may be written with or without the proxy base path. A value replaces the default; `none` excludes nothing.

**Why `none`.** Kong takes an empty array and AWS Lambda an empty environment variable to mean "exclude nothing". An Apigee KVM entry can't be stored empty, and an absent entry has to mean "use the default", so Apigee uses the word `none`.

**Malformed values.** Spaces and empty entries are ignored. A status entry that isn't a whole number from 100 to 599 is ignored. A list with no valid code in it (`abc`) excludes nothing.

MCP tool calls and AGENTIC_API calls follow the same rules as plain API calls.

## What this does not cover

- **Request-phase and response-phase steps share one flow.** JWT validation and margin guard act on the request; metering needs the response. On `PostProxyFlowHook` the first two run after the backend already served the call. If you use them, put those steps in a request-side shared flow of your own and keep this one for metering.
- `aforo-compound-metering.js`, `aforo-preflight-quota.js` and `aforo-jwt-jti-check.js` are in the bundle directory but no policy runs them. The Redis jti blocklist (`aforo_redis_host`, `aforo_redis_port`) is therefore not checked.
- No store-and-forward. An event that could not be delivered after the one retry is logged and dropped.
- With response streaming enabled, Apigee does not expose the response body, so an MCP call that returns a JSON-RPC `error` inside a 2xx is classified from the status alone.

## Tests

```bash
node tests/unit-tests.cjs
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Nothing is metered; `aforo.skipReason` is `no customerId` | No verified identity: no Aforo JWT, no developer app, or `customer_id_source` names a variable that is empty or refused. | Put `VerifyAPIKey` before the flow, or set `customer_id_source` to the flow variable that holds the Aforo customer id. |
| `USAGE EVENT DROPPED … reason=rejected last status=400` | The metric name is not in the Aforo catalog, or the customer id is not an Aforo customer. The line carries the ingestor's message. | Register the metric, fix `metric_mappings` / `default_metric`, or map the app to the right customer id. |
| `USAGE EVENT DROPPED … last status=401` | Wrong `api_key`, or the key lacks scope `usage:ingest`. | Replace the KVM `api_key`. |
| Metric is `GET /orders/42` instead of a catalog metric | `metric_name_pattern` is set and no mapping matched. | Add a `metric_mappings` rule, or delete `metric_name_pattern` so `default_metric` applies. |
| Every request gets 401 | JWT validation is on for callers that send no Aforo JWT. | Set `jwt_validation_enabled` to `false`, or remove `aforo_jwks_uri`. |
| 401/403/429 calls no longer appear in usage | They are excluded by default. | Set `exclude_status_codes` to `none`, or to a list without those codes. |
| Health checks still metered | The path isn't a prefix match for any entry, or a custom `exclude_paths` replaced the default. | Add the path to `exclude_paths`; include `/health` again if you set your own list. |
| API calls are slow while Aforo is down | Each call waits for the send to time out: about 2 s when ingest is unreachable. | Set `max_retries` to `0` to halve it. For less, lower the two timeouts in the send policies and redeploy. |
| Usage is missing for a period | Ingest was unreachable or answered 5xx; those events were dropped. | Look for `USAGE EVENT DROPPED` in a debug session, or log `aforo.meteringDeliveryFailed` from your own flow. |
| A KVM change has no effect | KVM reads are cached for 300 seconds. | Wait five minutes or redeploy the shared flow. |
| No outbound call at all | `aforo_endpoint` or `api_key` is missing, the shared flow isn't deployed to the environment, or it isn't attached. | Check the KVM entries, `GET .../environments/$ENV/sharedflows/aforo-metering/deployments` and `GET .../environments/$ENV/flowhooks/PostProxyFlowHook`; open a debug session and look for `aforo.eventPayload` and `aforo.skipReason`. |
| One-click deploy says the flow hook is taken | Another shared flow is attached to `PostProxyFlowHook`. | Call `aforo-metering` from that flow with a FlowCallout and set `meteringAttachMode` to `none` on the connection. |
