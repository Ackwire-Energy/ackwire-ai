//! agentes.chat for macOS, Windows and Linux: the main window on the server open now (agentes.chat or a
//! server of the person's own, `servers`), the welcome window that finds one, and, only while agents work on
//! this computer for a server of the person's own, the runners it spawns (one per organization), the menu bar
//! popover and Preferences' tabs for this computer. On a Mac or Linux it can also run agentes.chat itself, as
//! its child (`local_server`, with this computer as its agents' computer, `host_sync`). Rust stays thin:
//! windows, the tray, the server list, links, the children, single instance, start at login, notifications,
//! native dialogs and self-update. Everything else lives in the runner and the server (TypeScript) and in the
//! web view.

mod cover;
mod deep_link;
mod discover;
mod dock;
mod host_sync;
mod local_server;
mod main_window;
mod menus;
mod notch;
mod runners;
mod servers;
mod tailscale;
mod tray;
mod window_state;

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Url, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_positioner::{Position, WindowExt};
use tauri_plugin_updater::UpdaterExt;

use runners::{RunnerInfo, Runners};

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

/// The providers' own sign-in pages the runner gets from `claude auth login` / `codex login --device-auth`
/// (ADR 0041): the account dialog's "Open the link" when the browser didn't open by itself.
fn is_sign_in_url(url: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "https://claude.com/cai/oauth/authorize?",
        "https://claude.ai/oauth/authorize?",
        "https://auth.openai.com/codex/device",
    ];
    PREFIXES.iter().any(|p| url.starts_with(p))
}

/// The app's own builds ("Download version …" in Updates), whichever server it opens.
fn is_app_download(url: &str) -> bool {
    url.starts_with("https://agentes.chat/api/desktop/download/")
}

/// The windows that make the app "open" like any other: while one is showing, the app has a Dock icon
/// (with the open-window dot, clickable), even when the person took it out of the Dock.
const APP_WINDOWS: &[&str] = &["welcome", "prefs", main_window::LABEL];

/// The Dock icon: always, like Slack's (dock.rs), or, when the person turned that off, only while an app
/// window is visible (macOS).
pub(crate) fn sync_dock(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        // By window, not web view: the main window holds two (the site and its cover).
        let open = dock::shows(app)
            || APP_WINDOWS.iter().any(|name| {
                app.get_window(name)
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(false)
            });
        let policy = if open {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        let _ = app.set_activation_policy(policy);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub(crate) fn present(app: &AppHandle, name: &str) -> Result<(), String> {
    if !WINDOWS.contains(&name) {
        return Err(format!("unknown window: {name}"));
    }
    let window = match app.get_webview_window(name) {
        Some(window) => window,
        None => make_window(app, name)?,
    };
    if name == "popover" {
        // Right under the menu bar icon.
        let _ = window.move_window(Position::TrayCenter);
    }
    let _ = window.unminimize();
    window.show().map_err(|e| e.to_string())?;
    if APP_WINDOWS.contains(&name) {
        sync_dock(app);
    }
    window.set_focus().map_err(|e| e.to_string())?;
    let _ = app.emit("window://shown", name);
    Ok(())
}

/// Welcome and Preferences are made when they open and go when they close (`"create": false` in
/// tauri.conf.json): each is a whole web view, kept alive for nothing otherwise.
const MADE_ON_OPEN: &[&str] = &["welcome", "prefs"];

fn make_window(app: &AppHandle, name: &str) -> Result<tauri::WebviewWindow, String> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == name)
        .ok_or("window not found")?
        .clone();
    tauri::WebviewWindowBuilder::from_config(app, &config)
        .and_then(|b| b.build())
        .map_err(|e| e.to_string())
}

/// The launch argument start at login passes, so a login start stays in the menu bar.
const AUTOSTART_ARG: &str = "--autostart";

/// "Open the app": the main window on the server open now, or the first run while there is none.
pub(crate) fn open_app(app: &AppHandle) {
    if servers::current(app).is_some() {
        let _ = main_window::open(app, None);
    } else {
        let _ = present(app, "welcome");
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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

/// The children finish their work: every runner gets `shutdown` and a few seconds, and the server here
/// drains (at most 25 s), side by side.
fn stop_children(app: &AppHandle) {
    let server = {
        let app = app.clone();
        std::thread::spawn(move || local_server::shutdown(&app))
    };
    app.state::<Runners>().shutdown_all();
    let _ = server.join();
}

/// Graceful quit: the children stop, then the app exits.
fn begin_quit(app: AppHandle) {
    let runners = app.state::<Runners>();
    if runners.is_quitting() {
        return;
    }
    if let Some(window) = app.get_window(main_window::LABEL) {
        window_state::remember(&window, false);
    }
    for name in WINDOWS.iter().chain([&main_window::LABEL, &notch::LABEL]) {
        if let Some(window) = app.get_window(name) {
            let _ = window.hide();
        }
    }
    std::thread::spawn(move || {
        stop_children(&app);
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

/// A page of a server this app opens goes to the main window, on that server; a provider's sign-in page and
/// the app's own downloads open in the person's browser. Nothing else.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if url.len() > 4096 || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("not a link the app opens".into());
    }
    if is_sign_in_url(&url) || is_app_download(&url) {
        return app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string());
    }
    let page: Url = url.parse().map_err(|_| "not a URL")?;
    main_window::show_url(&app, page)
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
    let Some(window) = app.get_webview_window(&name) else { return Ok(()) };
    if MADE_ON_OPEN.contains(&name.as_str()) {
        window.destroy().map_err(|e| e.to_string())?;
    } else {
        window.hide().map_err(|e| e.to_string())?;
    }
    sync_dock(&app);
    Ok(())
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

/// Downloads and installs the newer version (signed with the key built into the app, checked by
/// the plugin), stops the runners and relaunches. `false`: nothing newer to install.
#[tauri::command]
async fn update_install(app: AppHandle) -> Result<bool, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    // The runners and the server here finish their work first, as when quitting; then the new app opens
    // (and starts the server here's new version, `local_server`).
    tauri::async_runtime::spawn_blocking(move || {
        stop_children(&app);
        app.restart();
    });
    Ok(true)
}

/// Turns the notch on or off (Preferences › General; the popover applies the saved choice at start).
#[tauri::command]
async fn notch_set(app: AppHandle, on: bool) -> Result<(), String> {
    notch::set_enabled(&app, on)
}

#[tauri::command]
async fn notch_info(app: AppHandle) -> Result<Option<notch::NotchInfo>, String> {
    notch::info(&app)
}

#[tauri::command]
async fn notch_place(app: AppHandle, width: f64, height: f64) -> Result<Option<notch::NotchInfo>, String> {
    notch::place(&app, width, height)
}

/// The app was "agentes" before it became "agentes.chat", and the login item is named after the app: the old
/// one goes and, if it was on, the new one takes its place.
fn migrate_login_item(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Ok(home) = app.path().home_dir() {
        let old = home.join("Library/LaunchAgents/agentes.plist");
        if old.exists() && std::fs::remove_file(&old).is_ok() {
            let _ = app.autolaunch().enable();
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// The servers at start: as they were, or (the first start of an app that keeps a list) from the menu bar
/// app's homes, whose Cloud ones retire before any runner starts (`runners::migrate`).
fn starting_servers(app: &AppHandle) -> servers::ServerFile {
    if let Some(file) = servers::read(app) {
        return file;
    }
    let moved = runners::migrate(app);
    let mut list = moved.servers;
    if !moved.retire.is_empty() {
        list.push(servers::CLOUD.to_string());
        menus::retired_cloud_homes(app, moved.retired.unwrap_or_else(|| "~/agentes".into()));
    }
    servers::ServerFile { current: list.first().cloned(), servers: list }
}

pub fn run() {
    let builder = tauri::Builder::default()
        // First: a second launch brings the running app's window back; one carrying a link (Windows,
        // Linux) goes to the deep-link plugin first (`deep_link.rs` shows it).
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if !deep_link::in_args(&argv) {
                open_app(app);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![AUTOSTART_ARG])))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Runners::default())
        .manage(PopoverClock(Mutex::new(None)))
        .manage(servers::Servers::default())
        .manage(local_server::LocalServer::default())
        .manage(host_sync::HostSync::default())
        .manage(deep_link::PendingLink::default())
        .manage(main_window::Bridge::default())
        .manage(main_window::Notices::default())
        .manage(menus::Zoom::default())
        .manage(cover::Cover::default())
        .manage(dock::Dock::default())
        .manage(menus::MenuParts::default())
        .manage(window_state::LastSaved::default())
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
            notify,
            update_install,
            notch_set,
            notch_info,
            notch_place,
            servers::servers_get,
            servers::server_choose,
            servers::server_remove,
            discover::discover,
            deep_link::link_take,
            local_server::local_server_status,
            local_server::local_server_install,
            local_server::local_server_start,
            local_server::local_server_stop,
            local_server::local_server_restart,
            local_server::local_server_reach,
            local_server::local_server_usage,
            local_server::local_server_backup,
            local_server::local_server_diagnostics,
            local_server::local_server_sync,
            tailscale::tailscale_status,
            tailscale::tailscale_open,
            tray::tray_visible,
            main_window::this_mac,
            main_window::this_mac_reply,
            main_window::this_mac_listening,
            main_window::notify_site_set,
            dock::dock_set,
            menus::app_menu_set,
            menus::context_menu,
            cover::page_ready,
            cover::cover_retry,
            cover::cover_hide,
            cover::cover_server
        ])
        .on_menu_event(|app, event| menus::on_event(app, event.id().as_ref()))
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(false) if window.label() == "popover" => {
                let _ = window.hide();
                if let Ok(mut at) = window.app_handle().state::<PopoverClock>().0.lock() {
                    *at = Some(Instant::now());
                }
            }
            WindowEvent::Focused(true) if window.label() == main_window::LABEL => {
                main_window::focused(window.app_handle());
            }
            // Welcome and Preferences really close (made again when they open).
            WindowEvent::CloseRequested { .. } if MADE_ON_OPEN.contains(&window.label()) => {}
            WindowEvent::Destroyed if MADE_ON_OPEN.contains(&window.label()) => sync_dock(window.app_handle()),
            WindowEvent::CloseRequested { api, .. } => {
                // The other windows are made once and only hidden; quitting goes through "Quit".
                api.prevent_close();
                if window.label() == main_window::LABEL {
                    window_state::remember(window, false);
                    // Some Linux desktops show no tray icon: there the window stays in reach, minimized.
                    #[cfg(target_os = "linux")]
                    {
                        let _ = window.minimize();
                        return;
                    }
                    // ⌘W in full screen: out of full screen first, so no empty Space stays behind.
                    #[cfg(not(target_os = "linux"))]
                    if window.is_fullscreen().unwrap_or(false) {
                        let _ = window.set_fullscreen(false);
                        let window = window.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(700));
                            let _ = window.hide();
                            sync_dock(window.app_handle());
                        });
                        return;
                    }
                }
                let _ = window.hide();
                sync_dock(window.app_handle());
            }
            WindowEvent::Moved(_) if window.label() == main_window::LABEL => window_state::remember(window, true),
            WindowEvent::Resized(_) if window.label() == main_window::LABEL => {
                window_state::remember(window, true);
                // Full screen in or out: the page's title bar keeps or drops the room for the buttons.
                main_window::fit_page(window.app_handle());
            }
            WindowEvent::ThemeChanged(theme) if window.label() == main_window::LABEL => {
                let color = main_window::backdrop(*theme);
                let _ = window.set_background_color(Some(color));
                if let Some(page) = window.app_handle().get_webview(main_window::LABEL) {
                    let _ = page.set_background_color(Some(color));
                }
            }
            _ => {}
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = app.handle().clone();
            // Before the tray (it lists them) and before any runner (Cloud homes retire first).
            servers::load(&handle, starting_servers(&handle));
            tray::create(&handle)?;
            migrate_login_item(&handle);
            // Start at login written before the flag existed: write it again, now with the flag.
            let launcher = handle.autolaunch();
            if launcher.is_enabled().unwrap_or(false) {
                let _ = launcher.enable();
            }
            // The server here first (its own homes start with the rest); nothing starts without homes: in the
            // Cloud, or with a server whose agents work elsewhere.
            local_server::load(&handle);
            app.state::<Runners>().start_all(&handle);
            host_sync::start(&handle);
            deep_link::setup(&handle);
            // Started at login: in the background (the popover, the tray). Opened by hand: the main window on
            // the server open now, or the first run while there is none.
            let at_login = std::env::args().any(|a| a == AUTOSTART_ARG);
            if servers::current(&handle).is_none() {
                let _ = present(&handle, "welcome");
            } else if !at_login {
                let _ = main_window::open(&handle, None);
            }
            // In the Dock from the start, like Slack (the popover then applies the person's choice).
            sync_dock(&handle);
            Ok(())
        });
    // After long in the background macOS may end a window's page to free memory, which leaves it blank:
    // it loads again (the site opens from the disk cache, so it is back at once).
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        if webview.label() == main_window::LABEL {
            cover::show(webview.app_handle(), std::time::Duration::ZERO);
        }
        let _ = webview.reload();
    });
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building agentes.chat");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            if !app.state::<Runners>().is_shut_down() {
                api.prevent_exit();
                begin_quit(app.clone());
            }
        }
        // A click on the Dock icon: bring the app's window back.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => open_app(app),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_opens_in_the_browser() {
        assert!(is_sign_in_url("https://claude.ai/oauth/authorize?client_id=x"));
        assert!(is_app_download("https://agentes.chat/api/desktop/download/0.6.0/agentes_0.6.0_universal.dmg"));
        assert!(!is_app_download("https://agentes.chat.evil.com/api/desktop/download/x"));
        assert!(!is_sign_in_url("https://claude.ai.evil.com/oauth/authorize?"));
    }
}
