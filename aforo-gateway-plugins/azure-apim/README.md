# Aforo Metering — Azure API Management Policy

Policy fragments that send one usage event to Aforo after each API response: standard API calls, AGENTIC_API calls (W3C `traceparent`) and MCP `tools/call` invocations. Optional fragments add JWT validation, a pre-flight quota check, margin guard and compound metering.

**Version:** 2.2.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

2.2.0 merges two lines of work: the working repository (APIM-valid fragments, `executionStatus`, exclusions, frozen idempotency keys) and public release 2.1.0 (verified customer identity, metric mappings, `productType`). An install made from either one keeps working; see [CHANGELOG.md](CHANGELOG.md) for the two cases that need a line added.

> None of this has run on a live APIM instance in this repository. `node azure-apim/tests/policy.test.cjs` checks format and runs the decision expressions against a mock; only `scripts/verify-on-apim.sh` on a real instance proves APIM accepts the files.

## Files

| File | Fragment id | Include in | Needed |
|---|---|---|---|
| `outbound-policy.xml` | `aforo-metering` | outbound | Yes. The only metering body; org-service's one-click deploy uploads this exact file. |
| `context-policy-fragment.xml` | `aforo-context` | inbound, after `aforo-jwt-validation` | Optional. Fills the settings of `aforo-metering` from Named Values, resolves the customer from a verified JWT or a subscription map, captures the MCP request body. Installs made from 2.1.0 already include it. |
| `jwt-validation-policy.xml` | `aforo-jwt-validation` | inbound, first | Optional. |
| `preflight-quota-policy-fragment.xml` | `aforo-preflight` | inbound | Optional. |
| `margin-guard-policy-fragment.xml` | `aforo-margin-guard` | inbound | Optional. |
| `compound-metering-policy-fragment.xml` | `aforo-compound-metering` | outbound | Optional. |

`policy-fragment.xml` (an older body registered under the same id `aforo-metering`; it sends no `executionStatus`) and `mcp-policy-fragment.xml` (a fragment that included another fragment, which APIM does not allow) are removed. If you imported `policy-fragment.xml`, replace it with `outbound-policy.xml`.

## Named Values

`aforo-metering` references four. All four must exist — APIM refuses to save a policy that references a missing Named Value.

| Named Value | Description |
|---|---|
| `aforo-endpoint` | `https://api.aforo.ai/v1/ingest/batch` |
| `aforo-api-key` | Aforo API key, scope `usage:ingest`. Mark it Secret. Sent as `X-API-Key`; the tenant comes from the key. |
| `aforo-mcp-enabled` | `true` to detect MCP `tools/call` requests, otherwise `false` |
| `aforo-mcp-product-id` | Aforo product ID for the MCP server; `none` when MCP detection is off |

`aforo-tenant-id` is no longer referenced by `aforo-metering` and no `X-Tenant-Id` header goes to the ingestor. An existing Named Value of that name is ignored.

## Install

1. Create the four Named Values.
2. Create a policy fragment with the id `aforo-metering`. Its content is `outbound-policy.xml` **from the `<fragment>` line on** — the comment block above that line is documentation and is not uploaded.
   - Portal: **APIs → Policy fragments → Create**, paste, save.
   - REST: `PUT .../policyFragments/aforo-metering?api-version=2022-08-01` with `{"properties": {"format": "rawxml", "value": "<fragment>..."}}`. The format must be `rawxml`: the policy expressions contain raw `"`, `<` and `&&`, which the default `xml` format rejects. This applies to every file here (2.1.0 shipped entity-escaped files for `--format xml`; these are not).
3. Include it in the outbound section of your API's (or the global) policy:

```xml
<outbound>
    <base />
    <set-variable name="aforo-default-metric" value="api_calls" />
    <include-fragment fragment-id="aforo-metering" />
</outbound>
```

Aforo's one-click deploy (Integrations → Azure APIM → metering) does these steps and adds a second fragment, `aforo-metering-config`, that carries the settings below.

### APIM rules the files follow

| Rule | Source |
|---|---|
| A fragment holds policy statements only. It can't contain `<inbound>`, `<outbound>`, `<backend>`, `<on-error>` or `<base />`; the policy that includes it supplies the section. | [Policy fragments](https://learn.microsoft.com/azure/api-management/policy-fragments) |
| A fragment can't include another fragment. | same page |
| A fragment is at most 512 KB. The Consumption tier limits a policy document to 16 KiB, so the uploaded part of every file here stays under 16 KiB (`outbound-policy.xml`: about 15.2 KB; the test fails above 16 KiB). | same page; [gateway runtime limits](https://learn.microsoft.com/azure/api-management/api-management-gateways-overview#gateway-runtime-limits) |
| `include-fragment` works in inbound, outbound, backend and on-error, at every scope, on every gateway type. | [include-fragment](https://learn.microsoft.com/azure/api-management/include-fragment-policy) |
| `send-one-way-request` works in outbound on the classic, v2, Consumption and self-hosted gateways. | [send-one-way-request](https://learn.microsoft.com/azure/api-management/send-one-way-request-policy) |
| A Named Value is at most 4,096 characters and can't be empty; a policy that names a missing one is not saved. | [Named values](https://learn.microsoft.com/azure/api-management/api-management-howto-properties) |

Two gateway types are outside what Microsoft documents for this policy:

- **Self-hosted gateway**: "Using multiple `send-one-way-request` policies in outbound section is not supported in self-hosted gateway." The fragment has two (one for MCP calls, one for everything else; only one runs per request). Check it on your gateway before relying on it.
- **Workspace gateway**: not in the list of gateways that support `send-one-way-request`.

## Settings

`aforo-metering` reads its settings from **context variables**. Set them before the `include-fragment` (in the same section or in inbound); leave them out to keep the defaults. A value can be a literal or a Named Value reference (`value="{{my-named-value}}"`).

| Context variable | Default | What it does |
|---|---|---|
| `aforo-customer-id` | the APIM subscription id | The Aforo customer billed. See "Customer". |
| `aforo-metric-mappings` | none | `KIND\|value\|metricName` rules separated by `;`. `KIND` is `EXACT`, `PREFIX` or `CONTAINS`, matched against the client-facing path (`context.Request.OriginalUrl.Path`, which includes the API URL suffix). First match wins. Example: `PREFIX\|/sms/v1/send\|sms_sent;EXACT\|/otp/v1/verify\|otp_verified`. |
| `aforo-default-metric` | `METHOD path` | Metric for requests no rule matches, for example `api_calls`. Blank or `none` keeps `METHOD path` (`GET /v1/accounts`). |
| `aforo-product-type` | `API` | `productType` on every event, trimmed and upper-cased. `none` = `API`. |
| `aforo-mcp-body` | read in outbound | The request body captured in inbound, for MCP detection. See "MCP". |
| `aforo-exclude-status-codes` | `401,403,429` | Comma-separated HTTP status codes that are not metered. |
| `aforo-exclude-paths` | `/health,/ready,/metrics` | Comma-separated path prefixes that are not metered. |
| `aforo-status-outcomes` | — | `executionStatus` overrides, e.g. `404=VALIDATION_FAILED,429=ERROR`. Last entry for a code wins. See the repo README, "Execution status mapping". |

**Settings from Named Values (2.1.0 installs).** Include `aforo-context` in inbound. It copies these Named Values into the context variables of the same name, unless a `set-variable` already set one. All five must exist; use `none` to leave one empty. Values must not contain `"` or `\` (they are substituted into C# string literals).

| Named Value (read by `aforo-context`) | Becomes context variable |
|---|---|
| `aforo-subscription-customer-map` — `subscriptionId=customerId` pairs separated by `;` | `aforo-customer-id` (after the JWT claim, see below) |
| `aforo-product-type` | `aforo-product-type` |
| `aforo-metric-mappings` | `aforo-metric-mappings` |
| `aforo-default-metric` | `aforo-default-metric` |
| `aforo-mcp-enabled` | decides whether `aforo-mcp-body` is captured |

APIM policy syntax has no way to read a Named Value that may not exist, so `aforo-metering` itself cannot fall back to these: it would stop saving on every instance that lacks them. That is why the bridge lives in the optional `aforo-context` fragment.

### Metric

Order: a matching rule in `aforo-metric-mappings`, then `aforo-default-metric`, then `METHOD path`. An event whose metric name is empty or longer than 255 characters is not sent (trace, severity warning).

The ingestor checks the metric **name** against your catalog and rejects an unknown one for that event. The policy cannot know the catalog, and `send-one-way-request` discards the response, so a wrong name loses the event with nothing in the APIM trace. `METHOD path` is accepted only when a catalog metric has exactly that name; set `aforo-default-metric`.

### Customer

| Install | `customerId` |
|---|---|
| `aforo-metering` alone | `context.Subscription.Id`. No subscription on the request: no event. |
| You set `aforo-customer-id` yourself | That value. Empty: no event. |
| `aforo-context` included | 1. `aforo-customer-id` set before the fragment; 2. the `customer_id` claim of the JWT that `aforo-jwt-validation` verified; 3. `aforo-subscription-customer-map` looked up by subscription id. None: no event — the subscription id is **not** used as a fallback. |

Never the subscription **key** (a credential), never a request header, never `unknown`. An id longer than 64 characters: no event. Before 2.2.0 the working-repo policy sent the literal `unknown` when a request had no subscription; that event is no longer sent.

The subscription id is only a valid `customerId` when your APIM subscriptions are named after Aforo customer ids. If they are not, use the map or set `aforo-customer-id`.

### Product type

`MCP_SERVER` for a `tools/call` that carries both a tool name and `params._meta.agent_id` (the ingestor requires `agentId` for that type). A `tools/call` without an agent id is still sent with `metricName: mcp_server.tool_invocations` and `toolName`, under the configured type. `AGENTIC_API` when the request has a valid W3C `traceparent` (or an `x-trace-id`). Otherwise the configured type.

A configured type whose required fields a gateway cannot supply (`AI_AGENT`, `MCP_SERVER`, `GRPC_API`, `GRAPHQL_API`, `WEBSOCKET_API`, `MQTT_BROKER`) is not metered, except detected MCP tool calls with an agent id.

### MCP

Detection needs the request body. APIM may not expose it in outbound unless it was read with `preserveContent` in inbound. Either include `aforo-context` (it captures the body when `aforo-mcp-enabled` is `true`), or add this to inbound:

```xml
<set-variable name="aforo-mcp-body" value="@(context.Request.Body != null ? context.Request.Body.As<string>(preserveContent: true) : "")" />
```

Without the variable, `aforo-metering` tries to read the body in outbound and meters the call as a standard API call when it cannot.

## Requests that are not metered

Checked in this order; each sends nothing and, except for exclusions, writes a trace message with source `aforo-metering`:

1. An excluded status code or path (`aforo-skip`).
2. `OPTIONS` (CORS preflight).
3. No customer.
4. A configured product type the gateway cannot supply.
5. A metric name that is empty or longer than 255 characters (standard calls only).

**Status codes.** With no `aforo-exclude-status-codes` variable, 401, 403 and 429 are not metered — the same default as Kong, AWS Lambda and Apigee. A value replaces the default; it does not add to it:

| `aforo-exclude-status-codes` | Not metered |
|---|---|
| not set, or blank | 401, 403, 429 |
| `404,500` | 404 and 500 only — 401, 403 and 429 are now metered |
| `none` | nothing — every status is metered |

A 401, 403 or 429 that you choose to meter carries `executionStatus: BLOCKED` unless `aforo-status-outcomes` says otherwise.

**Paths.** A request is excluded when its path equals an entry or starts with it, so `/health` also excludes `/health/live` (and `/healthz`). The check runs against the current request path, the original client-facing path and the operation's URL template, so an entry may be written with or without the API URL suffix (`/health` or `/orders-api/health`). A value replaces the default; `none` excludes nothing.

**Malformed values.** Spaces and empty entries are ignored. A status entry that isn't a whole number from 100 to 599 is ignored. A list with no valid code in it (`abc`) excludes nothing. A variable of the wrong type is read as text; the expression does not throw.

## Event

`POST` to `aforo-endpoint` with `X-API-Key` only — no `Authorization`, no `X-Tenant-Id`.

```json
{
  "events": [
    {
      "customerId": "cust_123",
      "metricName": "api_calls",
      "quantity": 1,
      "idempotencyKey": "<context.RequestId>",
      "occurredAt": "2026-10-02T10:15:42.3180000Z",
      "productType": "API",
      "endpointPath": "/v1/accounts/123",
      "httpMethod": "GET",
      "statusCode": 200,
      "responseTimeMs": 42,
      "executionStatus": "SUCCESS",
      "trace": { "traceparent": null, "tracestate": null, "xTraceId": null, "xRequestId": null },
      "metadata": { "gateway": "azure-apim", "method": "GET", "path": "/v1/accounts/123", "status": 200, "latency": 42, "subscription": "acme-prod", "operation": "get-account" }
    }
  ]
}
```

`idempotencyKey` is the APIM request id (`mcp:<request id>:<toolName>` for MCP), computed once per request. It never contains a clock value, so a re-sent event deduplicates. An AGENTIC_API event adds `traceId`; an MCP event adds `toolName`, `agentId`, `sessionId` (from `Mcp-Session-Id`) and `executionDurationMs`.

## Optional fragments

The three below read **context variables**, like `aforo-metering`. Release 2.1.0 read the same names as Named Values; if you installed from 2.1.0, add the `set-variable` lines from [CHANGELOG.md](CHANGELOG.md) or these fragments stay switched off. They ignore the exclusion variables.

| Fragment | Context variables |
|---|---|
| `aforo-compound-metering` | `aforo-compound-enabled` (`true`), `aforo-compound-extraction-paths`, `aforo-compound-dimension-paths`, `aforo-ingestor-url` (`https://api.aforo.ai`). Paths are a JSON object (`{"$.usage.prompt_tokens":"input-tokens"}`) or `jsonPath=metricName` pairs separated by `;`. `correlationId` is the APIM request id. |
| `aforo-preflight` | `aforo-preflight-enabled` (`true`), `aforo-preflight-url` (`https://api.aforo.ai/api/v1/quota/check`), `aforo-preflight-fallback` (`ALLOW` or `DENY`, used when the check times out, errors or answers anything but 200). Timeout is 1 second. |
| `aforo-margin-guard` | `aforo-margin-guard-enabled` (`true`), `aforo-margin-guard-url` (pricing-service base URL), `aforo-tenant-id` (used when the JWT has no `tenant_id`). |

All three use the same customer rule as `aforo-metering` (`aforo-customer-id`, else the subscription id; margin guard also accepts the verified JWT's `customer_id` / `sub`). None is sent or checked for `OPTIONS` or without a customer. Compound and preflight send `X-API-Key` from the context variable `aforo-api-key` when it exists, else from the Named Value `aforo-api-key`.

`aforo-jwt-validation` references three Named Values, which must exist: `aforo-jwks-uri`, `aforo-jwt-issuer`, `aforo-org-service-url` (org-service base URL reachable from APIM, for the jti revocation check; it was a hardcoded docker-compose hostname before 2.1.0). The revocation check fails open after 2 seconds.

## What this does not cover

- The response body is never read by `aforo-metering`, so an MCP call that returns a JSON-RPC `error` inside a 2xx is classified from the HTTP status alone.
- There is no retry: `send-one-way-request` reports no failure. A request whose ingest call fails, or whose event the ingestor rejects (unknown metric, unknown customer), is not metered and APIM logs nothing. Retrying would mean `send-request`, which waits for the ingestor before the client gets its response.
- `openid-config` in `aforo-jwt-validation` expects an OpenID Connect discovery document, not a bare JWKS URL. If Aforo serves only a JWKS for your tenant, `validate-jwt` loads no keys; confirm before you enable it.
- Metric mappings are not fetched from the catalog. Keep `aforo-metric-mappings` in step with it by hand or by automation.
- Self-hosted and workspace gateways (see the rules table above).

## Tests

```bash
node azure-apim/tests/policy.test.cjs
```

There is no local APIM runtime. The test checks every `.xml` file is well formed and follows the fragment rules (no section element, no nested fragment, no XML entity inside an expression, no `//` comment inside an attribute expression, uploaded part under 16 KiB), runs the decision expressions from the shipped files against a mock `context` (exclusions, outcome table, customer, metric mappings, MCP detection, product type, and the `aforo-context` resolution), and locks the send gates, the Named Values each file references and the idempotency keys.

It does not prove APIM accepts the files. Only an APIM instance can; the script below does that for `aforo-metering`.

## Check on a real APIM instance

`scripts/verify-on-apim.sh` uploads the policy to an instance, sends test calls and tells you what the ingest endpoint should have received. It needs the Azure CLI (`az login` done), `jq` and `curl`.

| | |
|---|---|
| `RESOURCE_GROUP`, `APIM_NAME` | A **throwaway** APIM instance. The script stops if the instance already has `aforo-*` Named Values or fragments. |
| `INGEST_URL` | A throwaway HTTPS endpoint that records request bodies (a request-bin URL). It stands in for the Aforo ingestor. |

```bash
RESOURCE_GROUP=my-rg APIM_NAME=my-apim INGEST_URL=https://webhook.site/<id> \
  azure-apim/scripts/verify-on-apim.sh run
```

What it does:

1. Creates the four Named Values (`aforo-endpoint` = `INGEST_URL`, MCP detection on).
2. Uploads `outbound-policy.xml` as fragment `aforo-metering` and a small `aforo-metering-config` fragment that sets `aforo-customer-id`, `aforo-default-metric`, one metric mapping and a 404 override — the same two fragments, format and API version as Aforo's one-click deploy.
3. Creates an API `aforo-verify-…` in front of `https://httpbin.org` (no subscription key) and includes both fragments in its outbound section. If APIM rejects the policy, the script stops here with APIM's error.
4. Sends nine calls and prints the table below.
5. Deletes the API, the fragments and the Named Values, also when a step fails.

| Call | Event at `INGEST_URL` | `executionStatus` | `productType` | `metricName` |
|---|---|---|---|---|
| `GET /status/200` | yes | `SUCCESS` | `API` | `verify_calls` |
| `GET /status/401` | no (excluded status) | | | |
| `GET /status/404` | yes | `VALIDATION_FAILED` (override) | `API` | `verify_calls` |
| `GET /status/429` | no (excluded status) | | | |
| `GET /status/500` | yes | `ERROR` | `API` | `verify_errors` (mapping) |
| `GET /health` | no (excluded path) | | | |
| `OPTIONS /status/200` | no | | | |
| `POST /anything` with a `tools/call` body | yes | `SUCCESS` | `MCP_SERVER`, `toolName: search_docs`, `agentId: verify-agent` | `mcp_server.tool_invocations` |
| `GET /status/200` with `traceparent` | yes | `SUCCESS` | `AGENTIC_API` | `verify_calls` |

Every event carries `customerId: verify-customer`. The MCP call is the one that shows whether your gateway lets the outbound section read the request body: the script does not include `aforo-context`.

Each call carries `x-request-id: <run id>-<call>`, which arrives as `trace.xRequestId`. To compare automatically, save the captured bodies (a JSON array, or one document per line) and run:

```bash
azure-apim/scripts/verify-on-apim.sh check captured.json <run id>
```

Other inputs: `API_ID` (use an existing API; its policy is saved and restored; its backend must answer `/status/{code}` and `POST /anything`), `SUBSCRIPTION_KEY`, `BACKEND_URL`, `KEEP=1` (no cleanup), `DRY_RUN=1` (print the management calls, make none).

**Which tier.** Policy fragments, `include-fragment` and `send-one-way-request` are available in every tier ([policy fragments](https://learn.microsoft.com/azure/api-management/policy-fragments), "All API Management tiers"). Use **Consumption**: it has no hourly charge, is billed per call (the run makes fewer than 20), is ready minutes after creation, and has the strictest policy size limit (16 KiB), so a pass there covers the other tiers for size. A Developer instance also works but is billed by the hour from creation and takes 30 minutes or more to activate. Current prices: [API Management pricing](https://azure.microsoft.com/pricing/details/api-management/).

```bash
az apim create --name <globally-unique-name> --resource-group <rg> \
  --publisher-name Aforo --publisher-email you@example.com \
  --sku-name Consumption --location eastus
# ... run the script ...
az apim delete --name <name> --resource-group <rg> --yes
```

The script run itself takes about three minutes. Not covered: the self-hosted and workspace gateways, and MCP servers that APIM exposes through its own MCP feature (the test sends a plain HTTP `POST`).

## W3C Trace Context

The policy captures these headers from inbound requests:
- `traceparent` — W3C trace parent header
- `tracestate` — W3C trace state header
- `x-trace-id` — Legacy trace ID header
- `x-request-id` — Legacy request ID header

Absent headers are emitted as `null` (no synthetic values).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No events at all | No customer: the request has no APIM subscription, `aforo-customer-id` is empty, or (with `aforo-context`) the subscription is not in the map and there is no JWT claim. | Check the APIM trace for `Not metered: no Aforo customer`. Require a subscription, add the subscription to the map, or set `aforo-customer-id`. |
| The trace shows the send, Aforo shows nothing | The ingestor rejected the event: unknown metric name, unknown customer, or a key without `usage:ingest`. | Set `aforo-default-metric` to a catalog metric; check the customer id exists in Aforo. |
| MCP calls are metered as standard API calls | `aforo-mcp-enabled` is not `true`, or the outbound section cannot read the request body. | Capture the body in inbound (see "MCP"). |
| MCP calls arrive with `productType: API` | The request has no `params._meta.agent_id`. | Send the agent id; `MCP_SERVER` requires it. |
| 401/403/429 calls do not appear in usage | They are excluded by default. | Set `aforo-exclude-status-codes` to `none`, or to a list without those codes. |
| Health checks are still metered | No entry is a prefix of the path, or a custom `aforo-exclude-paths` replaced the default. | Add the path; include `/health` again if you set your own list. |
| A setting has no effect | The `set-variable` is after the `include-fragment`, or in a policy scope that runs later. | Move it above the include. |
| Compound, preflight or margin guard stopped after upgrading from 2.1.0 | They read context variables now. | Add the `set-variable` lines from the CHANGELOG. |
| APIM rejects the policy with "named value not found" | A referenced Named Value is missing. | `aforo-metering`: the four above. `aforo-context`: its five. `aforo-jwt-validation`: its three. |
| APIM rejects a fragment with an XML parse error | It was uploaded with format `xml`. | Use format `rawxml`, or paste it in the portal's fragment editor. |
| APIM rejects the fragment with an error about `outbound` or a section element | A copy from before 2026-10-01 wrapped the statements in `<outbound>`. | Upload the current file, from the `<fragment>` line on. |
| Every call bills at full weight on an OUTCOME_BASED plan | The removed `policy-fragment.xml` is still installed. | Re-import `outbound-policy.xml` under fragment id `aforo-metering`. |
