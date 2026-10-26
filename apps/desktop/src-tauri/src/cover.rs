//! The main window's cover: a page of the app itself (`cover.html`, local) over the server's page, so the
//! window is never blank. It shows when the app opens (at least 1 s), whenever the page loads whole again
//! (⌘R, macOS ending the page, switching servers) and while the server can't be reached; it goes when the
//! page says it painted (`page_ready`). The cover only asks the server open now whether it answers, to tell
//! offline from down, and may only ask to load the page again or to step aside (capabilities/cover.json).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::window::Color;
use tauri::{AppHandle, LogicalPosition, Manager, WebviewBuilder, WebviewUrl};

use crate::main_window;

pub const LABEL: &str = "main-cover";

/// The splash when the app opens stays at least this long, even when the site is ready sooner.
pub const OPENING: Duration = Duration::from_secs(1);
/// The cover fades out (cover.css) before it is hidden.
const FADE: Duration = Duration::from_millis(260);
/// The sky's deepest tone (packages/ui sky SKY_TONES[0]), before the cover's page paints.
const SKY: Color = Color(10, 63, 156, 255);

#[derive(Default)]
pub struct Cover(Mutex<Shown>);

#[derive(Default)]
struct Shown {
    /// Since when it covers the site, and for how long at least; `None` when hidden.
    since: Option<(Instant, Duration)>,
    /// Each showing gets a new one: a late hide meant for an earlier showing does nothing.
    generation: u64,
}

/// Adds the cover to the freshly made main window, showing (the splash).
pub fn attach(app: &AppHandle, window: &tauri::Window) -> tauri::Result<()> {
    let size = window.inner_size()?;
    let cover = WebviewBuilder::new(LABEL, WebviewUrl::App("cover.html".into()))
        // Transparent only where the site shows through it as it fades: a transparent WebView2 shows black, not
        // the web view under it, and drops the color.
        .transparent(!cfg!(target_os = "windows"))
        .background_color(SKY)
        .auto_resize();
    window.add_child(cover, LogicalPosition::new(0.0, 0.0), size)?;
    let mut shown = lock(app);
    shown.since = Some((Instant::now(), OPENING));
    shown.generation += 1;
    Ok(())
}

fn lock(app: &AppHandle) -> std::sync::MutexGuard<'_, Shown> {
    app.state::<Cover>().inner().0.lock().unwrap_or_else(|e| e.into_inner())
}

/// Covers the site now (it is loading a whole page again), for at least `min`. Already covering (the
/// splash, when the first load starts), it keeps whatever minimum is left.
pub fn show(app: &AppHandle, min: Duration) {
    let Some(cover) = app.get_webview(LABEL) else { return };
    let was_shown = {
        let mut shown = lock(app);
        let now = Instant::now();
        let left = shown
            .since
            .map(|(since, before)| before.saturating_sub(since.elapsed()))
            .unwrap_or_default();
        let was_shown = shown.since.is_some();
        shown.generation += 1;
        shown.since = Some((now, min.max(left)));
        was_shown
    };
    if !was_shown {
        let _ = cover.eval("window.__coverShown?.()");
    }
    let _ = cover.show();
    // Typing goes to what shows, not to the page loading behind it.
    if window_is_key(app) {
        let _ = cover.set_focus();
    }
}

/// The main window is the one in front (focus moves only inside it, never brings it forward).
fn window_is_key(app: &AppHandle) -> bool {
    app.get_window(main_window::LABEL)
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false)
}

/// The site painted: the cover fades and steps aside (after its minimum, when it has one).
pub fn hide(app: &AppHandle) {
    let (wait, generation) = {
        let shown = lock(app);
        let Some((since, min)) = shown.since else { return };
        (min.saturating_sub(since.elapsed()), shown.generation)
    };
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(wait);
        let current = |app: &AppHandle| lock(app).generation == generation;
        let Some(cover) = app.get_webview(LABEL) else { return };
        if !current(&app) {
            return;
        }
        let _ = cover.eval("window.__coverFade?.()");
        std::thread::sleep(FADE);
        {
            let mut shown = lock(&app);
            if shown.generation != generation {
                return; // shown again meanwhile
            }
            shown.since = None;
        }
        let _ = cover.hide();
        if window_is_key(&app) {
            if let Some(site) = app.get_webview(main_window::LABEL) {
                let _ = site.set_focus();
            }
        }
    });
}

/// The site, once it painted its first screen (apps/web `pageReady`).
#[tauri::command]
pub fn page_ready(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    if webview.label() != main_window::LABEL {
        return Err("only the site says it painted".into());
    }
    hide(&app);
    Ok(())
}

/// The cover: the site is reachable again after it wasn't; load it (the cover stays until it paints).
#[tauri::command]
pub fn cover_retry(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    if webview.label() != LABEL {
        return Err("only the cover asks this".into());
    }
    let page = app.get_webview(main_window::LABEL).ok_or("no site")?;
    // A first load that never arrived leaves nothing to reload: go to the server again.
    let site = main_window::site(&app).ok_or("no server chosen")?;
    page.navigate(site).map_err(|e| e.to_string())
}

/// The cover: which server the window opens, to ask whether it answers and to name it when it doesn't.
#[tauri::command]
pub fn cover_server(app: AppHandle, webview: tauri::Webview) -> Result<Option<String>, String> {
    if webview.label() != LABEL {
        return Err("only the cover asks this".into());
    }
    Ok(main_window::site(&app).map(|s| s.origin().ascii_serialization()))
}

/// The cover: the site is up but never said it painted (an older site): stop covering it.
#[tauri::command]
pub fn cover_hide(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    if webview.label() != LABEL {
        return Err("only the cover asks this".into());
    }
    hide(&app);
    Ok(())
}
