#!/usr/bin/env bash
# Applies the World ID 4.0 fix (docs/WORLD-V4-FIX.md) to a new-friendship-tech checkout.
# Run from the repo root with a clean tree:  bash apply-world-fix.sh
set -euo pipefail

SOURCE=https://github.com/don-radman/new-friendship-tech-ens-world.git
BRANCH=fix/world-v4-one-time-proofs

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Uncommitted changes. Commit or stash them first." >&2
  exit 1
fi

echo "Fetching $BRANCH"
git fetch "$SOURCE" "$BRANCH"

echo "Merging"
if ! git merge --no-edit FETCH_HEAD; then
  echo "Merge conflict. Resolve it (keep both sides where they differ), commit, then rerun the checks below." >&2
  exit 1
fi

[ -d node_modules ] || npm ci

echo "Typecheck"
npm run typecheck
echo "World tests"
npx vitest run tests/world-live.test.ts tests/world.test.ts tests/trips.test.ts

cat <<'NEXT'

World fix applied and checked.
Next:
  1. World Developer Portal: action "trip-activate" exists in production (no approval action needed).
  2. Deploy app and worker together.
  3. Real phone: two trips in a row, then link the concierge and approve two actions.
Details: docs/WORLD-V4-FIX.md
NEXT
