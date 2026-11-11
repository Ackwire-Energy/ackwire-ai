//! "Prepare this Mac" (ADR 0165): the macOS permissions agents need here, asked by the app right after pairing so
//! nothing stops them later, and the setup that comes back when macOS quits the app for Screen Recording ("Quit &
//! Reopen"). The runners are the app's children, so what the app is granted covers them: the system names the app
//! when a runner's `screencapture` asks. On Windows and Linux there is nothing to ask and every answer is yes.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_opener::OpenerExt;

/// The setup kept in the app's data folder while it is on screen: what the page sent, the time and the main
/// window's page (`setup_state_set`).
const FILE: &str = "setup.json";
/// "Quit & Reopen" opens the app again within seconds; a setup older than this was left, not interrupted.
const RESUME_WITHIN_SECS: u64 = 30 * 60;
/// A page's setup is a few short fields.
const MAX_BYTES: usize = 4096;

/// The app opened again on the setup that was on screen (`setup_state_get` says so once, until the next write).
#[derive(Default)]
pub struct Resumed(AtomicBool);

#[derive(Debug, PartialEq)]
pub struct Resume {
    /// `welcome` (the pairing's Prepare step) or `prefs`.
    pub window: &'static str,
    /// The main window's page when the setup was kept.
    pub page: Option<Url>,
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join(FILE))
}

fn read(app: &AppHandle) -> Option<Value> {
    let bytes = std::fs::read(file(app)?).ok()?;
    serde_json::from_slice(&bytes).ok().filter(Value::is_object)
}

fn forget(app: &AppHandle) {
    if let Some(path) = file(app) {
        let _ = std::fs::remove_file(path);
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// What to open again for a kept setup, if it is recent enough to be one macOS interrupted.
fn resume_of(state: &Value, now: u64) -> Option<Resume> {
    let at = state.get("at")?.as_u64()?;
    if at > now || now - at > RESUME_WITHIN_SECS {
        return None;
    }
    let window = match state.get("step")?.as_str()? {
        "prepare" => "welcome",
        "prefs" => "prefs",
        _ => return None,
    };
    let page = state.get("page").and_then(Value::as_str).and_then(|p| p.parse().ok());
    Some(Resume { window, page })
}

/// At launch: the setup to open again, unless the app started at login (it stays in the background then) or it was
/// left long ago, which is forgotten.
pub fn resume(app: &AppHandle, at_login: bool) -> Option<Resume> {
    let state = read(app)?;
    let resume = resume_of(&state, now()).filter(|_| !at_login);
    match &resume {
        Some(_) => app.state::<Resumed>().0.store(true, Ordering::Relaxed),
        None => forget(app),
    }
    resume
}

/// Its window closed by hand: the setup ends with it (quitting never closes windows, so a kept setup survives that).
pub fn closed(app: &AppHandle, label: &str) {
    let kept = read(app).and_then(|s| resume_of(&s, now())).map(|r| r.window);
    if kept.is_none_or(|window| window == label) {
        forget(app);
    }
}

/// The main window's page, when it shows a server of the app's.
fn main_page(app: &AppHandle) -> Option<String> {
    let url = app.get_webview(crate::main_window::LABEL)?.url().ok()?;
    let origin = url.origin().ascii_serialization();
    crate::servers::get(app).servers.contains(&origin).then(|| url.to_string())
}

#[tauri::command]
pub fn setup_state_get(app: AppHandle) -> Option<Value> {
    let mut state = read(&app)?;
    resume_of(&state, now())?;
    state["resumed"] = Value::Bool(app.state::<Resumed>().0.load(Ordering::Relaxed));
    Some(state)
}

/// Keeps the setup on screen (with the time and the main window's page), or, null, forgets it.
#[tauri::command]
pub fn setup_state_set(app: AppHandle, state: Option<Value>) -> Result<(), String> {
    app.state::<Resumed>().0.store(false, Ordering::Relaxed);
    let Some(mut state) = state else {
        forget(&app);
        return Ok(());
    };
    let Some(fields) = state.as_object_mut() else { return Err("not a setup".into()) };
    fields.remove("resumed");
    fields.insert("at".into(), now().into());
    match main_page(&app) {
        Some(page) => fields.insert("page".into(), page.into()),
        None => fields.remove("page"),
    };
    let bytes = serde_json::to_vec(&state).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("setup too large".into());
    }
    let path = file(&app).ok_or("no data folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// `ask`: the system's prompt the first time (it lists the app under Screen Recording); either way, whether the app
/// may record the screen now, which changes only once it opens again.
#[cfg(target_os = "macos")]
fn screen_allowed(ask: bool) -> bool {
    // SAFETY: CoreGraphics calls without arguments, on macOS 10.15 and later (the app needs 11).
    unsafe {
        if ask {
            CGRequestScreenCaptureAccess()
        } else {
            CGPreflightScreenCaptureAccess()
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn screen_allowed(_ask: bool) -> bool {
    true
}

#[tauri::command]
pub fn screen_access() -> bool {
    screen_allowed(false)
}

#[tauri::command]
pub fn screen_request() -> bool {
    screen_allowed(true)
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Folder {
    Desktop,
    Documents,
    Downloads,
}

/// Whether the app may list `dir`. On a Mac the first look at a protected folder raises the system's prompt and waits
/// for the answer; a refusal reads as "operation not permitted". A folder that isn't there has nothing to allow.
fn readable(dir: &Path) -> bool {
    let denied = |e: &io::Error| e.kind() == io::ErrorKind::PermissionDenied;
    match std::fs::read_dir(dir) {
        Ok(mut entries) => !matches!(entries.next(), Some(Err(e)) if denied(&e)),
        Err(e) => !denied(&e),
    }
}

/// Off the main thread: the read may wait on the system's prompt.
#[tauri::command]
pub async fn folder_access(app: AppHandle, folder: Folder) -> Result<bool, String> {
    let path = app.path();
    let dir = match folder {
        Folder::Desktop => path.desktop_dir(),
        Folder::Documents => path.document_dir(),
        Folder::Downloads => path.download_dir(),
    }
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || readable(&dir)).await.map_err(|e| e.to_string())
}

/// System Settings › Privacy & Security on one pane.
fn pane_url(pane: &str) -> Option<String> {
    let anchor = match pane {
        "screen" => "Privacy_ScreenCapture",
        "files" => "Privacy_FilesAndFolders",
        _ => return None,
    };
    Some(format!("x-apple.systempreferences:com.apple.preference.security?{anchor}"))
}

#[tauri::command]
pub fn privacy_open(app: AppHandle, pane: String) -> Result<(), String> {
    let url = pane_url(&pane).ok_or("unknown pane")?;
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_setup_left_minutes_ago_comes_back_in_its_window_and_an_old_or_odd_one_does_not() {
        let at = 1_000_000;
        let prepare = json!({ "step": "prepare", "org": "Acme", "at": at, "page": "https://app.agentes.chat/org/o1" });
        assert_eq!(
            resume_of(&prepare, at + 60),
            Some(Resume { window: "welcome", page: Some("https://app.agentes.chat/org/o1".parse().unwrap()) })
        );
        assert_eq!(resume_of(&json!({ "step": "prefs", "at": at }), at), Some(Resume { window: "prefs", page: None }));
        assert_eq!(resume_of(&prepare, at + RESUME_WITHIN_SECS + 1), None);
        assert_eq!(resume_of(&prepare, at - 1), None);
        assert_eq!(resume_of(&json!({ "step": "other", "at": at }), at), None);
        assert_eq!(resume_of(&json!({ "step": "prepare" }), at), None);
    }

    #[test]
    fn a_folder_reads_as_allowed_unless_listing_it_is_refused() {
        let dir = std::env::temp_dir().join(format!("agentes-prepare-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(readable(&dir));
        assert!(readable(&dir.join("missing")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let locked = dir.join("locked");
            std::fs::create_dir_all(&locked).unwrap();
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
            // Root lists anything; everyone else is refused.
            // SAFETY: geteuid has no preconditions.
            let root = unsafe { libc::geteuid() } == 0;
            assert_eq!(readable(&locked), root);
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_the_two_privacy_panes_open() {
        assert_eq!(
            pane_url("screen").as_deref(),
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        );
        assert_eq!(
            pane_url("files").as_deref(),
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")
        );
        assert_eq!(pane_url("x-apple.systempreferences:com.apple.Accounts"), None);
    }
}
