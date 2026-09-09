#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ui_dir="$(cd "${script_dir}/../ui" && pwd)"

for variable_name in VITE_CLERK_PUBLISHABLE_KEY VITE_CONVEX_URL; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "Missing required public desktop setting: ${variable_name}" >&2
    exit 1
  fi
done

npm --prefix "${ui_dir}" ci
npm --prefix "${ui_dir}" run build
