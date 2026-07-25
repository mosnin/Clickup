#!/usr/bin/env bash

set -o pipefail

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
