#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "${script_dir}/.." && pwd)"
tauri_dir="${desktop_dir}/src-tauri"

required=(
  APPLE_SIGNING_IDENTITY
  OPERATE_UPDATER_ENDPOINT
  OPERATE_UPDATER_PUBLIC_KEY
  TAURI_SIGNING_PRIVATE_KEY
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  VITE_CLERK_PUBLISHABLE_KEY
  VITE_CONVEX_URL
)
for variable_name in "${required[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "Missing required release setting: ${variable_name}" >&2
    exit 1
  fi
done

has_api_notary=false
if [[ -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
  has_api_notary=true
fi
has_account_notary=false
if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  has_account_notary=true
fi
if [[ "${has_api_notary}" != true && "${has_account_notary}" != true ]]; then
  echo "Missing a complete Apple notarization credential set" >&2
  exit 1
fi

if [[ "${OPERATE_UPDATER_ENDPOINT}" != https://* ]]; then
  echo "OPERATE_UPDATER_ENDPOINT must use HTTPS" >&2
  exit 1
fi

if ! command -v cargo-tauri >/dev/null 2>&1; then
  echo "cargo-tauri is required. Install the pinned Tauri CLI before releasing." >&2
  exit 1
fi

"${script_dir}/build-native-ui.sh"
"${script_dir}/stage-macos-cli.sh"

(
  cd "${tauri_dir}"
  cargo +1.88.0 tauri build \
    --bundles app,dmg \
    --config "${desktop_dir}/tauri.release.conf.json"
)

app_path="${tauri_dir}/target/release/bundle/macos/operate.to.app"
codesign --verify --deep --strict --verbose=2 "${app_path}"
spctl --assess --type execute --verbose=2 "${app_path}"

echo "Release artifacts are in ${tauri_dir}/target/release/bundle"
