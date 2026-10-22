//! The app's menus (telas/MenusDesktop.html): the menu bar and the site's right-click menu when the person
//! chose the system's look. The popover sends the menu bar's labels in the app's language (`app_menu_set`);
//! the site sends what its right-click menu has (`context_menu`) and the system draws it. What the site
//! handles goes back to it through `window.__agentesMenu(action)` and `window.__agentesContextMenu(token, id)`,
//! a call into the page, never a command the page can make; the rest stays here (Preferences, updates, zoom,
//! quit).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{AboutMetadataBuilder, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

use crate::main_window;

/// Menu bar items the site handles, with their shortcut (the site's own keys win: it handles them first).
const SITE_ACTIONS: &[(&str, Option<&str>)] = &[
    ("newChannel", Some("CmdOrCtrl+Shift+N")),
    ("newAgent", None),
    ("search", Some("CmdOrCtrl+K")),
    ("back", Some("CmdOrCtrl+[")),
    ("forward", Some("CmdOrCtrl+]")),
    ("toggleSidebar", Some("CmdOrCtrl+\\")),
    ("goHome", Some("CmdOrCtrl+1")),
    ("goWaiting", Some("CmdOrCtrl+2")),
    ("goTasks", Some("CmdOrCtrl+3")),
    ("goWiki", Some("CmdOrCtrl+4")),
    ("goDrive", Some("CmdOrCtrl+5")),
    ("orgSettings", Some("CmdOrCtrl+Shift+,")),
];

/// Zoom steps of the main window (⌘+ / ⌘− / ⌘0).
const ZOOM_STEPS: &[f64] = &[0.67, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75];

/// Where the main window's zoom is (`None`: 100%).
#[derive(Default)]
pub struct Zoom(Mutex<Option<usize>>);

impl Zoom {
    /// One step in or out (`by` ±1), or back to 100% (`by` 0).
    fn step(&self, by: i32) -> f64 {
        let base = ZOOM_STEPS.iter().position(|z| *z == 1.0).unwrap_or(0);
        let mut at = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let next = if by == 0 {
            base
        } else {
            (at.unwrap_or(base) as i32 + by).clamp(0, ZOOM_STEPS.len() as i32 - 1) as usize
        };
        *at = Some(next);
        ZOOM_STEPS[next]
    }
}

/// The page's own call for `action` (a fixed id, quoted as JSON).
fn site_call(function: &str, args: &[&str]) -> String {
    let args: Vec<String> = args.iter().map(|a| serde_json::to_string(a).unwrap_or_default()).collect();
    format!("window.{function}?.({})", args.join(","))
}

fn to_site(app: &AppHandle, js: String) {
    if let Some(page) = app.get_webview(main_window::LABEL) {
        let _ = page.eval(js);
    } else {
        // Nothing open to act on: the window comes, the person asks again from it.
        let _ = main_window::open(app, None);
    }
}

/// A menu bar or right-click choice (`on_menu_event` in lib.rs).
pub fn on_event(app: &AppHandle, id: &str) {
    if let Some(rest) = id.strip_prefix("ctx:") {
        if let Some((token, item)) = rest.split_once(':') {
            to_site(app, site_call("__agentesContextMenu", &[token, item]));
        }
        return;
    }
    let Some(action) = id.strip_prefix("app:") else { return };
    match action {
        "prefs" => {
            let _ = crate::present(app, "prefs");
        }
        // The popover owns updates, quitting (it asks first while agents are working) and access requests.
        "updates" | "quit" | "requests" | "thisMac" => {
            let _ = app.emit_to("popover", "menu://action", action);
        }
        "reload" => to_site(app, "location.reload()".into()),
        "zoomIn" | "zoomOut" | "zoomReset" => {
            let by = match action {
                "zoomIn" => 1,
                "zoomOut" => -1,
                _ => 0,
            };
            let scale = app.state::<Zoom>().step(by);
            if let Some(page) = app.get_webview(main_window::LABEL) {
                let _ = page.set_zoom(scale);
            }
        }
        _ if SITE_ACTIONS.iter().any(|(a, _)| *a == action) => to_site(app, site_call("__agentesMenu", &[action])),
        _ => {}
    }
}

/// The menu bar, with the popover's labels (missing ones fall back to the key, never empty).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn build_app_menu(app: &AppHandle, labels: &HashMap<String, String>) -> tauri::Result<Menu<tauri::Wry>> {
    let l = |key: &str| labels.get(key).map(String::as_str).unwrap_or(key).to_string();
    let site = |key: &str| -> tauri::Result<tauri::menu::MenuItem<tauri::Wry>> {
        let shortcut = SITE_ACTIONS.iter().find(|(a, _)| *a == key).and_then(|(_, s)| *s);
        let mut item = MenuItemBuilder::with_id(format!("app:{key}"), l(key));
        if let Some(s) = shortcut {
            item = item.accelerator(s);
        }
        item.build(app)
    };
    let own = |key: &str, shortcut: Option<&str>| -> tauri::Result<tauri::menu::MenuItem<tauri::Wry>> {
        let mut item = MenuItemBuilder::with_id(format!("app:{key}"), l(key));
        if let Some(s) = shortcut {
            item = item.accelerator(s);
        }
        item.build(app)
    };
    let sep = || PredefinedMenuItem::separator(app);
    let about = AboutMetadataBuilder::new()
        .name(Some(app.package_info().name.clone()))
        .version(Some(app.package_info().version.to_string()))
        .copyright(Some("agentes.chat"))
        .build();

    let app_menu = SubmenuBuilder::new(app, app.package_info().name.clone())
        .about_with_text(l("about"), Some(about))
        .item(&own("updates", None)?)
        .item(&sep()?)
        .item(&own("prefs", Some("CmdOrCtrl+,"))?)
        .item(&site("orgSettings")?)
        .item(&sep()?)
        .services_with_text(l("services"))
        .item(&sep()?)
        .hide_with_text(l("hide"))
        .hide_others_with_text(l("hideOthers"))
        .show_all_with_text(l("showAll"))
        .item(&sep()?)
        .item(&own("quit", Some("CmdOrCtrl+Q"))?)
        .build()?;
    let file = SubmenuBuilder::new(app, l("file"))
        .item(&site("newChannel")?)
        .item(&site("newAgent")?)
        .item(&sep()?)
        .item(&site("search")?)
        .item(&sep()?)
        .close_window_with_text(l("closeWindow"))
        .build()?;
    let edit = SubmenuBuilder::new(app, l("edit"))
        .undo_with_text(l("undo"))
        .redo_with_text(l("redo"))
        .item(&sep()?)
        .cut_with_text(l("cut"))
        .copy_with_text(l("copy"))
        .paste_with_text(l("paste"))
        .select_all_with_text(l("selectAll"))
        .build()?;
    let view = SubmenuBuilder::new(app, l("view"))
        .item(&site("back")?)
        .item(&site("forward")?)
        .item(&own("reload", Some("CmdOrCtrl+R"))?)
        .item(&sep()?)
        .item(&site("toggleSidebar")?)
        .item(&sep()?)
        .item(&own("zoomIn", Some("CmdOrCtrl+="))?)
        .item(&own("zoomOut", Some("CmdOrCtrl+-"))?)
        .item(&own("zoomReset", Some("CmdOrCtrl+0"))?)
        .item(&sep()?)
        .fullscreen_with_text(l("fullscreen"))
        .build()?;
    let go = SubmenuBuilder::new(app, l("go"))
        .item(&site("goHome")?)
        .item(&site("goWaiting")?)
        .item(&site("goTasks")?)
        .item(&site("goWiki")?)
        .item(&site("goDrive")?)
        .build()?;
    let window = SubmenuBuilder::new(app, l("window"))
        .minimize_with_text(l("minimize"))
        .maximize_with_text(l("zoom"))
        .item(&sep()?)
        .item(&own("thisMac", None)?)
        .item(&own("requests", None)?)
        .item(&sep()?)
        .bring_all_to_front_with_text(l("bringAllToFront"))
        .build()?;
    #[cfg(target_os = "macos")]
    let _ = window.set_as_windows_menu_for_nsapp();
    let items: [&Submenu<tauri::Wry>; 6] = [&app_menu, &file, &edit, &view, &go, &window];
    Menu::with_items(app, &items.map(|s| s as &dyn tauri::menu::IsMenuItem<tauri::Wry>))
}

const MAX_LABEL: usize = 120;

/// The popover's labels for the menu bar (it knows the app's language); only the popover sets them.
#[tauri::command]
pub fn app_menu_set(app: AppHandle, window: tauri::Window, labels: HashMap<String, String>) -> Result<(), String> {
    if window.label() != "popover" {
        return Err("only the popover sets the menu".into());
    }
    if labels.len() > 100 || labels.iter().any(|(k, v)| k.len() > 40 || v.chars().count() > MAX_LABEL) {
        return Err("bad labels".into());
    }
    // Windows and Linux would show it inside every window, the popover too: the menu bar is the Mac's.
    #[cfg(target_os = "macos")]
    {
        let menu = build_app_menu(&app, &labels).map_err(|e| e.to_string())?;
        app.set_menu(menu).map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, labels);
    Ok(())
}

/// One choice of the site's right-click menu.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ContextItem {
    Item {
        id: String,
        label: String,
        #[serde(default)]
        disabled: bool,
    },
    Header {
        label: String,
    },
    Separator,
    Submenu {
        label: String,
        items: Vec<ContextItem>,
    },
}

const MAX_ITEMS: usize = 60;

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// The menu checked: few items, short labels, plain ids, one level of submenus.
fn check(items: &[ContextItem], depth: usize, count: &mut usize) -> Result<(), String> {
    for item in items {
        *count += 1;
        if *count > MAX_ITEMS {
            return Err("too many items".into());
        }
        match item {
            ContextItem::Item { id, label, .. } => {
                if !valid_id(id) || label.is_empty() || label.chars().count() > MAX_LABEL {
                    return Err("bad item".into());
                }
            }
            ContextItem::Header { label } => {
                if label.chars().count() > MAX_LABEL {
                    return Err("bad header".into());
                }
            }
            ContextItem::Separator => {}
            ContextItem::Submenu { label, items } => {
                if depth > 0 || label.is_empty() || label.chars().count() > MAX_LABEL {
                    return Err("bad submenu".into());
                }
                check(items, depth + 1, count)?;
            }
        }
    }
    Ok(())
}

fn add_items<'a>(
    app: &'a AppHandle,
    token: u32,
    items: &[ContextItem],
    mut builder: SubmenuBuilder<'a, tauri::Wry, AppHandle>,
) -> tauri::Result<SubmenuBuilder<'a, tauri::Wry, AppHandle>> {
    for item in items {
        builder = match item {
            ContextItem::Item { id, label, disabled } => {
                let b = MenuItemBuilder::with_id(format!("ctx:{token}:{id}"), label).enabled(!disabled);
                builder.item(&b.build(app)?)
            }
            ContextItem::Header { label } => builder.item(&MenuItemBuilder::new(label).enabled(false).build(app)?),
            ContextItem::Separator => builder.separator(),
            ContextItem::Submenu { label, items } => {
                let sub = add_items(app, token, items, SubmenuBuilder::new(app, label))?.build()?;
                builder.item(&sub)
            }
        };
    }
    Ok(builder)
}

/// The site's right-click menu in the system's look: drawn at the pointer; the choice goes back to the page.
#[tauri::command]
pub fn context_menu(app: AppHandle, webview: tauri::Webview, token: u32, items: Vec<ContextItem>) -> Result<(), String> {
    // The site itself, not the cover that shares its window.
    if webview.label() != main_window::LABEL {
        return Err("only the main window asks this".into());
    }
    check(&items, 0, &mut 0)?;
    let menu = add_items(&app, token, &items, SubmenuBuilder::new(&app, ""))
        .and_then(|b| b.build())
        .map_err(|e| e.to_string())?;
    webview.window().popup_menu(&menu).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str) -> ContextItem {
        ContextItem::Item { id: id.into(), label: "Copiar".into(), disabled: false }
    }

    #[test]
    fn context_menus_are_checked() {
        assert!(check(&[item("copy"), ContextItem::Separator, item("reply")], 0, &mut 0).is_ok());
        assert!(check(&[item("bad id!")], 0, &mut 0).is_err());
        assert!(check(&[item("")], 0, &mut 0).is_err());
        let deep = ContextItem::Submenu {
            label: "Reagir".into(),
            items: vec![ContextItem::Submenu { label: "x".into(), items: vec![item("a")] }],
        };
        assert!(check(&[deep], 0, &mut 0).is_err());
        let many: Vec<_> = (0..=MAX_ITEMS).map(|n| item(&format!("i{n}"))).collect();
        assert!(check(&many, 0, &mut 0).is_err());
    }

    #[test]
    fn calls_into_the_page_are_quoted() {
        assert_eq!(site_call("__agentesMenu", &["newMessage"]), r#"window.__agentesMenu?.("newMessage")"#);
        assert_eq!(
            site_call("__agentesContextMenu", &["7", "copy\");alert(1)//"]),
            r#"window.__agentesContextMenu?.("7","copy\");alert(1)//")"#
        );
    }

    #[test]
    fn zoom_steps() {
        let z = Zoom::default();
        assert_eq!(z.step(0), 1.0);
        assert_eq!(z.step(1), 1.1);
        assert_eq!(z.step(-1), 1.0);
        for _ in 0..20 {
            z.step(-1);
        }
        assert_eq!(z.step(0), 1.0);
    }
}
