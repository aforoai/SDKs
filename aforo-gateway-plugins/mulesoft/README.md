# Aforo Usage Metering — MuleSoft custom policy

`aforo-metering/` is a Mule 4 custom policy you publish to your Anypoint Exchange and apply to an API in API Manager. After each response it posts one usage event to Aforo from an async scope, so the API call is not delayed.

**Version**: 2.2.0 (`VERSION` and `aforo-metering/pom.xml` carry the same number). Changes: [CHANGELOG.md](CHANGELOG.md). Step-by-step install: [USER_GUIDE.md](USER_GUIDE.md).

**Not run against a Mule runtime.** The package builds (`mvn clean package`) and its structure is checked, but nobody has applied it in an Anypoint organization from this repository. Run "Verify on your gateway" below before you bill from it.

## What is in this directory

| Path | What it is |
|------|------------|
| `aforo-metering/pom.xml` | Maven project, packaging `mule-policy` |
| `aforo-metering/aforo-metering.yaml` | Policy definition: the configuration form API Manager shows |
| `aforo-metering/src/main/mule/template.xml` | The policy: request capture, the metering script, the retrying send |
| `aforo-metering/mule-artifact.json` | Minimum Mule version (4.4.0) and Java versions (8, 11, 17) |
| `tests/policy.test.cjs` | Structural checks (178) |
| `tests/policy-contract.md` | Behavioural tests to run against a deployed API |
| `mcp-mule-policy.yaml`, `compound-metering-policy.yaml`, `margin-guard-policy.yaml`, `preflight-quota-policy.yaml`, `jwt-validation-config.yaml` | Specifications only. None of them is a package and none can be uploaded to Exchange. |

## Install

There are two routes. Both end with the same asset in your Exchange and the same policy applied in API Manager.

### Route A — from Aforo (one click)

In Aforo, open Integrations → your MuleSoft connection → Metering and choose Deploy. Aforo publishes `aforo-metering` to your Exchange if that version is not there yet, then applies it to every Mule 4 API instance in the connected environment, or updates the configuration where it is already applied. The connection's credentials need the Exchange Contributor and API Manager "Manage Policies" permissions.

### Route B — yourself

You need JDK 17 or later, Maven 3.9, your Anypoint organization id (Access Management → Organization), and a connected app or user with the Exchange Contributor role.

1. Get the sources: clone this repository, or download `aforo-metering-2.2.0-mule-policy.jar` and `aforo-metering.yaml` from the GitHub release if you only want to inspect what will be installed. Publishing with Maven needs the sources.

2. Add your Exchange credentials to `~/.m2/settings.xml`. For a connected app:

   ```xml
   <servers>
     <server>
       <id>exchange-server</id>
       <username>~~~Client~~~</username>
       <password>CLIENT_ID~?~CLIENT_SECRET</password>
     </server>
   </servers>
   ```

3. Build and publish. Exchange only accepts an asset whose group id is your organization id, so pass it:

   ```bash
   cd mulesoft/aforo-metering
   mvn clean deploy -Danypoint.org.id=YOUR_ORG_ID
   ```

   `mvn clean package` alone builds `target/aforo-metering-2.2.0-mule-policy.jar` without publishing. An Exchange version is immutable: to publish a change, raise `<version>` in `pom.xml` first.

4. Apply MuleSoft's **JWT Validation** policy to the API, if it is not there already. The metering policy takes the customer id from the claims that policy verifies.

5. In API Manager open the API instance → Policies → Add policy → Custom → **Aforo Usage Metering**, fill in the configuration below, and apply. Give it a higher order number than JWT Validation so it runs after it.

## Configuration

| Property | What it does | Required |
|----------|--------------|----------|
| `aforo-endpoint` | Ingestor batch URL, e.g. `https://api.aforo.ai/v1/ingest/batch` | Yes |
| `aforo-api-key` | Sent as the `X-API-Key` header. Marked sensitive: masked in API Manager, encrypted on runtimes with gateway encryption on | Yes |
| `aforo-tenant-id` | Your Aforo workspace id. Stamped on every event as `tenantId`. Not sent as a header: the ingestor takes the workspace from the API key | Yes |
| `customer-id-claim` | JWT claim that holds the Aforo customer id | No (default `customer_id`, then `sub`) |
| `tenant-id-claim` | JWT claim that holds the workspace id. Set it only if one API serves several workspaces | No (default: use `aforo-tenant-id`) |
| `mcp-enabled` | Classify JSON-RPC `tools/call` POSTs as MCP tool invocations. Reads the JSON request body | No (default `false`) |
| `mcp-product-id` | Aforo product id of the MCP server | No |
| `status-outcomes` | `executionStatus` overrides, e.g. `404=VALIDATION_FAILED,429=ERROR` (repo README, "Execution status mapping") | No |
| `exclude-status-codes` | Comma-separated status codes that are not metered | No (default `401,403,429`) |
| `exclude-paths` | Comma-separated path prefixes that are not metered | No (default `/health,/ready,/metrics`) |
| `product-type` | `productType` on every event, trimmed and upper-cased | No (default `API`) |
| `default-metric` | Metric name when no mapping rule matches. `{method}` and `{path}` are replaced | No (default `api_calls`) |
| `metric-mappings` | Path-to-metric rules, `KIND\|value\|metricName` separated by `;` | No |
| `quantity-source` | `request_count` sends quantity 1; `response_size` sends the response `Content-Length` in bytes | No (default `request_count`) |
| `include-metadata` | `false` leaves the `metadata` object off the event | No (default: sent) |
| `product_type`, `default_metric`, `quantity_source`, `include_metadata` | Deprecated 2.1.0 names. Each is read only when the hyphenated property above is empty | No |

Values are placed inside quoted strings in the policy, so a value must not contain a double quote or a `$`.

## Metric name and product type

The metric name of a standard or AGENTIC_API event is resolved in this order:

1. The first `metric-mappings` rule that matches the request path. `EXACT` compares the whole path, `PREFIX` its start, `CONTAINS` any part; all three are plain text comparisons, not patterns. Example: `PREFIX|/v1/search|search_calls;EXACT|/v1/export|exports`. A rule that does not have three parts or names another kind is ignored.
2. `default-metric`, `api_calls` when empty.

An MCP tool call always uses `mcp_server.tool_invocations` and quantity 1.

The policy does not know your catalog. A name that is not a metric in your Aforo catalog is rejected by the ingestor for that event; the rejection, with the ingestor's response body, is logged at WARN. A resolved name that is empty or longer than 255 characters is not sent at all (WARN in the runtime log).

Before 2.2.0 the package sent `"{method} {path}"` (for example `GET /v1/accounts/123`) as the metric name. To keep that, set `default-metric` to `{method} {path}`.

`productType` is on every event:

| Request | `productType` |
|---|---|
| MCP `tools/call` whose body names an agent (`params._meta.agent_id`) | `MCP_SERVER` |
| MCP `tools/call` without an agent | `product-type` (the ingestor rejects `MCP_SERVER` without `agentId`) |
| Any other request with a valid `traceparent`, or an `x-trace-id` | `AGENTIC_API` |
| Everything else | `product-type`, `API` when empty |

## Where identity comes from

| Field | Source |
|-------|--------|
| `customerId` | `authentication.properties.claims[customer-id-claim]`, else the `sub` claim. Set by MuleSoft's JWT Validation policy after it verifies the token. When both are empty: `vars.aforo.customerId` |
| `tenantId` | `aforo-tenant-id`, or the `tenant-id-claim` claim when you set one. When that is empty: `vars.aforo.tenantId` |
| `agentId` (MCP) | JSON-RPC `params._meta.agent_id` in the request body |

No request header is read for identity: `X-Client-Id`, `X-Customer-Id`, `X-Tenant-Id` and `?customer_id=` are caller-settable. A request with no verified customer id produces no event, and the API call still goes through. The policy never sends a placeholder (`unknown`, `anonymous`, a client IP, an API key) as the customer. A customer id longer than 64 characters produces no event either.

`vars.aforo.*` is the 2.1.0 identity model: a separate `aforo-jwt-validation` flow sets it from a JWT that flow verified. The policy reads it second, after the gateway's authentication context. Mule 4 does not share variables between policies, so on a stock gateway it is empty and the claims are the only source; do not rely on it for a new install.

## Delivery

The event, including its `idempotencyKey`, is built once. The send is tried up to three times, one second apart, on a transport error, a 5xx, a 408 or a 429; each attempt sends the same bytes, so a redelivery is deduplicated by the ingestor. The wait is fixed: `Retry-After` is not read. Any other 4xx is a permanent rejection: it is not retried, and the status and the first 500 characters of the response body are logged at WARN (`usage event rejected by the ingestor, not retried`). The only credential sent is `X-API-Key`. All of this runs in the async scope after the response has gone back to the caller. After the third failure the event is dropped and the runtime logs `[aforo-metering] usage event not delivered`.

The key is a UUID the policy mints when the request arrives. It is not read from `X-Correlation-Id` or any other header, so a caller cannot make two calls share one key.

## Requests that are not metered

An excluded request produces no event and no call to Aforo: the script returns an empty `events` array, and the policy only sends when the array has an entry. Standard API, AGENTIC_API and MCP tool calls follow the same rules.

Besides the two lists below, these never produce an event: `OPTIONS` requests (CORS preflight), requests with no verified customer, a customer id over 64 characters, and a quantity of 0 (`quantity-source: response_size` on a response with no `Content-Length`). Each is logged at DEBUG as `[aforo-metering] not metered: <reason>`.

**Status codes.** With `exclude-status-codes` left empty, 401, 403 and 429 are not metered — the same default as Kong, AWS Lambda, Apigee and Azure APIM. A value replaces the default; it does not add to it:

| `exclude-status-codes` | Not metered |
|---|---|
| empty | 401, 403, 429 |
| `404,500` | 404 and 500 only — 401, 403 and 429 are now metered |
| `none` | nothing — every status is metered |

A 401, 403 or 429 that you choose to meter carries `executionStatus: BLOCKED` unless `status-outcomes` says otherwise.

**Paths.** A request is excluded when its path equals an entry or starts with it, so `/health` also excludes `/health/live` (and `/healthz`). A value replaces the default; `none` excludes nothing.

**Malformed values.** Spaces and empty entries are ignored. A status entry that isn't a whole number from 100 to 599 is ignored. A list with no valid code in it (`abc`) excludes nothing.

## What is not covered

- **Unhandled flow errors.** If the API's flow ends in an error that propagates out of `execute-next`, the policy's after-phase does not run and the call is not metered. Calls where the flow returns an error status normally (an error handler that sets the status) are metered.
- **Flex Gateway.** This is a Mule runtime policy. Flex Gateway policies are built with the Policy Development Kit and are a different artifact.
- **Mule 3**, and Mule 4 before 4.4.0.
- **Client-ID-only APIs.** Without a JWT there is no verified customer id and nothing is metered.
- **JSON-RPC errors inside a 2xx.** The response body is never read, so an MCP call that returns an `error` object with HTTP 200 is `SUCCESS`.
- **Non-repeatable request streams with `mcp-enabled`.** MCP detection reads the request body before the flow. Mule's default repeatable streams let the flow read it again; an HTTP listener configured with a non-repeatable stream would hand the flow an already-read body. Leave `mcp-enabled` off on such APIs.
- **Compound metering, margin guard, pre-flight quota, the MCP-only variant.** Their YAML files here are specifications, not packages.
- **`Retry-After`.** A 429 from the ingestor is retried after the fixed one-second wait, not after the interval the header names.
- **Response size of chunked responses.** `quantity-source: response_size` reads `Content-Length`; the body is never read.

## Verify on your gateway

Nothing below has been run from this repository.

1. Apply the policy to a test API with only the three required properties. The runtime log must show no template-rendering or DataWeave error for the policy.
2. Send one request with a valid JWT. One event arrives with the token's `customer_id` (or `sub`), your `aforo-tenant-id`, `metricName: api_calls`, `productType: API`, an `executionStatus` and a UTC `occurredAt`.
3. Send one with `X-Client-Id: someone_else`. The event still carries the token's customer.
4. Send one that returns 401 and one to `/health`. No event and no call to the ingestor.
5. Point `aforo-endpoint` at a host that refuses connections. API responses are unchanged and one WARN is logged per request after three attempts.
6. Run the rest of `tests/policy-contract.md`.

## Fail-closed behavior

A request that cannot be attributed to a verified customer is never billed: the script returns an empty `events` array and nothing is sent. The API call itself is never blocked or failed by this policy; request capture and the send both swallow their own errors.

Margin-guard and preflight-quota (specifications) skip their check when there is no customer id.

## W3C Trace Context

The metering policy captures these headers from inbound requests:
- `traceparent` — W3C trace parent header
- `tracestate` — W3C trace state header
- `x-trace-id` — Legacy trace ID header
- `x-request-id` — Legacy request ID header

Absent headers are emitted as `null` (no synthetic values).

## Example requests

```bash
# 1. Standard API request with a valid JWT — metering event attributed to JWT customer_id
curl -X GET "https://your-mulesoft-app.cloudhub.io/v1/accounts/123" \
  -H "Authorization: Bearer <VALID_JWT>" \
  -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" \
  -H "tracestate: congo=t61rcWkgMzE"

# 2. Security regression test — forged X-Client-Id header must be IGNORED
#    (metering event should still attribute to the JWT's customer_id, not
#    the value of X-Client-Id).
curl -X GET "https://your-mulesoft-app.cloudhub.io/v1/accounts/123" \
  -H "Authorization: Bearer <VALID_JWT_FOR_cust_legit>" \
  -H "X-Client-Id: cust_victim"
# Expected: ingestor event carries customerId=cust_legit (the JWT value),
# NOT cust_victim (the header value).

# 3. Request with no JWT — gateway returns 401 (JWT Validation policy fails);
#    nothing is metered.
curl -X GET "https://your-mulesoft-app.cloudhub.io/v1/accounts/123"
# Expected: 401 invalid_token.

# 4. MCP tools/call request with valid JWT
curl -X POST "https://your-mulesoft-app.cloudhub.io/v1/mcp" \
  -H "Authorization: Bearer <VALID_JWT>" \
  -H "Content-Type: application/json" \
  -H "traceparent: 00-abc123-def456-01" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search_docs"}}'
```

## Tests

```bash
node mulesoft/tests/policy.test.cjs            # structure, 178 checks
(cd mulesoft/aforo-metering && mvn clean package)   # assembles the jar
```

The first checks that the package files exist, that `template.xml` and `aforo-metering.yaml` agree on every property, that the send is skipped for an empty `events` array, that the exclusion block matches `mcp-mule-policy.yaml`, that the idempotency keys are untouched, and that the metric, product type, skip and alias rules are in the script. Neither command executes DataWeave or starts a Mule runtime.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `mvn deploy` returns 401 or 403 | The connected app lacks Exchange Contributor, or the `exchange-server` credentials are wrong | Check the `~~~Client~~~` username and the `id~?~secret` password form; add the role |
| `mvn deploy` returns 409 | That version already exists in your Exchange | Raise `<version>` in `pom.xml` |
| `mvn deploy` returns 400 about the group id | `-Danypoint.org.id` missing, so the placeholder group id was sent | Pass your organization id |
| The policy is not listed in API Manager | The API instance is Mule 3 or Flex Gateway, or the asset is in another business group | Use a Mule 4 instance in the organization you published to |
| No events at all, API calls succeed | No verified JWT claims: JWT Validation is not applied, runs after this policy, or the token has neither `customer_id` nor `sub` | Apply JWT Validation with a lower order number; set `customer-id-claim` to the claim your tokens carry |
| 401/403/429 calls do not appear in usage | They are excluded by default | Set `exclude-status-codes` to `none`, or to a list without those codes |
| Health checks are still metered | No entry is a prefix of the path, or a custom `exclude-paths` replaced the default | Add the path; include `/health` again if you set your own list |
| Policy fails to apply after a configuration change | A value contains a double quote | Remove the quote |
| WARN `usage event rejected by the ingestor, not retried: HTTP 400` | The metric name is not in your catalog, or the customer id is unknown | Read the response body in the log line; fix `metric-mappings` / `default-metric`, or create the metric |
| No events for byte-metered APIs | `quantity-source` is `response_size` and the response has no `Content-Length` | Have the API set `Content-Length`, or use `request_count` |

## Upgrading from the pre-package files

Earlier releases shipped `mule-policy.yaml` and a root `template.xml` that could not be uploaded to Exchange. If you built your own policy from them:

1. Publish `aforo-metering` (Route A or B) and apply it.
2. Remove your hand-built policy from the API.
3. Property names are unchanged. `customer-id-claim` and `tenant-id-claim` are new and optional. The 2.1.0 `product-type` property works as before; the `${product_type}`, `${default_metric}`, `${quantity_source}` and `${include_metadata}` placeholders of the old `template.xml` are policy properties now (same names, and hyphenated names that win when both are set). `${api_key}` and `${aforo_endpoint}` are `aforo-api-key` and `aforo-endpoint`.
4. `tenantId` is now your configured `aforo-tenant-id` unless you set `tenant-id-claim`. `metricName` is `api_calls` unless you configure it (see "Metric name and product type").
