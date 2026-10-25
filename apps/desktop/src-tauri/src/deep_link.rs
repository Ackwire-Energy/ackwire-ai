//! `agenteschat://` links (the setup's end, a QR code's link, a teammate's): the welcome window shows them,
//! with the server in large type, and nothing changes before the person confirms there. Rust keeps only the
//! newest link until the window takes it (`link_take`), and passes nothing it didn't check is one of ours.
//! On macOS a link reaches the running app as an event; on Windows and Linux as a second launch, which the
//! single-instance plugin hands to the deep-link plugin.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_deep_link::DeepLinkExt;

const SCHEME: &str = "agenteschat";
/// A connect link is short (a server and a token or a claim); anything longer isn't one.
const MAX_LINK: usize = 2048;

#[derive(Default)]
pub struct PendingLink(Mutex<Option<String>>);

/// One of ours, of a size a link can be.
pub fn accept(url: &Url) -> bool {
    url.scheme() == SCHEME && url.as_str().len() <= MAX_LINK
}

fn receive(app: &AppHandle, urls: Vec<Url>) {
    let Some(url) = urls.into_iter().find(accept) else { return };
    *app.state::<PendingLink>().0.lock().unwrap_or_else(|e| e.into_inner()) = Some(url.to_string());
    let _ = crate::present(app, "welcome");
    let _ = app.emit_to("welcome", "link://pending", ());
}

/// Listens for links, takes the one the app was opened with, and (Linux, where an AppImage has no
/// `.desktop` file of its own) registers the scheme.
pub fn setup(app: &AppHandle) {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| receive(&handle, event.urls()));
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        receive(app, urls);
    }
    #[cfg(target_os = "linux")]
    let _ = app.deep_link().register_all();
}

/// A second launch carrying a link (Windows, Linux): the link is handled, the main window stays as it is.
pub fn in_args(args: &[String]) -> bool {
    args.iter().any(|a| a.starts_with("agenteschat:"))
}

#[tauri::command]
pub fn link_take(app: AppHandle, window: tauri::Window) -> Result<Option<String>, String> {
    if window.label() != "welcome" {
        return Err("only the welcome window takes links".into());
    }
    Ok(app.state::<PendingLink>().0.lock().unwrap_or_else(|e| e.into_inner()).take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_our_links() {
        let ok: Url = "agenteschat://connect?server=https%3A%2F%2Fagentes.tail1234.ts.net".parse().unwrap();
        assert!(accept(&ok));
        assert!(!accept(&"https://agentes.chat/connect".parse().unwrap()));
        let long: Url = format!("agenteschat://connect?server=x&pad={}", "a".repeat(MAX_LINK)).parse().unwrap();
        assert!(!accept(&long));
        assert!(in_args(&["/usr/bin/agentes".into(), "agenteschat://connect?server=x".into()]));
        assert!(!in_args(&["/usr/bin/agentes".into(), "--autostart".into()]));
    }
}
