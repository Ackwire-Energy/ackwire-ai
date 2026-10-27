//! `agenteschat://` links (the setup's end, a QR code's link, a teammate's): the welcome window shows them,
//! with the server in large type, and nothing changes before the person confirms there. Rust keeps only the
//! newest link until the window takes it (`link_take`), and passes nothing it didn't check is one of ours.
//! A connector's sign-in that the browser hands back (`agenteschat://desktop/connectors/oauth`) goes to the
//! main window instead, which finishes it with its own session.
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

/// A connector's sign-in that the browser handed back (apps/server connectors.ts `oauth/callback`).
fn is_connector_return(url: &Url) -> bool {
    url.host_str() == Some("desktop") && url.path() == "/connectors/oauth"
}

/// The page of `site` that finishes it (apps/web desktop.connector.tsx), with only its own fields.
pub fn connector_page(url: &Url, site: &Url) -> Option<Url> {
    if !is_connector_return(url) {
        return None;
    }
    let mut page = site.join("/desktop/connector").ok()?;
    page.set_fragment(None);
    page.set_query(None);
    let fields: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| matches!(&**key, "org" | "state" | "code" | "error"))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    page.query_pairs_mut().extend_pairs(fields);
    Some(page)
}

fn receive(app: &AppHandle, urls: Vec<Url>) {
    let Some(url) = urls.into_iter().find(accept) else { return };
    // On the server open now, where the window is signed in: its state is that person's there.
    if is_connector_return(&url) {
        if let Some(page) = crate::main_window::site(app).and_then(|site| connector_page(&url, &site)) {
            let app = app.clone();
            // Not from inside the link's event: the window may have to be made first.
            std::thread::spawn(move || {
                let _ = crate::main_window::show_url(&app, page);
            });
        }
        return;
    }
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

    #[test]
    fn a_connector_s_sign_in_goes_to_the_site_open_now() {
        let site: Url = "https://agentes.chat".parse().unwrap();
        let back: Url = "agenteschat://desktop/connectors/oauth?org=o1&state=s1&code=c%202&other=x".parse().unwrap();
        assert_eq!(
            connector_page(&back, &site).unwrap().as_str(),
            "https://agentes.chat/desktop/connector?org=o1&state=s1&code=c+2"
        );
        let refused: Url = "agenteschat://desktop/connectors/oauth?org=o1&error=access_denied".parse().unwrap();
        assert_eq!(
            connector_page(&refused, &site).unwrap().as_str(),
            "https://agentes.chat/desktop/connector?org=o1&error=access_denied"
        );
        // A server of the person's own, on its own port; the phone app's link and a connect link aren't this.
        let own: Url = "http://127.0.0.1:4310/".parse().unwrap();
        assert!(connector_page(&back, &own).unwrap().as_str().starts_with("http://127.0.0.1:4310/desktop/connector?"));
        assert!(connector_page(&"agenteschat://connectors/oauth?state=s&code=c".parse().unwrap(), &site).is_none());
        assert!(connector_page(&"agenteschat://connect?server=x".parse().unwrap(), &site).is_none());
    }
}
