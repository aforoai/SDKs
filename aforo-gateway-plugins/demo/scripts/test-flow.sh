#!/usr/bin/env bash
# End-to-end walk through the demo. Each step prints what it proves.
#
#   ./test-flow.sh
#
# Expects: docker compose up (Kong :8000), and Aforo's usage-ingestor on :8084.
set -uo pipefail

KONG="${KONG_URL:-http://localhost:8000}"
INGESTOR="${INGESTOR_URL:-http://localhost:8084}"
TENANT="${DEMO_TENANT_ID:-test-tenant}"
TEAM="${DEMO_TEAM_ID:-team-001}"
CUSTOMER="${DEMO_CUSTOMER_ID:-test-customer}"
TOKENS="$(dirname "$0")/.tokens.json"

pass=0; fail=0
say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
note() { printf '       %s\n' "$1"; }

[[ -f "$TOKENS" ]] || { echo "Missing $TOKENS — run: node scripts/generate-keys-and-config.js"; exit 1; }
jqp() { python3 -c "import json,sys;print(json.load(open('$TOKENS'))$1)"; }
VALID=$(jqp "['valid']"); FORGED=$(jqp "['forged']"); EXPIRED=$(jqp "['expired']")

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

say "1. No token — Kong must refuse before reaching the backend"
c=$(code "$KONG/api/products")
[[ "$c" == "401" ]] && ok "401 without a token" || bad "expected 401, got $c"

say "2. Forged token (valid claims, wrong signing key)"
c=$(code -H "Authorization: Bearer $FORGED" "$KONG/api/products")
if [[ "$c" == "401" ]]; then ok "401 INVALID_SIGNATURE — forgery rejected"
else bad "expected 401, got $c"; note "signature verification may be disabled — check jwt_public_key"; fi

say "3. Expired token"
c=$(code -H "Authorization: Bearer $EXPIRED" "$KONG/api/products")
[[ "$c" == "401" ]] && ok "401 TOKEN_EXPIRED" || bad "expected 401, got $c"

say "4. Valid token — request proxies to Suchith's backend"
body=$(curl -s -H "Authorization: Bearer $VALID" "$KONG/api/products")
if grep -q '"products"' <<<"$body"; then
  ok "200 with product list"
  who=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['servedTo']['customerId'])" "$body" 2>/dev/null)
  note "backend saw X-Customer-Id=$who (injected by Kong from the verified JWT)"
else bad "no product list returned"; fi

say "5. Generate metered traffic"
for i in $(seq 1 8); do code -H "Authorization: Bearer $VALID" "$KONG/api/products" >/dev/null; done
ok "8 requests sent"
note "waiting for Kong's buffer to flush…"; sleep 5

say "6. Events reached Aforo, attributed to the team"
sum=$(curl -s -H "X-Tenant-Id: $TENANT" \
  "$INGESTOR/api/v1/usage-events/summary-by-team?customerId=$CUSTOMER&from=$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)&to=$(date -u -v+1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '1 day' +%Y-%m-%dT%H:%M:%SZ)")
if grep -q "$TEAM" <<<"$sum"; then
  ok "summary-by-team includes $TEAM"
  note "proves keyId -> :keyid: index -> teamId enrichment worked"
else
  bad "no usage attributed to $TEAM"
  note "check: redis KEYS 'identity_hierarchy:*:keyid:*' and the ingestor's metric policy"
fi

say "7. Budget enforcement (rejection happens at Aforo, not at Kong)"
"$(dirname "$0")/set-budget.sh" 1 >/dev/null 2>&1 || note "could not set budget — is the redis container named aforo-redis?"
sleep 2
direct=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INGESTOR/v1/ingest" \
  -H 'Content-Type: application/json' -H "X-Tenant-Id: $TENANT" \
  -d "{\"customerId\":\"$CUSTOMER\",\"metricName\":\"api_calls\",\"quantity\":99,\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"idempotencyKey\":\"demo-$(date +%s)\",\"metadata\":{\"keyId\":\"$(jqp "['config']['keyId']")\"}}")
if [[ "$direct" == "402" ]]; then ok "402 Budget Exceeded from the ingestor"
else bad "expected 402, got $direct"; fi

kongcode=$(code -H "Authorization: Bearer $VALID" "$KONG/api/products")
if [[ "$kongcode" == "200" ]]; then
  ok "Kong still returns 200 while over budget — expected, and the point below"
  note "metering runs in Kong's log phase, after the response is sent."
  note "inline blocking needs a pre-flight call; see README 'Why Kong does not return 402'."
else note "Kong returned $kongcode"; fi

"$(dirname "$0")/set-budget.sh" clear >/dev/null 2>&1 || true

say "Summary"
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
