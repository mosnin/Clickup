#!/usr/bin/env bash

set -euo pipefail

# Vercel skips a deployment when this command exits successfully. Keep
# documentation and automation-only commits from consuming a production build,
# while treating every application or configuration change as build-worthy.
if git diff --quiet HEAD^ HEAD -- \
  src \
  convex \
  mcp \
  public \
  plugins \
  package.json \
  package-lock.json \
  capacitor.config.ts \
  eslint.config.mjs \
  next.config.mjs \
  postcss.config.mjs \
  tsconfig.json \
  vitest.config.ts \
  scripts/vercel-build.sh; then
  echo "No production runtime changes detected; skipping this Vercel build."
  exit 0
fi

echo "Production runtime changes detected; continuing with the Vercel build."
exit 1
