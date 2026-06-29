# 2026-04-15 — JWT/JWKS Validation Across All 5 Gateway Plugins

## Summary

All 5 gateway plugins updated to validate Aforo JWTs cryptographically using JWKS. Replaces the
old opaque-key model (each key pushed to each gateway Admin API) with a JWKS-based model where
gateways verify tokens locally using Aforo's public key.

## Architecture

- Customer calls `POST https://auth.aforo.ai/oauth/token` → short-lived RS256 JWT (15 min)
- JWT signed with Aforo's RSA-2048 private key (never leaves org-service)
- Public key published at `GET https://auth.aforo.ai/.well-known/jwks.json`
- Each gateway caches the public key (1h TTL) and validates JWT signatures locally
- JTI blocklist checked in Redis — fail-open (Redis outage does not block traffic)

## Kong (`kong/handler.lua`, `kong/schema.lua`)

**`handler.lua`** — JWT validation runs in `access()` phase before metering:
- `extract_bearer_token()` — parses `Authorization: Bearer` header
- `base64url_decode()` — converts base64url chars to base64, calls `ngx.decode_base64`
- `parse_jwt_claims()` — decodes header + payload JSON without crypto
- `is_jti_blocked(jti, host, port)` — Redis GET via `resty.redis`, 500ms timeout, fail-open
- `is_client_revoked(keyId, host, port)` — same Redis pattern for client-level revocation
- `verify_rs256_signature()` — uses `lua-resty-jwt` if available; logs warning + passes through if absent (Kong OSS)
- `validate_jwt(token, conf)` — orchestrates: decode → verify sig → check exp/iss → check jti blocklist
- On success: sets `X-Customer-Id`, `X-Tenant-Id`, `X-Key-Id`, `X-Scopes`, `X-Environment` upstream headers

**`schema.lua`** — new config fields:
- `jwt_validation_enabled` (bool, default false) — feature flag
- `jwt_issuer` (string) — expected `iss` claim
- `jwt_jwks_uri` (string) — JWKS endpoint URL
- `jwt_public_key` (string, encrypted) — pre-loaded public key for offline verification
- `jwt_redis_host`, `jwt_redis_port` — Redis connection for jti blocklist

## AWS Lambda Authorizer (`aws-lambda/authorizer.js`)

Zero npm dependencies — uses only Node.js built-in `crypto` module.

- **JWKS caching:** fetched at cold start + on kid-miss, cached in Lambda execution context with configurable TTL
- **RS256 verification:** `crypto.createPublicKey({ format: 'jwk', ... })` + `crypto.createVerify('RSA-SHA256')`
- **kid-miss rotation:** if JWT `kid` not in cache → one JWKS refresh → retry (handles key rotation gracefully)
- **JTI blocklist:** raw TCP Redis via RESP protocol (`RESP2 GET` command) — no `redis` npm package needed
- **IAM policy:** returns wildcard `arn:aws:execute-api:*:*:*` for caching efficiency (API Gateway caches by token)
- **Context:** all JWT claims coerced to strings (API Gateway `$context.authorizer.*` is string-only)

## Apigee (`apigee/sharedflowbundle/`)

New policies:
- **`AforoJwtReadConfig.xml`** — KVM read for JWKS URI, issuer, Redis host/port
- **`AforoJwtValidation.xml`** — Apigee `VerifyJWT` policy: RS256, dynamic JWKS URI from KVM, OutputClaims
- **`AforoJwtAssignHeaders.xml`** — `AssignMessage` setting X-Customer-Id, X-Tenant-Id, X-Key-Id, X-Scopes
- **`aforo-jwt-jti-check.js`** — JavaScript callout building org-service `/internal/token-check` URL for `ServiceCallout`

## Azure APIM (`azure-apim/jwt-validation-policy.xml`)

APIM `<fragment>` (reusable policy):
- `<validate-jwt>` with RSA-based JWKS URL, required claims (`iss`, `customer_id`, `tenant_id`)
- C# inline expression extracts claims and sets variables
- `<send-request>` for jti revocation check with `<set-body>` + fail-open `<choose>` (continue on error)

## MuleSoft (`mulesoft/jwt-validation-config.yaml`)

Anypoint policy descriptor with inline Mule XML flow:
- JWT module `<jwt:validate>` with RSA public key and required claims
- DataWeave claim extraction into flow variables
- HTTP request to Redis/blocklist check
- `<error-handler>` → `<raise-error>` for JWT validation failures (surfaces as 401)
