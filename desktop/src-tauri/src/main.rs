// The desktop shell.
//
// The same "remote web app" pattern `capacitor.config.ts` already uses for iOS
// and Android: this binary opens a window onto the deployed URL rather than
// bundling a copy of the app. That is the whole design, and it buys three
// things — Convex's realtime subscriptions and the Clerk session behave exactly
// as they do on the web, a fix reaches everyone the moment it deploys instead
// of after a store review, and the installer stays a few megabytes.
//
// What it costs, stated plainly: with no network there is no app. A bundled
// build would at least render its own shell. For a product whose every surface
// is a live subscription over somebody else's data, an offline shell showing
// empty rooms is not obviously better than a window that says it cannot reach
// the server — and the PWA already covers the "keep working briefly" case with
// a service worker the desktop build gets for free by pointing at the same URL.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Where the window points.
///
/// An environment variable rather than a constant so a developer can aim the
/// shell at a local `next dev` or a preview deployment without editing source,
/// which is the same reason `capacitor.config.ts` reads `CAP_SERVER_URL`.
fn target_url() -> String {
    option_env!("OPERATE_DESKTOP_URL")
        .unwrap_or("https://operate.to/dashboard")
        .to_string()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let url = target_url();
            let parsed = url
                .parse()
                .map_err(|_| format!("OPERATE_DESKTOP_URL is not a URL: {url}"))?;

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                .title("operate.to")
                .inner_size(1280.0, 860.0)
                // The window has to survive being dragged narrow: Chat's rail
                // and sidebar collapse to a drawer below 768px, and the whole
                // product is built to work at 390px. A minimum wider than that
                // would make the desktop build the one place the responsive
                // work does not apply.
                .min_inner_size(380.0, 480.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the operate.to desktop shell");
}
