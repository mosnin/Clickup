// The native desktop host. Product code, styles, fonts, and route adapters are
// compiled into the application bundle; the webview never loads operate.to's
// UI. Network access is reserved for Clerk, Convex, MCP, and update data.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{webview::NewWindowResponse, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;

fn is_local_app_navigation(candidate: &Url) -> bool {
    (candidate.scheme() == "tauri" && candidate.host_str() == Some("localhost"))
        || (matches!(candidate.scheme(), "http" | "https")
            && candidate.host_str() == Some("tauri.localhost"))
}

/// Release builds receive both values from the signing pipeline. Keeping the
/// public verification key in the compiled binary means a compromised update
/// host still cannot replace the application with an unsigned payload.
fn updater_config() -> Result<Option<(Url, &'static str)>, String> {
    match (
        option_env!("OPERATE_UPDATER_ENDPOINT"),
        option_env!("OPERATE_UPDATER_PUBLIC_KEY"),
    ) {
        (None, None) => Ok(None),
        (Some(endpoint), Some(public_key)) if !public_key.trim().is_empty() => {
            let url = Url::parse(endpoint)
                .map_err(|_| "OPERATE_UPDATER_ENDPOINT must be an absolute URL")?;
            if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
                return Err(
                    "OPERATE_UPDATER_ENDPOINT must be an HTTPS URL without embedded credentials"
                        .to_string(),
                );
            }
            Ok(Some((url, public_key)))
        }
        _ => Err(
            "OPERATE_UPDATER_ENDPOINT and OPERATE_UPDATER_PUBLIC_KEY must be set together"
                .to_string(),
        ),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("operate.to")
                .inner_size(1280.0, 860.0)
                // The window has to survive being dragged narrow: Chat's rail
                // and sidebar collapse to a drawer below 768px, and the whole
                // product is built to work at 390px. A minimum wider than that
                // would make the desktop build the one place the responsive
                // work does not apply.
                .min_inner_size(380.0, 480.0)
                // The product UI is local. Data rendered inside it cannot turn
                // the main window into a general-purpose remote browser.
                .on_navigation(is_local_app_navigation)
                // Never create an ungoverned second webview. Product links
                // that need an external browser will be mediated by a narrow,
                // origin-validating native command when that feature lands.
                .on_new_window(|_, _| NewWindowResponse::Deny)
                // Shipping Web Inspector materially expands the attack and
                // token-exfiltration surface. It remains available in debug.
                .devtools(cfg!(debug_assertions))
                .build()?;

            if let Some((endpoint, public_key)) = updater_config()? {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let updater = handle
                        .updater_builder()
                        .endpoints(vec![endpoint])
                        .map(|builder| builder.pubkey(public_key))
                        .and_then(|builder| builder.build());
                    match updater {
                        Ok(updater) => match updater.check().await {
                            Ok(Some(update)) => {
                                if let Err(error) =
                                    update.download_and_install(|_, _| {}, || {}).await
                                {
                                    eprintln!("secure update installation failed: {error}");
                                } else {
                                    handle.restart();
                                }
                            }
                            Ok(None) => {}
                            Err(error) => eprintln!("secure update check failed: {error}"),
                        },
                        Err(error) => eprintln!("secure updater configuration failed: {error}"),
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the operate.to desktop shell");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_stays_inside_the_bundled_app() {
        assert!(is_local_app_navigation(
            &Url::parse("tauri://localhost/dashboard").unwrap()
        ));
        assert!(is_local_app_navigation(
            &Url::parse("http://tauri.localhost/dashboard").unwrap()
        ));
        assert!(!is_local_app_navigation(
            &Url::parse("https://www.operate.to/dashboard").unwrap()
        ));
        assert!(!is_local_app_navigation(
            &Url::parse("https://tauri.localhost.attacker.example/").unwrap()
        ));
    }

    #[test]
    fn updater_is_disabled_without_a_partial_configuration() {
        // The ordinary test/dev build has neither release-pipeline value. A
        // release script makes the pair mandatory before producing artifacts.
        assert!(updater_config().unwrap().is_none());
    }
}
