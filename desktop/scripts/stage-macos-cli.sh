#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(cd "${script_dir}/.." && pwd)"
cli_dir="${desktop_dir}/cli"
tauri_dir="${desktop_dir}/src-tauri"
rust_target="$(rustc +1.88.0 -vV | awk '/^host:/ { print $2 }')"

if [[ "${rust_target}" != "aarch64-apple-darwin" && "${rust_target}" != "x86_64-apple-darwin" ]]; then
  echo "Refusing to stage the macOS CLI on ${rust_target}" >&2
  exit 1
fi

cargo +1.88.0 build \
  --manifest-path "${cli_dir}/Cargo.toml" \
  --release \
  --locked \
  --target "${rust_target}"

mkdir -p "${tauri_dir}/binaries"
install -m 0755 \
  "${cli_dir}/target/${rust_target}/release/operate" \
  "${tauri_dir}/binaries/operate-${rust_target}"
