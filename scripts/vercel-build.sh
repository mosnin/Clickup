#!/usr/bin/env bash

set -o pipefail

# Explicit frontend-only releases reuse the configured backend. Use only when
# the release contains no Convex/schema changes; normal releases still deploy it.
if [ "${OPERATE_WEB_ONLY_BUILD:-0}" = "1" ]; then
  : "${NEXT_PUBLIC_CONVEX_URL:?A configured backend is required for a web-only release}"
  npm run build
  exit $?
fi

deploy_log="$(mktemp)"
trap 'rm -f "$deploy_log"' EXIT

if npx convex deploy \
  --cmd "npm run build" \
  --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL 2>&1 | tee "$deploy_log"; then
  exit 0
fi

if ! grep -Eq "408 Request Timeout|Unable to start push" "$deploy_log"; then
  exit 1
fi

echo "Convex timed out while starting the push; retrying the backend deployment once."
npx convex deploy
