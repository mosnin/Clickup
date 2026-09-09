#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "${script_dir}/.." && pwd)"
tauri_dir="${desktop_dir}/src-tauri"

"${script_dir}/build-native-ui.sh"
"${script_dir}/stage-macos-cli.sh"

(
  cd "${tauri_dir}"
  "${desktop_dir}/ui/node_modules/.bin/tauri" build \
    --bundles app \
    --config "${desktop_dir}/tauri.development.conf.json"
)

app_path="${tauri_dir}/target/release/bundle/macos/operate.to.app"
dmg_dir="${tauri_dir}/target/release/bundle/dmg"
dmg_path="${dmg_dir}/operate.to_0.1.0_aarch64.dmg"
package_dir="$(mktemp -d -t operate-dmg-stage)"

mkdir -p "${dmg_dir}"
ditto "${app_path}" "${package_dir}/operate.to.app"
ln -s /Applications "${package_dir}/Applications"
hdiutil create -volname "operate.to" -srcfolder "${package_dir}" -ov -format UDZO "${dmg_path}"
rm "${package_dir}/Applications"
rm -R "${package_dir}/operate.to.app"
rmdir "${package_dir}"
hdiutil verify "${dmg_path}"

echo "Unsigned development DMG: ${dmg_path}"
echo "Do not distribute it; production releases must use build-macos-release.sh"
