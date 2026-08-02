# The desktop app

A Tauri shell that opens a window onto the deployed URL. It is the same
"remote web app" pattern `capacitor.config.ts` uses for iOS and Android, for the
same reasons: Convex realtime and the Clerk session behave exactly as they do on
the web, a fix reaches everyone the moment it deploys rather than after a store
review, and the installer stays small.

Buzz ships a Tauri desktop client, and this is our equivalent (decision D10 in
`docs/buzz-parity/00-decisions.md`). What we deliberately did **not** take from
Buzz's desktop build is everything that only makes sense when the app owns its
own storage — the local SQLite archive, the identity archive, mesh compute, and
the on-device speech models. Those answer offline sovereignty over your own
copy, which a hosted product answers differently.

## Status: scaffolded, not built here

This has **never been compiled**. The container it was written in has Rust but
none of the platform GUI libraries Tauri links against (`webkit2gtk` and friends
on Linux, Xcode on macOS, the WebView2 SDK on Windows), and no display to run a
window on. Treat the first `cargo tauri build` on a real machine as the actual
first build, and expect to fix something.

Being explicit about that rather than implying it works is the point: everything
else in this branch has been run, and this has not.

## Running it

```bash
cd desktop/src-tauri
cargo tauri dev                       # points at https://operate.to/dashboard
OPERATE_DESKTOP_URL=http://localhost:3000/dashboard cargo tauri dev
```

`OPERATE_DESKTOP_URL` is read at compile time (`option_env!`), so a different
target needs a rebuild rather than a restart. That is deliberate: a shipped
binary whose server address could be changed by an environment variable is a
binary somebody else can repoint.

## Building installers

```bash
cd desktop/src-tauri
cargo tauri build          # dmg / nsis / appimage / deb, per tauri.conf.json
```

Signing is not configured. An unsigned macOS build is quarantined by Gatekeeper
and an unsigned Windows build triggers SmartScreen — Buzz's own release notes
say the same about theirs, so this is the expected state for an alpha rather
than a problem to solve before the first build runs.

## Still to do before shipping one

- `icons/icon.png` and the platform icon set (`cargo tauri icon` generates them).
- Code signing and notarization for macOS, a certificate for Windows.
- A release pipeline. Three platforms, and the two that matter most cannot be
  cross-compiled from Linux.
- Decide whether the window should deep-link: `/chat/c/<id>` from a notification
  is the obvious case, and it needs a URL scheme registered per platform.
