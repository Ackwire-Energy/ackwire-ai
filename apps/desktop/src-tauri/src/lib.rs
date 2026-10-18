//! agentes for macOS (ADR 0036): a menu bar icon, a popover and two small windows around the
//! runners it spawns, one per organization. Rust stays thin: tray, windows, the runner children,
//! single instance, start at login, notifications and native dialogs. Everything else lives in the
//! runner (TypeScript) and in the web view.

mod runners;
mod tray;

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_positioner::{Position, WindowExt};

use runners::{RunnerInfo, Runners};

/// The only site the app opens (in the person's browser, never inside the app).
const SITE: &str = "https://agentes.chat";
const WINDOWS: &[&str] = &["popover", "welcome", "prefs"];

/// When the popover last hid because it lost focus: a click on the tray icon blurs it first,
/// and that same click must not open it again.
struct PopoverClock(Mutex<Option<Instant>>);

#[derive(Serialize)]
struct AppInfo {
    version: String,
    os: &'static str,
    arch: &'static str,
}

fn is_site_url(url: &str) -> bool {
    if url.len() > 4096 || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    url == SITE || url.starts_with("https://agentes.chat/") || url.starts_with("https://agentes.chat?")
}

pub(crate) fn present(app: &AppHandle, name: &str) -> Result<(), String> {
    if !WINDOWS.contains(&name) {
        return Err(format!("unknown window: {name}"));
    }
    let window = app.get_webview_window(name).ok_or("window not found")?;
    if name == "popover" {
        // Right under the menu bar icon.
        let _ = window.move_window(Position::TrayCenter);
    }
    let _ = window.unminimize();
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    let _ = app.emit("window://shown", name);
    Ok(())
}

pub(crate) fn toggle_popover(app: &AppHandle) {
    let Some(window) = app.get_webview_window("popover") else { return };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    let clock = app.state::<PopoverClock>();
    let just_hid = clock
        .0
        .lock()
        .ok()
        .and_then(|at| *at)
        .map(|at| at.elapsed() < Duration::from_millis(300))
        .unwrap_or(false);
    if !just_hid {
        let _ = present(app, "popover");
    }
}

/// Graceful quit: every runner gets `shutdown` and a few seconds, then the app exits.
fn begin_quit(app: AppHandle) {
    let runners = app.state::<Runners>();
    if runners.is_quitting() {
        return;
    }
    for name in WINDOWS {
        if let Some(window) = app.get_webview_window(name) {
            let _ = window.hide();
        }
    }
    std::thread::spawn(move || {
        app.state::<Runners>().shutdown_all();
        app.exit(0);
    });
}

#[tauri::command]
fn runners_list(runners: tauri::State<'_, Runners>) -> Vec<RunnerInfo> {
    runners.list()
}

#[tauri::command]
fn runner_send(runners: tauri::State<'_, Runners>, home_id: String, line: String) -> Result<(), String> {
    runners.send(&home_id, &line)
}

#[tauri::command]
fn runner_add(app: AppHandle, runners: tauri::State<'_, Runners>) -> Result<String, String> {
    runners.add(&app)
}

#[tauri::command]
async fn runner_remove(app: AppHandle, home_id: String) -> Result<(), String> {
    // Stopping waits for the runner to finish: off the main thread.
    tauri::async_runtime::spawn_blocking(move || app.state::<Runners>().remove(&app, &home_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !is_site_url(&url) {
        return Err("only agentes.chat links open from the app".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_folder(app: AppHandle, path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_absolute() || !p.is_dir() {
        return Err("not a folder".into());
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    let picked = app.dialog().file().blocking_pick_folder()?;
    picked.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn set_tray_state(app: AppHandle, state: String) -> Result<(), String> {
    tray::set_state(&app, &state)
}

#[tauri::command]
fn show_window(app: AppHandle, name: String) -> Result<(), String> {
    present(&app, &name)
}

#[tauri::command]
fn hide_window(app: AppHandle, name: String) -> Result<(), String> {
    if !WINDOWS.contains(&name.as_str()) {
        return Err(format!("unknown window: {name}"));
    }
    let window = app.get_webview_window(&name).ok_or("window not found")?;
    window.hide().map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    begin_quit(app);
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

#[tauri::command]
fn autostart_get(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_set(app: AppHandle, on: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let result = if on { launcher.enable() } else { launcher.disable() };
    result.map_err(|e| e.to_string())
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

pub fn run() {
    let app = tauri::Builder::default()
        // First: a second launch only shows the popover of the running app.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = present(app, "popover");
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_positioner::init())
        .manage(Runners::default())
        .manage(PopoverClock(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            runners_list,
            runner_send,
            runner_add,
            runner_remove,
            open_external,
            reveal_folder,
            pick_folder,
            set_tray_state,
            show_window,
            hide_window,
            quit_app,
            app_info,
            autostart_get,
            autostart_set,
            notify
        ])
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(false) if window.label() == "popover" => {
                let _ = window.hide();
                if let Ok(mut at) = window.app_handle().state::<PopoverClock>().0.lock() {
                    *at = Some(Instant::now());
                }
            }
            WindowEvent::CloseRequested { api, .. } => {
                // Windows are made once and only hidden; quitting goes through "Sair".
                api.prevent_close();
                let _ = window.hide();
            }
            _ => {}
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            tray::create(app.handle())?;
            let handle = app.handle().clone();
            let runners = app.state::<Runners>();
            runners.start_all(&handle);
            if runners.is_empty() {
                let _ = present(&handle, "welcome");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building agentes");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            if !app.state::<Runners>().is_shut_down() {
                api.prevent_exit();
                begin_quit(app.clone());
            }
        }
    });
}
