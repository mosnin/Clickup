# Operate for macOS

> The canonical native client now lives in `desktop/native`. It is compiled
> ahead of time into an AppKit/Metal macOS application and does not declare a
> web layer. The Tauri tree below is retained temporarily as migration history
> and must not be used for new releases.

The macOS client is a locally bundled Tauri application distributed as a DMG.
It does not navigate to, embed, or frame the operate.to website. Its Vite build
imports the web product's actual React components, design tokens, fonts, and
route surfaces so visual parity comes from shared source rather than a desktop
lookalike. Clerk, Convex, MCP, and the update feed remain network services; the
application UI itself ships inside the signed app bundle.

## Security boundary

- The main window loads only Tauri's packaged `index.html` application URL.
- Navigation to operate.to or any other remote page is denied.
- The desktop UI has no Tauri command capability; native privileges stay in Rust.
- The content policy allowlists only the Clerk, Convex, and Operate service
  connections required by the local application.
- Web Inspector is unavailable in release builds.
- Native updates require HTTPS and a signature matching the public key compiled
  into the release. A release with only half of that configuration refuses to
  start.
- The bundled CLI stores credentials in macOS Keychain, scoped by server origin.

## Run and verify

Build the local UI before running the native host. Rust 1.88 is pinned by
`rust-toolchain.toml`.

```bash
export VITE_CLERK_PUBLISHABLE_KEY=...
export VITE_CONVEX_URL=...
desktop/scripts/build-native-ui.sh
cd desktop/src-tauri
cargo test
cargo run
```

The values embedded in the UI are publishable client configuration. Clerk and
Convex server credentials must never be placed in the desktop environment or
bundle.

## Native CLI

The app bundle includes `operate`, a native CLI and stdio MCP bridge:

```bash
cd desktop/cli
cargo build
./target/debug/operate manifest
./target/debug/operate auth login
./target/debug/operate tools
./target/debug/operate call whoami
./target/debug/operate mcp serve
```

`auth login` uses Operate's human-approved device authorization flow and saves
the resulting agent credential in Keychain. `mcp serve` lets local agent
runtimes use their ordinary stdio MCP configuration while the CLI speaks
authenticated Streamable HTTP to Operate. Tool lists are discovered from the
server; they are not frozen into the client.

After installation, an agent can invoke the bundled binary directly at:

```text
/Applications/operate.to.app/Contents/MacOS/operate
```

A future in-app “Install CLI” action may add a convenience symlink, but the app
does not request administrator access or mutate shell profiles today.

## Signed release

`scripts/build-macos-release.sh` is the local release gate. It refuses to build
without Developer ID signing, Apple notarization, and Tauri updater-signing
configuration. `scripts/stage-macos-cli.sh` builds and stages the target-suffixed
sidecar that Tauri puts inside the application bundle.

The `Release macOS` GitHub workflow performs the same flow on a pinned macOS
runner and creates a draft release. Configure these repository values before
running it:

- Secrets: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`,
  `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Variables: `OPERATE_UPDATER_ENDPOINT`, `OPERATE_UPDATER_PUBLIC_KEY`,
  `VITE_CLERK_PUBLISHABLE_KEY`, and `VITE_CONVEX_URL`.

The endpoint must publish the Tauri `latest.json` contract and signed update
artifacts. Drafts must not be published until `codesign --verify`, Gatekeeper
assessment, notarization, update installation, and representative signed-out
and signed-in UI checks pass on a clean Mac.

For packaging-only local verification, `scripts/build-macos-development.sh`
creates an unsigned DMG after building the local UI and staging the CLI. It is
not distributable and must not be substituted for the signed release gate.
