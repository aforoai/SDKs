# aforo-metering (Apigee shared flow)

An Apigee shared-flow bundle that builds a usage event from each API call and POSTs it to Aforo. The metering step runs in `PostClientFlow`, after the response is returned, so it adds no latency to the API response.

**Version:** 2.0.0 · Apache-2.0 · [Changelog](CHANGELOG.md) · [User guide](USER_GUIDE.md)

> Apigee bundles carry no manifest version field, so the version for this artifact lives in the top-level [`VERSION`](VERSION) file. It matches the version stated here and in the changelog.

## Install

When you run Apigee X / hybrid and want every API call metered into Aforo, deploy this shared flow once and attach it to your API proxies via a Flow Hook (or a `FlowCallout` step).

Intended deployment (once published as a shared artifact):

```bash
apigeecli sharedflows create bundle -n aforo-metering -f apigee/sharedflowbundle --org "$ORG" --token "$TOKEN"
```

> **Not a public registry release — deploy from source.** The bundle in `apigee/sharedflowbundle/` is the source of truth; zip and import it into your org.

From source:

```bash
# 1. Clone the distribution repo
git clone https://github.com/aforoai/SDKs.git
cd SDKs/aforo-gateway-plugins/apigee

# 2. Create the shared flow from the bundle folder (apigeecli zips it for you)
apigeecli sharedflows create bundle \
  --name aforo-metering \
  --folder sharedflowbundle \
  --org "$APIGEE_ORG" \
  --token "$(gcloud auth print-access-token)"

# 3. Deploy the imported revision to your environment
apigeecli sharedflows deploy \
  --name aforo-metering \
  --rev 1 \
  --env "$APIGEE_ENV" \
  --org "$APIGEE_ORG" \
  --token "$(gcloud auth print-access-token)"
```

The bundle expects an organization-scoped KVM named `aforo-metering-config` (see Configuration). Create it before the first call.

## Quickstart

1. Create the **organization-scoped** KVM the bundle reads (`AforoMeteringReadConfig` uses `<Scope>organization</Scope>`, so do not pass `--env`) with the required keys:

```bash
TOKEN="$(gcloud auth print-access-token)"
apigeecli kvms create --name aforo-metering-config --org "$APIGEE_ORG" --token "$TOKEN"
kv() { apigeecli kvms entries create --map aforo-metering-config --org "$APIGEE_ORG" --key "$1" --value "$2" --token "$TOKEN"; }

kv aforo_endpoint  https://api.aforo.ai/v1/ingest/batch
kv api_key         "$AFORO_API_KEY"          # scope usage:ingest; sent as X-API-Key
kv default_metric  api_calls                  # must exist in your Aforo catalog
kv metric_mappings '[{"matchType":"PREFIX","value":"/sms/v1/send","metricName":"sms_sent"}]'
kv jwt_validation_enabled true               # or set customer_id_source (see below)
kv aforo_jwks_uri  https://auth.aforo.ai/.well-known/jwks.json
kv aforo_jwt_issuer https://auth.aforo.ai
```

2. Attach `aforo-metering` to your proxies with a Flow Hook (or a `FlowCallout` step).

3. Call an attached API with an Aforo JWT, then confirm the event under the matching customer + metric in Aforo.

## Configuration

The bundle reads config from the organization-scoped KVM `aforo-metering-config` via `AforoMeteringReadConfig` (cached 300 s).

**Customer identity** comes only from verified sources, in this order:

1. `aforo.customer_id` — the `customer_id` claim of an Aforo JWT verified by `AforoJwtValidation` (requires `jwt_validation_enabled = true`).
2. `customer_id_source = flow_variable:<name>` — a flow variable you know is populated by a verified policy, e.g. `verifyapikey.VerifyKey.app.aforo_customer_id` (a developer-app custom attribute holding the Aforo customer id, available after your `VerifyAPIKey` policy — check the exact variable name in a Debug session). `request.*`, `message.*` and `response.*` variables are refused: they are client-controlled.

`developer.app.name` / `developer.email` are **no longer used**: they are Apigee names, not Aforo customer ids, and the ingestor rejects unknown customers. A call with no resolvable customer is **not sent** (`aforo.skipReason = "no customerId"` in Debug).

| KVM key | Flow variable | Default | What it does |
|---------|---------------|---------|--------------|
| `aforo_endpoint` | `aforo.endpoint` | — | Aforo ingestor batch URL, e.g. `https://api.aforo.ai/v1/ingest/batch`. |
| `api_key` | `private.aforo.apiKey` | — | Aforo API key, scope `usage:ingest`. Sent as `X-API-Key` only — an `Authorization: Bearer` header makes the ingestor answer 401. The tenant comes from the key. |
| `default_metric` | `aforo.defaultMetric` | `api_calls` | Metric for unmapped requests. **Must be registered in the Aforo catalog**; an unknown metric fails the batch with 400. |
| `metric_mappings` | `aforo.metricMappings` | — | JSON array `[{"matchType":"EXACT\|PREFIX\|CONTAINS","value":"/path","metricName":"m"}]`, first match wins, matched against `proxy.basepath + proxy.pathsuffix`. Same semantics as catalog's `/internal/v1/metrics/gateway-mappings` (which Kong fetches; here it is config). |
| `metric_name_pattern` | `aforo.metricNamePattern` | *(unset)* | Legacy `{method} {path}` template, used only when set — route-shaped names are almost never catalog metrics. |
| `customer_id_source` | `aforo.customerIdSource` | *(unset)* | Optional `flow_variable:<name>` fallback, see above. |
| `jwt_validation_enabled` | `aforo.jwtValidationEnabled` | *(off)* | `true` runs the JWT steps. Off by default: they used to run unconditionally and 401 every request without an Aforo JWT. |
| `exclude_paths` | `aforo.excludePaths` | — | Comma-separated path prefixes not to meter (e.g. `/health,/ready`). |
| `exclude_status_codes` | `aforo.excludeStatusCodes` | — | Comma-separated status codes not to meter (e.g. `401,403,429`). |
| `quantity_source` | `aforo.quantitySource` | `1` | `1` per call, or `response_size` (response `Content-Length`). Quantity ≤ 0 is not sent. |
| `include_metadata` | `aforo.includeMetadata` | `true` | `false` omits metadata. |
| `mcp_enabled` / `mcp_product_id` | `aforo.mcpEnabled` / `aforo.mcpProductId` | off | MCP `tools/call` detection (these were read by the JS but never loaded from the KVM). |
| `margin_guard_enabled` / `margin_guard_url` | `aforo.marginGuardEnabled` / `aforo.marginGuardUrl` | off | Margin-guard pre-flight (these were read by the JS but never loaded, so it could not run). Uses the JWT `customer_id`/`tenant_id`. |
| `tenant_id` | `aforo.tenantId` | — | Margin guard only, when the JWT has no `tenant_id`. **Not sent to the ingestor.** |

Never metered: `OPTIONS` (CORS preflights), requests with no customer or a customer id longer than 64 characters, excluded paths/status codes, quantity ≤ 0.

JWT validation reads additional KVM keys via `AforoJwtReadConfig` (only when `jwt_validation_enabled = true`):

| KVM key | What it does |
|---------|--------------|
| `aforo_jwks_uri` | JWKS endpoint for RS256 verification. |
| `aforo_jwt_issuer` | Expected `iss` claim (e.g. `https://auth.aforo.ai`). |
| `aforo_redis_host` / `aforo_redis_port` | Redis for the jti blocklist (optional; the jti-check JS is not wired into the flow — see below). |

## Walk me through it

Step-by-step from KVM setup to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Not verified on a live Apigee org.** The JS is unit-tested with a mock context and the XML is well-formed, but the bundle has not been deployed. Unverified: the `private.` KVM assignment, step conditions, and whether your verified-credential variable names match `customer_id_source`.
- **Phase mixing.** One shared flow runs request-phase steps (JWT validation, margin guard) and response-phase steps (metering). Attached to a post-proxy flow hook, JWT validation and margin guard run after the backend has already served the request; attached pre-proxy, metering has no response. A correct deployment needs two shared flows (pre-proxy: JWT + margin guard; post-client: metering). Not restructured here.
- **Best-effort send.** `AforoMeteringSendEvent` uses `continueOnError="true"` and is not retried; a rejected or failed callout is visible only in Debug.
- **Orphaned JS.** `aforo-compound-metering.js`, `aforo-preflight-quota.js` and `aforo-jwt-jti-check.js` are not referenced by any policy in the flow. Their `apiproxy.consumerkey` (API key) customer fallback was removed, but they remain unwired. `aforo-mcp-metering.js`, an unreferenced duplicate of the MCP branch in `aforo-metering.js`, was removed.
