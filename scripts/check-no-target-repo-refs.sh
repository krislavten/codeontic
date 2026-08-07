#!/usr/bin/env bash
# Static check (Proposal 010 §5.2 铁律): the main-repo `test/` tree must not
# import anything from a target-repo-specific path. This repo is public, so the
# path pattern is NOT tracked here (a committed list of internal paths would
# itself be the leak) — the maintainer supplies it via CODEONTIC_DENY_PATH_PATTERN
# (grep -E syntax) in private CI / local env; unset → the check is skipped. Once
# adapters live in the target repo (Proposal 010), the main repo's tests should
# only exercise the engine against synthetic fixtures — a violation here means
# main-repo CI and a target repo's CI are no longer physically decoupled.
#
# Baseline handling (sparring CONCERNS, Proposal 011 §5): during the T1-T13
# migration window this legitimately starts non-zero (target-repo adapter
# tests still live here until T13 moves them out). `--update-baseline` records
# the current violation set as the accepted baseline; a plain run FAILS if
# violations exceed the baseline (catches NEW violations immediately, doesn't
# wait for the final T13 cleanup to catch a regression introduced in T5-T11).
set -euo pipefail

cd "$(dirname "$0")/.."

BASELINE_FILE="scripts/baseline-violations.json"
PATTERN="${CODEONTIC_DENY_PATH_PATTERN:-}"
if [ -z "$PATTERN" ]; then
  echo "target-repo-path check skipped: CODEONTIC_DENY_PATH_PATTERN not set (public CI runs without the private denylist)"
  exit 0
fi

# Grep the test/ tree for import specifiers matching the pattern. `-l` lists
# matching files; count matched lines (not files) so the baseline is stable
# even if a single file gains/loses one reference among several.
violations=$(grep -rnE "$PATTERN" test/ --include='*.ts' | grep -E "^\S+:\d+:.*(import|require)" || true)
count=$(printf '%s\n' "$violations" | grep -c . || true)

if [ "${1:-}" = "--update-baseline" ]; then
  printf '{"count": %d, "generatedAt": "%s"}\n' "$count" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$BASELINE_FILE"
  echo "baseline updated: $count violation(s) recorded in $BASELINE_FILE"
  exit 0
fi

if [ ! -f "$BASELINE_FILE" ]; then
  echo "no baseline recorded — run '$0 --update-baseline' once to establish one" >&2
  exit 1
fi

baseline_count=$(node -e "console.log(require('./$BASELINE_FILE').count)")

if [ "$count" -gt "$baseline_count" ]; then
  echo "❌ target-repo-path violations in test/: $count (baseline: $baseline_count) — NEW violation introduced" >&2
  printf '%s\n' "$violations" >&2
  exit 1
fi

echo "✅ target-repo-path violations in test/: $count (baseline: $baseline_count, no regression)"
