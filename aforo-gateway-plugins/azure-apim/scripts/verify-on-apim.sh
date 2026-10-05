#!/usr/bin/env bash
# verify-on-apim.sh — prove a real Azure API Management instance accepts the
# Aforo metering policy and that it sends the events it should.
#
# What it does, in order:
#   a. creates the four Named Values the policy references
#   b. uploads outbound-policy.xml as fragment "aforo-metering" and a small
#      settings fragment "aforo-metering-config" (format rawxml, the same
#      REST calls org-service's one-click deploy makes)
#   c. creates a throwaway API (or uses API_ID, saving its policy) and
#      includes both fragments in its outbound section
#   d. sends nine calls: 200, 401, 404, 429, 500, /health, OPTIONS, one MCP
#      tools/call, one call with a W3C traceparent
#   e. prints what the ingest endpoint should have received
#   f. removes everything it created and restores the saved policy
#
# It never creates the APIM instance itself. Use a throwaway instance:
# the script refuses to run when the instance already has Aforo metering.
#
# Usage:
#   RESOURCE_GROUP=rg APIM_NAME=my-apim INGEST_URL=https://webhook.site/<id> \
#     ./verify-on-apim.sh run
#   ./verify-on-apim.sh check captured.json RUN_ID   # verify captured bodies
#
# Environment:
#   RESOURCE_GROUP, APIM_NAME   required for "run"
#   INGEST_URL                  required for "run": a throwaway HTTPS endpoint
#                               that records request bodies
#   SUBSCRIPTION_ID             default: the az CLI's current subscription
#   API_ID                      use this existing API instead of creating one.
#                               Its backend must answer GET /status/{code}
#                               with that status and POST /anything with 200.
#   SUBSCRIPTION_KEY            sent as Ocp-Apim-Subscription-Key when set
#   BACKEND_URL                 backend for the throwaway API
#                               (default https://httpbin.org)
#   API_VERSION                 default 2022-08-01 (what org-service uses)
#   KEEP=1                      skip cleanup (to inspect the instance)
#   FORCE=1                     run even if Aforo metering already exists;
#                               existing aforo-* Named Values and fragments
#                               are OVERWRITTEN and then DELETED
#   DRY_RUN=1                   print the management calls, make none
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY_FILE="${POLICY_FILE:-$HERE/../outbound-policy.xml}"
API_VERSION="${API_VERSION:-2022-08-01}"
BACKEND_URL="${BACKEND_URL:-https://httpbin.org}"
FRAGMENT="aforo-metering"
CONFIG_FRAGMENT="aforo-metering-config"
NAMED_VALUES=(aforo-endpoint aforo-api-key aforo-mcp-enabled aforo-mcp-product-id)

die() { echo "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"; }

# ── Expected events ───────────────────────────────────────────────────
# call id | should an event arrive | executionStatus | productType | metricName
expected_rows() {
    cat <<'ROWS'
200|yes|SUCCESS|API|verify_calls
401|no|||
404|yes|VALIDATION_FAILED|API|verify_calls
429|no|||
500|yes|ERROR|API|verify_errors
health|no|||
options|no|||
mcp|yes|SUCCESS|MCP_SERVER|mcp_server.tool_invocations
agentic|yes|SUCCESS|AGENTIC_API|verify_calls
ROWS
}

print_expected() {
    local run="$1"
    echo
    echo "What $INGEST_URL should have received (match on trace.xRequestId):"
    printf '  %-22s %-7s %-18s %-12s %s\n' "trace.xRequestId" "event?" "executionStatus" "productType" "metricName"
    expected_rows | while IFS='|' read -r id want status ptype metric; do
        printf '  %-22s %-7s %-18s %-12s %s\n' "$run-$id" "$want" "${status:--}" "${ptype:--}" "${metric:--}"
    done
    echo "  5 events in total, plus one per warm-up call ($run-warmup, SUCCESS)."
    echo "  401 and 429 are absent: excluded status codes (default)."
    echo "  health is absent: excluded path (default /health,/ready,/metrics)."
    echo "  options is absent: OPTIONS is never metered."
    echo "  500 is verify_errors: the CONTAINS rule in aforo-metric-mappings matched;"
    echo "  the others carry the default metric verify_calls."
    echo "  Every event: customerId is 'verify-customer' (aforo-customer-id from the"
    echo "  $CONFIG_FRAGMENT fragment; the test API has no subscription)."
    echo "  404 is VALIDATION_FAILED, not the default ERROR: the override set in the"
    echo "  $CONFIG_FRAGMENT fragment reached the $FRAGMENT fragment."
    echo "  Every event: occurredAt is an ISO-8601 UTC string, idempotencyKey is the APIM"
    echo "  request id (MCP: mcp:<request id>:search_docs), X-API-Key is"
    echo "  'verify-key', and there is no X-Tenant-Id or Authorization header."
    echo
    echo "Save the captured request bodies (a JSON array, or one JSON document per"
    echo "line) and run:  $0 check <file> $run"
}

# ── check: verify captured bodies offline ─────────────────────────────
check_capture() {
    need jq
    local file="$1" run="$2" bad=0
    [ -r "$file" ] || die "cannot read $file"
    # Accept an array of bodies, or one body per line; a body is {"events":[...]}.
    local events
    events="$(jq -c -s '[.[] | if type == "array" then .[] else . end | (.events // [.])[]]' "$file")" \
        || die "$file is not JSON"
    while IFS='|' read -r id want status ptype metric; do
        local rid="$run-$id" n got_status got_type got_metric got_customer
        n="$(jq --arg r "$rid" '[.[] | select(.trace.xRequestId == $r)] | length' <<<"$events")"
        if [ "$want" = "no" ]; then
            if [ "$n" -ne 0 ]; then echo "FAIL $rid: expected no event, found $n"; bad=$((bad + 1)); else echo "ok   $rid: no event"; fi
            continue
        fi
        if [ "$n" -ne 1 ]; then echo "FAIL $rid: expected 1 event, found $n"; bad=$((bad + 1)); continue; fi
        got_status="$(jq -r --arg r "$rid" '.[] | select(.trace.xRequestId == $r) | .executionStatus // ""' <<<"$events")"
        got_type="$(jq -r --arg r "$rid" '.[] | select(.trace.xRequestId == $r) | .productType // ""' <<<"$events")"
        got_metric="$(jq -r --arg r "$rid" '.[] | select(.trace.xRequestId == $r) | .metricName // ""' <<<"$events")"
        got_customer="$(jq -r --arg r "$rid" '.[] | select(.trace.xRequestId == $r) | .customerId // ""' <<<"$events")"
        local problems=""
        [ "$got_metric" = "$metric" ] || problems="$problems metricName=$got_metric(want $metric)"
        [ "$got_customer" = "verify-customer" ] || problems="$problems customerId=$got_customer(want verify-customer)"
        [ "$got_status" = "$status" ] || problems="$problems executionStatus=$got_status(want $status)"
        [ "$got_type" = "$ptype" ] || problems="$problems productType=${got_type:-none}(want ${ptype:-none})"
        jq -e --arg r "$rid" '.[] | select(.trace.xRequestId == $r) | (.occurredAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*Z$"))' <<<"$events" >/dev/null \
            || problems="$problems occurredAt-not-ISO-UTC"
        jq -e --arg r "$rid" '.[] | select(.trace.xRequestId == $r) | (.idempotencyKey | type == "string" and test("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-"))' <<<"$events" >/dev/null \
            || problems="$problems idempotencyKey-has-no-request-id"
        if [ "$id" = "mcp" ]; then
            jq -e --arg r "$rid" '.[] | select(.trace.xRequestId == $r) | (.toolName == "search_docs" and .agentId == "verify-agent" and (.idempotencyKey | startswith("mcp:")) and (.idempotencyKey | endswith(":search_docs")))' <<<"$events" >/dev/null \
                || problems="$problems mcp-toolName/key"
        fi
        if [ "$id" = "agentic" ]; then
            jq -e --arg r "$rid" '.[] | select(.trace.xRequestId == $r) | .traceId == "4bf92f3577b34da6a3ce929d0e0e4736"' <<<"$events" >/dev/null \
                || problems="$problems traceId"
        fi
        if [ -n "$problems" ]; then echo "FAIL $rid:$problems"; bad=$((bad + 1)); else echo "ok   $rid: $status ${ptype}"; fi
    done < <(expected_rows)
    if [ "$bad" -eq 0 ]; then echo "PASS: the capture matches."; else echo "FAILED: $bad problem(s)."; return 1; fi
}

# ── Management calls ──────────────────────────────────────────────────
# azrest METHOD PATH [BODY_FILE] [IF_MATCH] — PATH is relative to the service.
azrest() {
    local method="$1" rel="$2" body="${3:-}" if_match="${4:-}"
    local sep='?'; case "$rel" in *\?*) sep='&' ;; esac
    local url="$BASE$rel${sep}api-version=$API_VERSION"
    if [ "${DRY_RUN:-}" = "1" ]; then
        echo "DRY_RUN az rest --method $method --url $url${body:+ --body @$body ($(wc -c <"$body" | tr -d ' ') bytes)}" >&2
        echo '{}'
        return 0
    fi
    local headers=()
    [ -n "$body" ] && headers+=("Content-Type=application/json")
    [ -n "$if_match" ] && headers+=("If-Match=$if_match")
    local args=(--method "$method" --url "$url" --only-show-errors)
    [ -n "$body" ] && args+=(--body "@$body")
    [ ${#headers[@]} -gt 0 ] && args+=(--headers "${headers[@]}")
    az rest "${args[@]}"
}

exists() { [ "${DRY_RUN:-}" = "1" ] && return 1; azrest GET "$1" >/dev/null 2>&1; }

# Named Value and fragment writes are long-running (202 + Location on
# api-version 2022-08-01). Wait until the resource can be read back.
wait_for() {
    [ "${DRY_RUN:-}" = "1" ] && return 0
    local rel="$1" i state
    for i in $(seq 1 40); do
        if state="$(azrest GET "$rel" 2>/dev/null | jq -r '.properties.provisioningState // "Succeeded"')"; then
            case "$state" in
                Succeeded) return 0 ;;
                Failed) die "$rel: provisioningState=Failed" ;;
            esac
        fi
        sleep 3
    done
    die "$rel was not readable after 120s"
}

put_named_value() {
    local name="$1" value="$2" secret="$3" body="$TMP/nv-$1.json"
    jq -n --arg n "$name" --arg v "$value" --argjson s "$secret" \
        '{properties: {displayName: $n, value: $v, secret: $s, tags: ["aforo-verify"]}}' >"$body"
    azrest PUT "/namedValues/$name" "$body" >/dev/null
    wait_for "/namedValues/$name"
    echo "  named value $name"
}

put_fragment() {
    local id="$1" xml_file="$2" body="$TMP/fragment-$1.json"
    jq -n --rawfile v "$xml_file" --arg d "Aforo verify-on-apim.sh" \
        '{properties: {format: "rawxml", description: $d, value: $v}}' >"$body"
    azrest PUT "/policyFragments/$id" "$body" >/dev/null
    wait_for "/policyFragments/$id"
    echo "  fragment $id ($(wc -c <"$xml_file" | tr -d ' ') bytes, format rawxml)"
}

cleanup() {
    local code=$?
    set +e
    if [ "${KEEP:-}" = "1" ]; then
        echo "KEEP=1: nothing removed. Run again without KEEP (and with FORCE=1) to clean up."
        rm -rf "$TMP"; exit "$code"
    fi
    echo "Cleaning up..."
    if [ -n "${API_POLICY_TOUCHED:-}" ]; then
        if [ -s "$TMP/api-policy-before.json" ]; then
            azrest PUT "/apis/$API/policies/policy" "$TMP/api-policy-before.json" "*" >/dev/null \
                && echo "  restored the policy of API $API" \
                || echo "  COULD NOT restore the policy of API $API; the original is in $TMP/api-policy-before.json" >&2
        else
            azrest DELETE "/apis/$API/policies/policy" "" "*" >/dev/null && echo "  removed the policy of API $API"
        fi
    fi
    if [ -n "${API_CREATED:-}" ]; then
        azrest DELETE "/apis/$API?deleteRevisions=true" "" "*" >/dev/null && echo "  deleted API $API"
    fi
    sleep 5
    for f in ${FRAGMENTS_CREATED:-}; do
        azrest DELETE "/policyFragments/$f" "" "*" >/dev/null && echo "  deleted fragment $f"
    done
    sleep 5
    for n in ${NAMED_VALUES_CREATED:-}; do
        azrest DELETE "/namedValues/$n" "" "*" >/dev/null && echo "  deleted named value $n"
    done
    if [ -n "${API_POLICY_TOUCHED:-}" ] && [ -s "$TMP/api-policy-before.json" ] && [ "$code" -ne 0 ]; then
        echo "  (kept $TMP for the saved policy)"
    else
        rm -rf "$TMP"
    fi
    exit "$code"
}

run() {
    need jq; need curl
    [ "${DRY_RUN:-}" = "1" ] || need az
    : "${RESOURCE_GROUP:?set RESOURCE_GROUP}" "${APIM_NAME:?set APIM_NAME}" "${INGEST_URL:?set INGEST_URL to a throwaway HTTPS endpoint that records request bodies}"
    case "$INGEST_URL" in https://*) ;; *) die "INGEST_URL must be https" ;; esac
    [ -r "$POLICY_FILE" ] || die "cannot read $POLICY_FILE"

    if [ "${DRY_RUN:-}" = "1" ]; then
        SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-00000000-0000-0000-0000-000000000000}"
    else
        az account show >/dev/null 2>&1 || die "az is not logged in (run: az login)"
        SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}"
    fi
    BASE="https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ApiManagement/service/$APIM_NAME"
    RUN="verify-$(date +%H%M%S)-$RANDOM"
    TMP="$(mktemp -d)"
    NAMED_VALUES_CREATED=""; FRAGMENTS_CREATED=""; API_CREATED=""; API_POLICY_TOUCHED=""
    trap cleanup EXIT

    local service gateway sku
    service="$(azrest GET "")" || die "cannot read APIM instance $APIM_NAME in $RESOURCE_GROUP"
    gateway="$(jq -r '.properties.gatewayUrl // empty' <<<"$service")"
    sku="$(jq -r '.sku.name // "unknown"' <<<"$service")"
    [ "${DRY_RUN:-}" = "1" ] && gateway="https://$APIM_NAME.azure-api.net"
    [ -n "$gateway" ] || die "the instance has no gatewayUrl (still activating?)"
    echo "APIM $APIM_NAME (tier $sku), gateway $gateway, run id $RUN"

    if [ "${FORCE:-}" != "1" ]; then
        for n in "${NAMED_VALUES[@]}"; do
            exists "/namedValues/$n" && die "named value $n already exists: this instance has Aforo metering. Use a throwaway instance, or FORCE=1 (overwrites, then deletes)."
        done
        for f in "$FRAGMENT" "$CONFIG_FRAGMENT"; do
            exists "/policyFragments/$f" && die "fragment $f already exists. Use a throwaway instance, or FORCE=1 (overwrites, then deletes)."
        done
    fi

    echo "a. Named Values"
    NAMED_VALUES_CREATED="${NAMED_VALUES[*]}"
    put_named_value aforo-endpoint "$INGEST_URL" false
    put_named_value aforo-api-key "verify-key" true
    put_named_value aforo-mcp-enabled "true" false
    put_named_value aforo-mcp-product-id "verify-mcp-product" false

    echo "b. Policy fragments"
    # Same cut org-service makes: everything from <fragment> on.
    awk 'f || /^<fragment>/ { f = 1; print }' "$POLICY_FILE" >"$TMP/metering.xml"
    [ -s "$TMP/metering.xml" ] || die "$POLICY_FILE has no <fragment> line"
    cat >"$TMP/config.xml" <<'XML'
<fragment>
    <set-variable name="aforo-metering-config-source" value="verify-on-apim" />
    <set-variable name="aforo-status-outcomes" value="404=VALIDATION_FAILED" />
    <set-variable name="aforo-customer-id" value="verify-customer" />
    <set-variable name="aforo-default-metric" value="verify_calls" />
    <set-variable name="aforo-metric-mappings" value="CONTAINS|/status/500|verify_errors" />
</fragment>
XML
    FRAGMENTS_CREATED="$CONFIG_FRAGMENT $FRAGMENT"
    put_fragment "$CONFIG_FRAGMENT" "$TMP/config.xml"
    put_fragment "$FRAGMENT" "$TMP/metering.xml"

    echo "c. Test API"
    local includes="<include-fragment fragment-id=\"$CONFIG_FRAGMENT\" /><include-fragment fragment-id=\"$FRAGMENT\" />"
    local api_path
    if [ -n "${API_ID:-}" ]; then
        API="$API_ID"
        local current
        current="$(azrest GET "/apis/$API")" || die "API $API not found"
        api_path="$(jq -r '.properties.path // ""' <<<"$current")"
        if azrest GET "/apis/$API/policies/policy?format=rawxml" >"$TMP/api-policy-get.json" 2>/dev/null \
            && [ "${DRY_RUN:-}" != "1" ]; then
            jq '{properties: {format: "rawxml", value: .properties.value}}' "$TMP/api-policy-get.json" >"$TMP/api-policy-before.json"
            jq -r '.properties.value' "$TMP/api-policy-get.json" >"$TMP/api-policy.xml"
            grep -q '</outbound>' "$TMP/api-policy.xml" || die "the policy of API $API has no </outbound>"
            # Insert before the LAST </outbound>.
            awk -v inc="$includes" '{ lines[NR] = $0 } /<\/outbound>/ { last = NR }
                END { for (i = 1; i <= NR; i++) { if (i == last) sub(/<\/outbound>/, inc "</outbound>", lines[i]); print lines[i] } }' \
                "$TMP/api-policy.xml" >"$TMP/api-policy-new.xml"
        else
            : >"$TMP/api-policy-before.json"
            echo "<policies><inbound><base /></inbound><backend><base /></backend><outbound><base />$includes</outbound><on-error><base /></on-error></policies>" >"$TMP/api-policy-new.xml"
        fi
        echo "  using API $API (its policy is saved and restored)"
    else
        API="aforo-$RUN"
        api_path="aforo-$RUN"
        jq -n --arg p "$api_path" --arg b "$BACKEND_URL" \
            '{properties: {displayName: $p, path: $p, protocols: ["https"], serviceUrl: $b, subscriptionRequired: false}}' >"$TMP/api.json"
        API_CREATED=1
        azrest PUT "/apis/$API" "$TMP/api.json" >/dev/null
        wait_for "/apis/$API"
        for m in GET POST; do
            jq -n --arg m "$m" '{properties: {displayName: ($m + " any"), method: $m, urlTemplate: "/*"}}' >"$TMP/op-$m.json"
            azrest PUT "/apis/$API/operations/any-$(echo "$m" | tr '[:upper:]' '[:lower:]')" "$TMP/op-$m.json" >/dev/null
        done
        : >"$TMP/api-policy-before.json"
        echo "<policies><inbound><base /></inbound><backend><base /></backend><outbound><base />$includes</outbound><on-error><base /></on-error></policies>" >"$TMP/api-policy-new.xml"
        echo "  created API $API -> $BACKEND_URL"
    fi
    jq -n --rawfile v "$TMP/api-policy-new.xml" '{properties: {format: "rawxml", value: $v}}' >"$TMP/api-policy-new.json"
    API_POLICY_TOUCHED=1
    azrest PUT "/apis/$API/policies/policy" "$TMP/api-policy-new.json" "*" >/dev/null
    echo "  APIM accepted the policy: both fragments are included in the outbound section"

    if [ "${DRY_RUN:-}" = "1" ]; then
        echo "d. (DRY_RUN) no test calls sent"
        print_expected "$RUN"
        return 0
    fi

    echo "d. Test calls"
    local base_url="$gateway/${api_path#/}"; base_url="${base_url%/}"
    local key_header=()
    [ -n "${SUBSCRIPTION_KEY:-}" ] && key_header=(-H "Ocp-Apim-Subscription-Key: $SUBSCRIPTION_KEY")
    call() { # id method path [curl args...]
        local id="$1" method="$2" p="$3"; shift 3
        local code
        code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 40 -X "$method" "$base_url$p" \
            -H "x-request-id: $RUN-$id" ${key_header[@]+"${key_header[@]}"} "$@" || true)"
        printf '  %-8s %-5s %-16s -> %s\n' "$id" "$method" "$p" "$code"
        LAST_CODE="$code"
    }
    # The gateway takes a little while to pick up a new API and policy.
    local i
    for i in $(seq 1 30); do
        call warmup GET /status/200
        [ "$LAST_CODE" = "200" ] && break
        sleep 5
    done
    [ "$LAST_CODE" = "200" ] || die "GET $base_url/status/200 never returned 200 (last: $LAST_CODE)"
    call 200 GET /status/200
    call 401 GET /status/401
    call 404 GET /status/404
    call 429 GET /status/429
    call 500 GET /status/500
    call health GET /health
    call options OPTIONS /status/200
    call mcp POST /anything -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_docs","arguments":{"q":"x"},"_meta":{"agent_id":"verify-agent"}}}'
    call agentic GET /status/200 -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

    echo "e. Expected"
    print_expected "$RUN"
    echo "Waiting 20s so the last one-way sends leave before cleanup..."
    sleep 20
}

case "${1:-}" in
    run) run ;;
    check) [ $# -eq 3 ] || die "usage: $0 check <captured.json> <run id>"; check_capture "$2" "$3" ;;
    expected) INGEST_URL="${INGEST_URL:-<your ingest endpoint>}"; print_expected "${2:-<run id>}" ;;
    *) sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
