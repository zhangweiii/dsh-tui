#!/usr/bin/env bash
# Publish @zhangweiii/dsh-tui to npm.
#
# Dist-tag rules:
#   - prerelease versions (containing "-", e.g. 0.3.0-beta.0) publish with the "beta" dist-tag
#   - stable versions (e.g. 0.3.0) publish with the "latest" dist-tag
#
# `npm publish` automatically runs `prepare` (build) and `prepublishOnly` (typecheck + tests),
# so a failing check aborts the release. Pass extra npm flags through, e.g.:
#   scripts/publish.sh --dry-run
set -euo pipefail

cd "$(dirname "$0")/.."

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")

if [[ "$version" == *-* ]]; then
  tag=beta
else
  tag=latest
fi

existing=$(npm view "${name}@${version}" version 2>/dev/null || true)
if [[ -n "$existing" ]]; then
  echo "error: ${name}@${version} is already published on npm; bump the version first" >&2
  exit 1
fi

echo "==> Checking ${name}@${version} (dist-tag: ${tag})"
npm run check

echo "==> Publishing ${name}@${version} with dist-tag '${tag}'"
npm publish --tag "$tag" --access public "$@"

echo "==> Done. Install with: npm install ${name}@${tag}"
