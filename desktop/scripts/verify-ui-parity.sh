#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "${script_dir}/.." && pwd)"
main_source="${desktop_dir}/src-tauri/src/main.rs"
tauri_config="${desktop_dir}/src-tauri/tauri.conf.json"

rg -F 'WebviewUrl::App("index.html".into())' "${main_source}" >/dev/null
rg -F '.on_navigation' "${main_source}" >/dev/null
if rg -F 'WebviewUrl::External' "${main_source}" >/dev/null; then
  echo "Desktop loads a remote product URL; this would regress to a hosted wrapper" >&2
  exit 1
fi

for shared_surface in \
  '@/app/dashboard/page' \
  '@/components/dashboard/sidebar' \
  '@/app/dashboard/chat/chat-view' \
  '@/app/dashboard/l/[listId]/list-page' \
  '@/app/dashboard/wb/[whiteboardId]/whiteboard-editor'; do
  rg -F "${shared_surface}" "${desktop_dir}/ui/src/desktop-app.tsx" >/dev/null
done

node -e '
  const config = require(process.argv[1]);
  if (config.app.windows.length !== 0 || config.app.withGlobalTauri !== false) {
    throw new Error("desktop must create its origin-gated local window in Rust without exposing the Tauri global");
  }
' "${tauri_config}"

echo "UI parity invariant: macOS bundles and imports the shared Operate UI"
