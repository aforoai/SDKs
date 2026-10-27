#!/usr/bin/env bash
# Copies each language's transport core into its variants (wave 5, G271).
#
#   scripts/sync-transport.sh           copy core → every variant
#   scripts/sync-transport.sh --check   fail if any copy differs from its core
#   scripts/sync-transport.sh --check go   (limit to one language: go|node|python|java)
#
# The core is the only place to edit. See contract/TRANSPORT-SPEC.md for why the
# variants carry a copy instead of depending on the core package.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="sync"
ONLY=""
for a in "$@"; do
  case "$a" in
    --check) MODE="check" ;;
    go|node|python|java) ONLY="$a" ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

# language|core dir|variant dir (relative to ROOT)|java package for the copy
PAIRS=(
  "go|go/internal/ingest|go-ws/internal/ingest|"
  "go|go/internal/ingest|go-mqtt/internal/ingest|"
  "go|go/internal/ingest|go-grpc/internal/ingest|"
  "go|go/internal/ingest|go-graphql/internal/ingest|"
  "node|node/src/transport-core|node-ws/src/transport-core|"
  "node|node/src/transport-core|node-mqtt/src/transport-core|"
  "node|node/src/transport-core|node-grpc/src/transport-core|"
  "node|node/src/transport-core|node-graphql/src/transport-core|"
  "node|node/src/transport-core|node-mcp/src/transport-core|"
  "node|node/src/transport-core|node-agent/src/transport-core|"
  "node|node/src/transport-core|mcp-proxy/src/transport-core|"
  "python|python/aforo/_transport|python-ws/aforo_ws_metering/_transport|"
  "python|python/aforo/_transport|python-mqtt/aforo_mqtt_metering/_transport|"
  "python|python/aforo/_transport|python-grpc/aforo_grpc_metering/_transport|"
  "python|python/aforo/_transport|python-graphql/aforo_graphql_metering/_transport|"
  "python|python/aforo/_transport|python-mcp/aforo_mcp_metering/_transport|"
  "python|python/aforo/_transport|python-agent/aforo_agent_metering/_transport|"
  "java|java/src/main/java/com/aforo/metering/internal/transport|java-ws/src/main/java/com/aforo/ws/internal/transport|com.aforo.ws.internal.transport"
  "java|java/src/main/java/com/aforo/metering/internal/transport|java-mqtt/src/main/java/com/aforo/mqtt/internal/transport|com.aforo.mqtt.internal.transport"
  "java|java/src/main/java/com/aforo/metering/internal/transport|java-grpc/src/main/java/com/aforo/grpc/internal/transport|com.aforo.grpc.internal.transport"
  "java|java/src/main/java/com/aforo/metering/internal/transport|java-graphql/src/main/java/com/aforo/graphql/internal/transport|com.aforo.graphql.internal.transport"
)

# Source files only; tests stay with the core.
list_sources() {
  find "$1" -maxdepth 1 -type f \( -name '*.go' -o -name '*.ts' -o -name '*.py' -o -name '*.java' \) \
    ! -name '*_test.go' ! -name '*.test.ts' ! -name 'test_*.py' ! -name '*Test.java' -print | sort
}

# Expected content of the copy: identical, except a Java file's package line.
render() {
  local file="$1" pkg="$2"
  if [[ -n "$pkg" ]]; then
    sed -e "1,/^package /s/^package .*;/package ${pkg};/" "$file"
  else
    cat "$file"
  fi
}

status=0
skipped=0
for pair in "${PAIRS[@]}"; do
  IFS='|' read -r lang core variant pkg <<<"$pair"
  [[ -n "$ONLY" && "$ONLY" != "$lang" ]] && continue
  core_dir="$ROOT/$core"
  var_dir="$ROOT/$variant"
  if [[ ! -d "$core_dir" ]]; then
    echo "MISSING core $core" >&2
    status=1
    skipped=$((skipped + 1))
    continue
  fi
  if [[ "$MODE" == "sync" ]]; then
    mkdir -p "$var_dir"
    # Remove copies whose core file no longer exists.
    while IFS= read -r stale; do
      [[ -z "$stale" ]] && continue
      [[ -f "$core_dir/$(basename "$stale")" ]] || rm -f "$stale"
    done < <(list_sources "$var_dir")
    while IFS= read -r src; do
      render "$src" "$pkg" > "$var_dir/$(basename "$src")"
    done < <(list_sources "$core_dir")
    echo "synced $core -> $variant"
  else
    if [[ ! -d "$var_dir" ]]; then
      echo "MISSING $variant (run scripts/sync-transport.sh)"
      status=1
      continue
    fi
    while IFS= read -r src; do
      dst="$var_dir/$(basename "$src")"
      if [[ ! -f "$dst" ]] || ! diff -q <(render "$src" "$pkg") "$dst" >/dev/null; then
        echo "DIFFERS $variant/$(basename "$src") (edit $core, then run scripts/sync-transport.sh)"
        status=1
      fi
    done < <(list_sources "$core_dir")
    while IFS= read -r dst; do
      [[ -z "$dst" ]] && continue
      [[ -f "$core_dir/$(basename "$dst")" ]] || { echo "EXTRA $variant/$(basename "$dst") (not in $core)"; status=1; }
    done < <(list_sources "$var_dir")
  fi
done

if [[ "$MODE" == "check" && $status -eq 0 ]]; then
  if [[ $skipped -gt 0 ]]; then
    echo "transport copies match their cores (skipped $skipped pair(s) whose core does not exist yet)"
  else
    echo "transport copies match their cores"
  fi
fi
exit $status
