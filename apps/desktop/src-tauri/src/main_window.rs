//! The main window (ADR 0036): the whole agentes.chat inside the app. It loads the site
//! itself, so every change to the web shows here at once, and gets no access to the Mac: no app command,
//! only dragging the window by its title bar (capabilities/main.json). Links to anywhere else open in the
//! person's browser, and so does social sign-in (Google and Apple refuse embedded web views): the site
//! hands the session back through `/desktop/sign-in` and `/desktop/signed-in` (apps/server desktop-sign-in.ts).
//! The site may ask three things of this Mac through `this_mac` (see `Bridge`), never more.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, Theme, Url, WebviewUrl, WebviewWindowBuilder};
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

/// What the window shows before the site paints: the site's own background (packages/ui tokens.css `--side`),
/// never the web view's white. Follows the system's light/dark (lib.rs updates it on `ThemeChanged`).
pub fn backdrop(theme: Theme) -> Color {
    match theme {
        Theme::Dark => Color(10, 10, 9, 255),
        _ => Color(248, 248, 246, 255),
    }
}

/// Where `url` goes inside the page that is already there: the site's router (`__agentesNavigate`,
/// apps/web __root.tsx) moves without loading the page again; before the site is up, a plain load.
fn go_in_page(url: &Url) -> Option<String> {
    let mut path = url.path().to_string();
    if let Some(query) = url.query() {
        path.push('?');
        path.push_str(query);
    }
    if let Some(fragment) = url.fragment() {
        path.push('#');
        path.push_str(fragment);
    }
    if path == "/" {
        return None; // the root: only the window comes, as the person left it
    }
    let path = serde_json::to_string(&path).ok()?;
    Some(format!("(window.__agentesNavigate || ((p) => location.assign(p)))({path})"))
}

/// Shows the window (made on first use), on `url` when given (a page of the site).
pub fn open(app: &AppHandle, url: Option<Url>) -> Result<(), String> {
    let site = site();
    let url = url.filter(|u| same_site(u, &site));
    // The window holds two web views (the site, and the app's cover over it), so it is found by its parts.
    // Already open: never a reload (where the person was, drafts, scroll stay), only the route moves.
    if let Some(page) = app.get_webview(LABEL) {
        if let Some(js) = url.as_ref().and_then(go_in_page) {
            page.eval(js).map_err(|e| e.to_string())?;
        }
        return front(app);
    }

    let on_nav = app.clone();
    let on_new = app.clone();
    let on_download = app.clone();
    let on_load = app.clone();
    let on_title = app.clone();
    let nav_site = site.clone();
    let new_site = site.clone();
    let saved = crate::window_state::load(app);
    let version = app.package_info().version.to_string();
    // The popover is made at start, so it already knows the system's appearance.
    let theme = app
        .get_webview_window("popover")
        .and_then(|w| w.theme().ok())
        .unwrap_or(Theme::Light);
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url.unwrap_or_else(|| site.clone())))
        .title("agentes.chat")
        .min_inner_size(960.0, 600.0)
        // As the person left it (window_state.rs), on a screen that is still there.
        .inner_size(saved.width.unwrap_or(1240.0), saved.height.unwrap_or(800.0))
        .prevent_overflow()
        // Two web views share the window (the site and the cover): each follows its size.
        .auto_resize()
        // Files dragged from Finder (into a conversation, the Drive) and drags inside the page go to the site;
        // Tauri's own drop handling would take every drag first and the page would get nothing.
        .disable_drag_drop_handler()
        .background_color(backdrop(theme))
        // Hidden, the page keeps running (macOS 14+), as Slack's: conversations stay live, the Dock badge
        // stays right, and coming back finds it as it was.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        // The window's name is the page's ("#loja · Acme"): the Window menu, Mission Control, VoiceOver.
        .on_document_title_changed(move |_, title| {
            if let Some(window) = on_title.get_window(LABEL) {
                let _ = window.set_title(window_title(&title));
            }
        })
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
        // `target="_blank"`, ⌘-click and window.open: a page of the site moves the window there; anything
        // else opens in the browser. Never a second app window.
        .on_new_window(move |url, _| {
            if route(&url, &new_site) == Route::Stay && matches!(url.scheme(), "http" | "https") {
                let app = on_new.clone();
                std::thread::spawn(move || {
                    let _ = open(&app, Some(url));
                });
            } else {
                open_outside(&on_new, &url);
            }
            NewWindowResponse::Deny
        })
        // A whole page loading again (⌘R, macOS ended it, a full navigation): the cover, never a blank window.
        .on_page_load(move |_, payload| match payload.event() {
            PageLoadEvent::Started => crate::cover::show(&on_load, Duration::ZERO),
            // The page's own sizes follow the zoom (desktop.css), and the bar knows about full screen.
            PageLoadEvent::Finished => fit_page(&on_load),
        })
        .on_download(move |_, event| match event {
            DownloadEvent::Requested { destination, .. } => match downloads_path(&on_download, destination) {
                Some(path) => {
                    *destination = path;
                    true
                }
                None => false,
            },
            DownloadEvent::Finished { path, success, .. } => {
                if success {
                    if let Some(name) = path.as_ref().and_then(|p| p.file_name()) {
                        crate::menus::downloaded(&on_download, &name.to_string_lossy());
                    }
                }
                true
            }
            _ => true,
        });
    let builder = match (saved.x, saved.y) {
        (Some(x), Some(y)) => builder.position(x, y),
        _ => builder.center(),
    };
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        // Centred in the site's 40px title bar (apps/web desktop.css): `y` places the top of the buttons' row,
        // not their middle (at 20 they sat ~3pt below the bar's icons).
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 17.0));
    let built = builder.build().map_err(|e| e.to_string())?;
    let window = built.as_ref().window();
    if saved.maximized {
        let _ = window.maximize();
    }
    if let Some(step) = saved.zoom {
        let _ = built.set_zoom(crate::menus::restore_zoom(app, step));
    }
    crate::cover::attach(app, &window).map_err(|e| e.to_string())?;
    front(app)
}

/// The window's name for the page's title: the site's own long title (sign-in, the landing) is just the app's.
fn window_title(title: &str) -> &str {
    let title = title.trim();
    if title.is_empty() || title.starts_with("agentes.chat ·") {
        "agentes.chat"
    } else {
        title
    }
}

/// Tells the page the zoom (`--app-zoom`: its title bar stays 40pt and level with the window's buttons) and
/// whether the window is full screen (no room kept for the buttons then).
pub fn fit_page(app: &AppHandle) {
    let Some(page) = app.get_webview(LABEL) else { return };
    let zoom = crate::menus::current_zoom(app);
    let full = app
        .get_window(LABEL)
        .and_then(|w| w.is_fullscreen().ok())
        .unwrap_or(false);
    let _ = page.eval(format!(
        "document.documentElement.style.setProperty('--app-zoom','{zoom}');\
         document.documentElement.toggleAttribute('data-fullscreen',{full});"
    ));
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
    let window = app.get_window(LABEL).ok_or("window not found")?;
    let _ = window.unminimize();
    window.show().map_err(|e| e.to_string())?;
    crate::sync_dock(app);
    window.set_focus().map_err(|e| e.to_string())
}

/// What the site may ask of this Mac (ADR 0036): which organizations it is connected to (`status`), connecting it
/// to the person's organization (`connect`: the site confirms the code with its own session, as on
/// `/conectar`), reconnecting it (`reconnect`), Preferences on a tab (`prefs`) and the menu bar's access
/// requests (`requests`). Rust only checks the request and relays it: the popover's
/// code owns the runners (apps/desktop/src/control/this-mac.ts) and answers through `this_mac_reply`. The
/// machine's token never leaves the runner.
#[derive(Default)]
pub struct Bridge {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    /// The popover listens (`this_mac_listening`): before that a request would be lost, so it waits.
    listening: AtomicBool,
}

/// How long the popover has to answer (`connect` waits for the runner's code).
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a request waits for the popover to start listening (the app just opened).
const LISTEN_TIMEOUT: Duration = Duration::from_secs(10);
/// Requests waiting at once; more are refused (each holds a thread while it waits).
const MAX_WAITING: usize = 16;
/// Organizations in the Go menu (⌘⌥1–9 for the first nine).
const MAX_ORGS: usize = 20;
const PREF_TABS: &[&str] = &["folders", "tools", "updates"];

/// The request rebuilt from the keys it may have; anything else is refused.
fn checked(request: &Value) -> Result<Value, String> {
    let text = |key: &str| request.get(key).and_then(Value::as_str);
    let org = || {
        let org = text("orgId").unwrap_or_default();
        let ok = !org.is_empty()
            && org.len() <= 64
            && org.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if ok {
            Ok(org)
        } else {
            Err("bad organization id".to_string())
        }
    };
    match text("kind") {
        Some("status") => Ok(json!({ "kind": "status" })),
        Some("requests") => Ok(json!({ "kind": "requests" })),
        Some(kind @ ("connect" | "reconnect")) => Ok(json!({ "kind": kind, "orgId": org()? })),
        Some("prefs") => match text("tab") {
            Some(tab) if PREF_TABS.contains(&tab) => Ok(json!({ "kind": "prefs", "tab": tab })),
            _ => Err("unknown tab".into()),
        },
        // The Dock's badge: two counts, nothing else.
        Some("badge") => {
            let count = |key: &str| request.get(key).and_then(Value::as_u64).unwrap_or(0).min(100_000);
            Ok(json!({ "kind": "badge", "waiting": count("waiting"), "unread": count("unread") }))
        }
        // The Go menu's organizations: ids like `orgId`, short names.
        Some("orgs") => {
            let list = request.get("orgs").and_then(Value::as_array).ok_or("bad organizations")?;
            let orgs = list
                .iter()
                .take(MAX_ORGS)
                .map(|o| {
                    let id = o.get("id").and_then(Value::as_str).unwrap_or_default();
                    let name: String = o.get("name").and_then(Value::as_str).unwrap_or_default().chars().take(80).collect();
                    let ok = !id.is_empty()
                        && id.len() <= 64
                        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                        && !name.trim().is_empty();
                    if ok {
                        Ok(json!({ "id": id, "name": name.trim() }))
                    } else {
                        Err("bad organization".to_string())
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(json!({ "kind": "orgs", "orgs": orgs }))
        }
        _ => Err("unknown request".into()),
    }
}

#[tauri::command]
pub async fn this_mac(app: AppHandle, webview: tauri::Webview, request: Value) -> Result<Value, String> {
    // The site itself, not the cover that shares its window.
    if webview.label() != LABEL {
        return Err("only the main window asks this".into());
    }
    let request = checked(&request)?;
    // What the app itself answers (the popover isn't needed).
    match request["kind"].as_str() {
        Some("badge") => {
            let count = |key: &str| u32::try_from(request[key].as_u64().unwrap_or(0)).unwrap_or(u32::MAX);
            crate::dock::set_badge(&app, count("waiting"), count("unread"));
            return Ok(json!({}));
        }
        Some("orgs") => {
            crate::menus::set_orgs(&app, &request["orgs"]);
            return Ok(json!({}));
        }
        _ => {}
    }
    let id = app.state::<Bridge>().next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    {
        // The state outlives the lock (a temporary `State` would be dropped while still borrowed).
        let bridge = app.state::<Bridge>();
        let mut waiting = bridge.waiting.lock().map_err(|e| e.to_string())?;
        if waiting.len() >= MAX_WAITING {
            return Err("this Mac is busy".into());
        }
        waiting.insert(id, tx);
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Right after the app opens, the popover may not listen yet: the request waits for it.
        let bridge = app.state::<Bridge>();
        let since = std::time::Instant::now();
        while !bridge.listening.load(Ordering::Relaxed) && since.elapsed() < LISTEN_TIMEOUT {
            std::thread::sleep(Duration::from_millis(50));
        }
        let sent = app.emit_to("popover", "this-mac://request", json!({ "id": id, "request": request }));
        let answer = match sent {
            Ok(()) => rx.recv_timeout(BRIDGE_TIMEOUT).unwrap_or_else(|_| Err("this Mac didn't answer".into())),
            Err(e) => Err(e.to_string()),
        };
        let _ = bridge.waiting.lock().map(|mut w| w.remove(&id));
        answer
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The popover listens for `this_mac` requests now.
#[tauri::command]
pub fn this_mac_listening(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    if window.label() != "popover" {
        return Err("only the popover listens".into());
    }
    app.state::<Bridge>().listening.store(true, Ordering::Relaxed);
    Ok(())
}

/// The popover's answer to a `this_mac` request.
#[tauri::command]
pub fn this_mac_reply(app: AppHandle, window: tauri::Window, id: u64, ok: bool, data: Value) -> Result<(), String> {
    if window.label() != "popover" {
        return Err("only the popover answers".into());
    }
    let waiting = app.state::<Bridge>().waiting.lock().map_err(|e| e.to_string())?.remove(&id);
    if let Some(tx) = waiting {
        let answer = if ok {
            Ok(data)
        } else {
            Err(data.as_str().unwrap_or("failed").to_string())
        };
        let _ = tx.send(answer);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(url: &str) -> Route {
        route(&url.parse().unwrap(), &"https://agentes.chat".parse().unwrap())
    }

    #[test]
    fn in_page_moves_and_titles() {
        let go = |u: &str| go_in_page(&u.parse().unwrap());
        assert_eq!(go("https://agentes.chat/"), None);
        assert_eq!(
            go("https://agentes.chat/org/o1/c/c1?m=9#x").as_deref(),
            Some(r#"(window.__agentesNavigate || ((p) => location.assign(p)))("/org/o1/c/c1?m=9#x")"#)
        );
        assert_eq!(window_title("#loja · Acme"), "#loja · Acme");
        assert_eq!(window_title("agentes.chat · Your team and your agents"), "agentes.chat");
        assert_eq!(window_title("  "), "agentes.chat");
    }

    #[test]
    fn bridge_badge_and_orgs() {
        assert_eq!(
            checked(&json!({ "kind": "badge", "waiting": 3, "unread": 9, "x": 1 })),
            Ok(json!({ "kind": "badge", "waiting": 3, "unread": 9 }))
        );
        assert_eq!(
            checked(&json!({ "kind": "orgs", "orgs": [{ "id": "o-1", "name": " Acme " }] })),
            Ok(json!({ "kind": "orgs", "orgs": [{ "id": "o-1", "name": "Acme" }] }))
        );
        assert!(checked(&json!({ "kind": "orgs", "orgs": [{ "id": "../x", "name": "A" }] })).is_err());
        assert!(checked(&json!({ "kind": "orgs" })).is_err());
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

    #[test]
    fn bridge_requests() {
        assert_eq!(checked(&json!({ "kind": "status", "extra": 1 })), Ok(json!({ "kind": "status" })));
        assert_eq!(
            checked(&json!({ "kind": "connect", "orgId": "org_1-a" })),
            Ok(json!({ "kind": "connect", "orgId": "org_1-a" }))
        );
        assert!(checked(&json!({ "kind": "connect", "orgId": "../x" })).is_err());
        assert!(checked(&json!({ "kind": "connect" })).is_err());
        assert_eq!(checked(&json!({ "kind": "prefs", "tab": "folders" })), Ok(json!({ "kind": "prefs", "tab": "folders" })));
        assert!(checked(&json!({ "kind": "prefs", "tab": "advanced" })).is_err());
        assert_eq!(checked(&json!({ "kind": "reconnect", "orgId": "o1" })), Ok(json!({ "kind": "reconnect", "orgId": "o1" })));
        assert!(checked(&json!({ "kind": "reconnect" })).is_err());
        assert_eq!(checked(&json!({ "kind": "requests", "x": 1 })), Ok(json!({ "kind": "requests" })));
        assert!(checked(&json!({ "kind": "runner_send" })).is_err());
    }
}
