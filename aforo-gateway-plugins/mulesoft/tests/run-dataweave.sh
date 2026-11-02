#!/usr/bin/env bash
# Runs tests/dataweave.test.cjs with the open-source DataWeave CLI.
#
# The CLI ships as a linux-x86_64 native binary: it is downloaded once
# (pinned version, SHA-256 checked) into $AFORO_DW_CACHE (default
# ~/.cache/aforo-dw-cli) and run inside node:22-bookworm-slim as linux/amd64,
# which also works on Apple silicon (Docker's amd64 emulation).
#
# On a linux-x86_64 machine with node installed you can skip Docker:
#   DW_BIN=/path/to/dw node mulesoft/tests/dataweave.test.cjs
set -euo pipefail

DW_VERSION=2.12.3
DW_SHA256=e99fc66ca7922e7ba8a780ef24557fff3367ce129460e778d58ed05ae1b4950c
DW_URL="https://github.com/mulesoft/data-weave-cli/releases/download/v${DW_VERSION}/dw-cli-${DW_VERSION}-linux-x86_64.zip"

here="$(cd "$(dirname "$0")" && pwd)"
plugins="$(cd "$here/../.." && pwd)"
cache="${AFORO_DW_CACHE:-$HOME/.cache/aforo-dw-cli}/${DW_VERSION}"

if [ ! -x "$cache/bin/dw" ]; then
    mkdir -p "$cache"
    zip="$cache/dw-cli.zip"
    curl -fsSL --retry 3 -o "$zip" "$DW_URL"
    if command -v sha256sum >/dev/null 2>&1; then
        echo "${DW_SHA256}  ${zip}" | sha256sum -c -
    else
        echo "${DW_SHA256}  ${zip}" | shasum -a 256 -c -
    fi
    unzip -q -o "$zip" -d "$cache"
    rm -f "$zip"
fi

exec docker run --rm --platform linux/amd64 \
    -v "$plugins":/src -v "$cache":/opt/dw:ro \
    -e DW_BIN=/opt/dw/bin/dw -e DW_HOME=/tmp/dw-home -e DW_DEBUG="${DW_DEBUG:-}" \
    -w /src node:22-bookworm-slim \
    sh -c 'mkdir -p /tmp/dw-home && node mulesoft/tests/dataweave.test.cjs'
