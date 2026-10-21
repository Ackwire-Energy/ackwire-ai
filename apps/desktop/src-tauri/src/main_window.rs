//! The main window (D79, telas/AppDesktop.html B): the whole agentes.chat inside the app. It loads the site
//! itself, so every change to the web shows here at once, and gets no access to the Mac: no app command,
//! only dragging the window by its title bar (capabilities/main.json). Links to anywhere else open in the
//! person's browser, and so does social sign-in (Google and Apple refuse embedded web views): the site
//! hands the session back through `/desktop/sign-in` and `/desktop/signed-in` (apps/server desktop-sign-in.ts).

use std::path::{Path, PathBuf};

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

pub const LABEL: &str = "main";

/// The site sends social sign-in here: it must open in the browser, never in the window.
const BROWSER_SIGN_IN: &str = "/desktop/sign-in";
/// The site comes here once the browser handed the session over: the window comes to the front.
const SIGNED_IN: &str = "/desktop/signed-in";

/// The site the window loads; a debug build may point it elsewhere (`AGENTES_SITE_URL`, e.g. a local web).
pub fn site() -> Url {
    #[cfg(debug_assertions)]
    if let Some(url) = std::env::var("AGENTES_SITE_URL").ok().and_then(|u| u.parse().ok()) {
        return url;
    }
    crate::SITE.parse().expect("SITE is a valid URL")
}

fn same_site(url: &Url, site: &Url) -> bool {
    url.scheme() == site.scheme()
        && url.host_str() == site.host_str()
        && url.port_or_known_default() == site.port_or_known_default()
}

/// What a navigation in the window does.
#[derive(Debug, PartialEq)]
enum Route {
    /// Stays in the window.
    Stay,
    /// Stays, and the window comes to the front (signed in from the browser).
    Front,
    /// Opens in the person's browser (or the app for its scheme) instead.
    Outside,
}

fn route(url: &Url, site: &Url) -> Route {
    match url.scheme() {
        "http" | "https" if same_site(url, site) => match url.path() {
            BROWSER_SIGN_IN => Route::Outside,
            SIGNED_IN => Route::Front,
            _ => Route::Stay,
        },
        "http" | "https" => Route::Outside,
        // The site's own previews (sandboxed HTML, PDFs) load from these.
        "blob" | "data" | "about" => Route::Stay,
        // mailto:, tel: and other apps.
        _ => Route::Outside,
    }
}

fn open_outside(app: &AppHandle, url: &Url) {
    if url.as_str().len() > 8192 {
        return;
    }
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
}

/// Shows the window (made on first use), on `url` when given (a page of the site).
pub fn open(app: &AppHandle, url: Option<Url>) -> Result<(), String> {
    let site = site();
    let url = url.filter(|u| same_site(u, &site));
    if let Some(window) = app.get_webview_window(LABEL) {
        if let Some(url) = url {
            window.navigate(url).map_err(|e| e.to_string())?;
        }
        return front(app);
    }

    let on_nav = app.clone();
    let on_new = app.clone();
    let on_download = app.clone();
    let nav_site = site.clone();
    let version = app.package_info().version.to_string();
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url.unwrap_or_else(|| site.clone())))
        .title("agentes")
        .inner_size(1240.0, 800.0)
        .min_inner_size(960.0, 600.0)
        .center()
        // The site knows it is in the app (its own title bar, sign-in through the browser); nothing else.
        .initialization_script(format!("window.__agentesDesktop = Object.freeze({{ version: {version:?} }});"))
        .on_navigation(move |url| match route(url, &nav_site) {
            Route::Stay => true,
            Route::Front => {
                let app = on_nav.clone();
                // Not from inside the navigation callback: the window's own thread is busy with it.
                std::thread::spawn(move || {
                    let _ = front(&app);
                });
                true
            }
            Route::Outside => {
                open_outside(&on_nav, url);
                false
            }
        })
        // `target="_blank"` and window.open: the browser, never a second app window.
        .on_new_window(move |url, _| {
            open_outside(&on_new, &url);
            NewWindowResponse::Deny
        })
        .on_download(move |_, event| match event {
            DownloadEvent::Requested { destination, .. } => match downloads_path(&on_download, destination) {
                Some(path) => {
                    *destination = path;
                    true
                }
                None => false,
            },
            _ => true,
        });
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        // Centred in the site's 40px title bar (apps/web desktop.css).
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 20.0));
    builder.build().map_err(|e| e.to_string())?;
    front(app)
}

/// Downloads land in ~/Downloads under their own name, never over an existing file.
fn downloads_path(app: &AppHandle, suggested: &Path) -> Option<PathBuf> {
    let dir = app.path().download_dir().ok()?;
    let name = suggested.file_name()?.to_string_lossy().into_owned();
    let path = dir.join(&name);
    if !path.exists() {
        return Some(path);
    }
    let stem = Path::new(&name).file_stem()?.to_string_lossy().into_owned();
    let ext = Path::new(&name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    (1..1000).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists())
}

fn front(app: &AppHandle) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or("window not found")?;
    let _ = window.unminimize();
    window.show().map_err(|e| e.to_string())?;
    crate::sync_dock(app);
    window.set_focus().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(url: &str) -> Route {
        route(&url.parse().unwrap(), &"https://agentes.chat".parse().unwrap())
    }

    #[test]
    fn routes() {
        assert_eq!(r("https://agentes.chat/org/x/c/y"), Route::Stay);
        assert_eq!(r("https://agentes.chat/desktop/sign-in?provider=google&challenge=a"), Route::Outside);
        assert_eq!(r("https://agentes.chat/desktop/signed-in?to=%2F"), Route::Front);
        assert_eq!(r("https://accounts.google.com/o/oauth2"), Route::Outside);
        assert_eq!(r("http://agentes.chat/"), Route::Outside);
        assert_eq!(r("https://agentes.chat.evil.com/"), Route::Outside);
        assert_eq!(r("blob:https://agentes.chat/abc"), Route::Stay);
        assert_eq!(r("mailto:a@b.c"), Route::Outside);
    }
}
