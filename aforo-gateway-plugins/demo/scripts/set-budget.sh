#!/usr/bin/env bash
# Set (or clear) the team budget the demo reads. Writes straight into the
# ingestor's Redis cache, which is where TeamBudgetCacheService looks first --
# customer-service is the real source of truth and is not part of this demo.
#
#   ./set-budget.sh 10     set a limit of 10
#   ./set-budget.sh clear  remove the limit
set -euo pipefail

REDIS_CONTAINER="${REDIS_CONTAINER:-aforo-redis}"
TENANT="${DEMO_TENANT_ID:-test-tenant}"
TEAM="${DEMO_TEAM_ID:-team-001}"
KEY="budget:config:${TENANT}:${TEAM}"

if [[ "${1:-}" == "clear" ]]; then
  docker exec "$REDIS_CONTAINER" redis-cli DEL "$KEY"
  echo "Budget cleared for ${TEAM}."
  exit 0
fi

LIMIT="${1:?usage: set-budget.sh <limit|clear>}"
docker exec "$REDIS_CONTAINER" redis-cli SET "$KEY" \
  "{\"teamId\":\"${TEAM}\",\"customerId\":\"${DEMO_CUSTOMER_ID:-test-customer}\",\"monthlyBudgetLimit\":${LIMIT},\"currency\":\"USD\",\"alertThresholds\":[50,90,100]}" > /dev/null
echo "Budget for ${TEAM} set to ${LIMIT}."
echo "Cached config is read through a short TTL; allow a few seconds to take effect."
