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

1. Create the KVM with the three values every Aforo artifact needs — `aforo_endpoint`, `api_key`, `tenant_id`:

```bash
apigeecli kvms entries create \
  --map aforo-metering-config \
  --org "$APIGEE_ORG" --env "$APIGEE_ENV" \
  --key aforo_endpoint --value https://ingest.aforo.ai/v1/ingest/batch \
  --token "$(gcloud auth print-access-token)"

apigeecli kvms entries create --map aforo-metering-config \
  --org "$APIGEE_ORG" --env "$APIGEE_ENV" \
  --key api_key --value "$AFORO_API_KEY" \
  --token "$(gcloud auth print-access-token)"

apigeecli kvms entries create --map aforo-metering-config \
  --org "$APIGEE_ORG" --env "$APIGEE_ENV" \
  --key tenant_id --value "$AFORO_TENANT_ID" \
  --token "$(gcloud auth print-access-token)"
```

2. Attach `aforo-metering` to your proxies with a Flow Hook on `PostProxyFlowHook` (or add a `FlowCallout` step that references the shared flow).

3. Call any attached API, then confirm the event under the matching customer + metric in Aforo.

## Configuration

The bundle reads config from the organization-scoped KVM `aforo-metering-config` via the `AforoMeteringReadConfig` policy (cached 300 s). The customer identity is `developer.app.name` (falling back to `developer.email`) — both gateway-managed, not client-settable.

| KVM key | Used as | Default (if unset) | What it does |
|---------|---------|--------------------|--------------|
| `aforo_endpoint` | `aforo.endpoint` → ServiceCallout URL | — | Aforo ingestor batch URL. Use `https://ingest.aforo.ai/v1/ingest/batch`. |
| `api_key` | `aforo.apiKey` → `Authorization: Bearer` | — | Aforo API key sent on the callout. |
| `tenant_id` | `aforo.tenantId` → `X-Tenant-Id` header | — | Aforo tenant identifier sent on the callout. |
| `metric_name_pattern` | `aforo.metricNamePattern` | `{method} {path}` | Metric-name template. Variables: `{method}`, `{path}`. |
| `quantity_source` | `aforo.quantitySource` | `1` (in code) | Quantity source. The JS emits `quantity: 1` per event. |
| `customer_id_source` | `aforo.customerIdSource` | `consumer` | Identity source. The JS uses `developer.app.name`/`developer.email`; request headers are never read. |
| `exclude_paths` | `aforo.excludePaths` | — | Paths to exclude from metering. |
| `exclude_status_codes` | `aforo.excludeStatusCodes` | — | Status codes to exclude from metering. |
| `include_metadata` | `aforo.includeMetadata` | `true` | Include request metadata in the event payload. |

JWT validation (optional) reads additional KVM keys via `AforoJwtReadConfig`:

| KVM key | What it does |
|---------|--------------|
| `aforo_jwks_uri` | JWKS endpoint for RS256 verification (e.g. `https://auth.smartai.com/.well-known/jwks.json`). |
| `aforo_jwt_issuer` | Expected `iss` claim (e.g. `https://auth.aforo.ai`). |
| `aforo_redis_host` | Redis host for the jti blocklist (optional). |
| `aforo_redis_port` | Redis port for the jti blocklist (optional, default 6379). |

> Set the flow variable `aforo.jwt_validation_enabled = "false"` in KVM to skip the JWT steps. When enabled, `AforoJwtValidation` runs RS256 + `exp` + `iss` checks via the Apigee built-in before metering, and `AforoJwtAssignHeaders` sets `X-Customer-Id`/`X-Tenant-Id`/`X-Key-Id`/`X-Scopes` from the verified claims.

## Walk me through it

Step-by-step from KVM setup to a verified event in Aforo: see [USER_GUIDE.md](USER_GUIDE.md).

## What this doesn't cover

- **Quantity is fixed at 1 per call in the JS.** `quantity_source` exists in KVM and is read into `aforo.quantitySource`, but `aforo-metering.js` emits `quantity: 1` for standard requests. To bill by response size, post-process in Aforo or extend the JS — the source code is the contract.
- **Best-effort send.** `AforoMeteringSendEvent` uses `continueOnError="true"`, so a failed callout to the ingestor never affects the API response — and is not retried within the shared flow. This is fire-and-forget metering.
- **Apigee's built-in JWT policy resolves the issuer + JWKS**, but the jti-blocklist and client-revocation logic in `aforo-jwt-jti-check.js` requires the optional Redis KVM keys; without them only `exp`/`iss`/signature run.
