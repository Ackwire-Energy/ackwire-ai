// The app's own commands are listed here so Tauri generates an `allow-<command>` permission for each;
// every window then gets only the ones it needs (capabilities/*.json).
const COMMANDS: &[&str] = &[
    "runners_list",
    "runner_send",
    "runner_add",
    "runner_remove",
    "open_external",
    "reveal_folder",
    "pick_folder",
    "set_tray_state",
    "show_window",
    "hide_window",
    "quit_app",
    "app_info",
    "autostart_get",
    "autostart_set",
    "notify",
    "update_install",
    "notch_set",
    "notch_info",
    "notch_place",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
