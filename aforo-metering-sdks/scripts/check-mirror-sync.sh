#!/usr/bin/env bash
# Finds SDK changes made directly in the public mirror (wave 5, G318).
#
# This repo is the source; aforoai/SDKs is synced from it by PR (PUBLISHING.md).
# A fix committed straight to the mirror is overwritten by the next sync unless
# it is ported here first. This script compares the mirror's
# aforo-metering-sdks/ (and the workflow files this repo owns) with THIS repo at
# the commit the mirror was last synced from, so anything it reports was changed
# in the mirror after that sync.
#
#   scripts/check-mirror-sync.sh                 clone the mirror's main into a temp dir
#   scripts/check-mirror-sync.sh <mirror-clone>  use an existing clone
#
# Exit 0 = no mirror-side edits, 1 = mirror-side edits (listed), 2 = cannot tell.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [[ $# -ge 1 ]]; then
  MIRROR="$1"
else
  MIRROR="$TMP/mirror"
  git clone -q --filter=blob:none https://github.com/aforoai/SDKs.git "$MIRROR"
fi

# The sync commits are titled "sync: aforo-metering-sdks@<sha> ...".
SYNCED=$(git -C "$MIRROR" log --format=%s | grep -oE 'aforo-metering-sdks@[0-9a-f]{7,40}' | head -1 | cut -d@ -f2 || true)
if [[ -z "$SYNCED" ]]; then
  echo "cannot tell: no 'sync: aforo-metering-sdks@<sha>' commit in the mirror history" >&2
  exit 2
fi
if ! git -C "$ROOT" cat-file -e "${SYNCED}^{commit}" 2>/dev/null; then
  echo "cannot tell: the mirror was synced from ${SYNCED}, which is not in this repo (fetch it first)" >&2
  exit 2
fi

BASE="$TMP/base"
mkdir -p "$BASE"
git -C "$ROOT" archive "$SYNCED" | tar -x -C "$BASE"

EXCLUDES=(-x .git -x .github -x node_modules -x dist -x target -x __pycache__ -x '*.egg-info'
          -x coverage -x .coverage -x .DS_Store -x PUBLISHING.md -x VERSIONING.md -x .pytest_cache)
status=0
if ! out=$(diff -rq "${EXCLUDES[@]}" "$BASE" "$MIRROR/aforo-metering-sdks"); then
  echo "SDK files changed in the mirror after the sync from ${SYNCED}:"
  echo "$out" | sed "s#$BASE#<this repo @${SYNCED}>#; s#$MIRROR/##"
  status=1
fi

# Workflow files this repo owns and the sync copies to the mirror's root.
for wf in publish-npm.yml publish-pypi.yml publish-maven.yml release.yml; do
  if [[ -f "$BASE/.github/workflows/$wf" && -f "$MIRROR/.github/workflows/$wf" ]] &&
     ! diff -q "$BASE/.github/workflows/$wf" "$MIRROR/.github/workflows/$wf" >/dev/null; then
    echo "workflow .github/workflows/$wf differs between the mirror and this repo @${SYNCED}"
    status=1
  fi
done

if [[ $status -eq 0 ]]; then
  echo "no mirror-side SDK edits since the sync from ${SYNCED}"
else
  echo
  echo "Port each change into this repo (or confirm it is intended to be discarded) before the next sync."
fi
exit $status
