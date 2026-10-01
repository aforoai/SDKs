# Aforo Usage Metering — MuleSoft custom policy — User Guide

**Version:** 2.2.0 · **Updated:** 2026-10-02 · **Audience:** engineers who run a Mule 4 API in Anypoint API Manager and want one Aforo usage event per call.

> The package builds and its structure is checked in CI, but it has not been applied on a Mule runtime from this repository. Do Step 5 on a test API before you bill from it.

## What you end up with

The `aforo-metering` policy in your Exchange, applied to one API after MuleSoft's JWT Validation policy. After each response it posts one event to `https://api.aforo.ai/v1/ingest/batch` with the customer id from the verified token. The API response is not changed or delayed.

## Before you start

- A Mule 4 API instance (runtime 4.4.0 or later) in API Manager. Flex Gateway and Mule 3 are not supported.
- JDK 17 and Maven 3.9, if you publish the policy yourself.
- Your Anypoint organization id, and a connected app or user with Exchange Contributor and API Manager "Manage Policies".
- An Aforo API key and your workspace id.
- A metric named `api_calls` in your Aforo catalog, or the name of the metric you want to bill (Step 3).
- Tokens whose `customer_id` (or `sub`) claim is the Aforo customer id.

## Step 1 — Publish the policy to your Exchange

From Aforo: Integrations → your MuleSoft connection → Metering → Deploy. This publishes the policy and applies it; skip to Step 5.

Yourself:

1. Add the Exchange credentials to `~/.m2/settings.xml`:

   ```xml
   <servers>
     <server>
       <id>exchange-server</id>
       <username>~~~Client~~~</username>
       <password>CLIENT_ID~?~CLIENT_SECRET</password>
     </server>
   </servers>
   ```

2. Build and publish:

   ```bash
   cd mulesoft/aforo-metering
   mvn clean deploy -Danypoint.org.id=YOUR_ORG_ID
   ```

> Exchange versions are immutable. If 2.2.0 is already in your Exchange, `mvn deploy` returns 409; raise `<version>` in `pom.xml` (and `VERSION`) to publish a change.

## Step 2 — Apply JWT Validation

In API Manager → your API → Policies, apply MuleSoft's **JWT Validation** policy with your JWKS URL and issuer. The metering policy reads the claims this policy verified. Without it there is no verified customer and nothing is metered.

## Step 3 — Apply Aforo Usage Metering

Policies → Add policy → Custom → **Aforo Usage Metering**. Give it a higher order number than JWT Validation.

| Property | Value |
|---|---|
| `aforo-endpoint` | `https://api.aforo.ai/v1/ingest/batch` |
| `aforo-api-key` | your Aforo API key |
| `aforo-tenant-id` | your workspace id |
| `default-metric` | leave empty for `api_calls`, or the catalog metric to bill |
| `metric-mappings` | optional, e.g. `PREFIX\|/v1/search\|search_calls;EXACT\|/v1/export\|exports` |
| `product-type` | leave empty for `API` |

> The policy cannot check a metric name against your catalog. A name the catalog does not have is rejected by the ingestor for that event, and the runtime logs `usage event rejected by the ingestor, not retried` with the response body.

Every other property is optional; the full list is in the README's Configuration table.

## Step 4 — MCP servers only

Set `mcp-enabled` to `true` and `mcp-product-id` to the Aforo product id. A JSON-RPC `tools/call` POST is then sent as `mcp_server.tool_invocations` with `toolName` from `params.name`.

> `agentId` comes only from `params._meta.agent_id` in the request body. A call without it is sent with the configured `product-type`, not `MCP_SERVER`, because the ingestor rejects an `MCP_SERVER` event with no agent.

## Step 5 — Call the API and check the event

```bash
curl "https://<your-app>.cloudhub.io/v1/accounts/123" \
  -H "Authorization: Bearer <JWT_FOR_cust_legit>"
```

In Aforo, one event: `customerId=cust_legit`, `metricName=api_calls`, `productType=API`, `executionStatus=SUCCESS`, `statusCode=200`.

Then the three checks that matter:

```bash
# A forged header is ignored: the event still carries cust_legit.
curl "https://<your-app>.cloudhub.io/v1/accounts/123" \
  -H "Authorization: Bearer <JWT_FOR_cust_legit>" -H "X-Client-Id: cust_victim"

# No token: 401 from JWT Validation, no event.
curl "https://<your-app>.cloudhub.io/v1/accounts/123"

# Preflight: no event.
curl -X OPTIONS "https://<your-app>.cloudhub.io/v1/accounts/123"
```

The full matrix is [`tests/policy-contract.md`](tests/policy-contract.md).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No events, API calls succeed | JWT Validation is missing or runs after this policy, or the token has neither `customer_id` nor `sub` | Give JWT Validation the lower order number; set `customer-id-claim` to the claim your tokens carry |
| WARN `usage event rejected by the ingestor, not retried: HTTP 400` | Metric name not in the catalog, or unknown customer | Read the body in the log line; fix `default-metric` / `metric-mappings` or create the metric |
| WARN `usage event rejected ... HTTP 401` | Wrong `aforo-api-key` | Replace the key |
| WARN `usage event dropped: the metric name is empty or longer than 255 characters` | A mapping rule with an empty third part, or an over-long name | Fix the rule |
| WARN `usage event not delivered (up to 3 attempts)` | The ingestor was unreachable or answered 5xx / 408 / 429 three times | Check `aforo-endpoint` and egress from the runtime |
| 401 / 403 / 429 calls are missing from usage | Excluded by default | Set `exclude-status-codes` to `none` or to your own list |
| MCP calls arrive as `API` | `mcp-enabled` is off, the body is not a JSON-RPC `tools/call`, or it has no `_meta.agent_id` | Turn it on; send the agent id in `_meta` |
| Policy fails to apply after a configuration change | A value contains a double quote or `$` | Remove it |

## What this guide does not cover

- The specification files next to the package (`mcp-mule-policy.yaml`, `compound-metering-policy.yaml`, `margin-guard-policy.yaml`, `preflight-quota-policy.yaml`, `jwt-validation-config.yaml`). None of them is installable.
- Flex Gateway. Its policies are built with the Policy Development Kit.
- Creating the metric, product and rate plan in Aforo.
