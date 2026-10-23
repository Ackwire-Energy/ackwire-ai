//! The Dock, like Slack's: the icon stays while the app runs (Preferências → Geral can take it away, back to
//! the menu bar only), its badge shows what waits on the person (the number, or a dot when there is only
//! unread), and it bounces once when something new waits while the app isn't in front.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, UserAttentionType};

use crate::main_window;

pub struct Dock {
    /// The person's choice (the popover sends it at start and when it changes).
    show: AtomicBool,
    /// What the badge showed last: `waiting` going up bounces the icon.
    last_waiting: Mutex<u32>,
}

impl Default for Dock {
    fn default() -> Self {
        Self { show: AtomicBool::new(true), last_waiting: Mutex::new(0) }
    }
}

pub fn shows(app: &AppHandle) -> bool {
    app.state::<Dock>().show.load(Ordering::Relaxed)
}

/// What the badge says: the count (99+ past 99), a dot for unread only, nothing otherwise.
pub fn label(waiting: u32, unread: u32) -> Option<String> {
    match (waiting, unread) {
        (0, 0) => None,
        (0, _) => Some("•".into()),
        (n, _) if n > 99 => Some("99+".into()),
        (n, _) => Some(n.to_string()),
    }
}

/// The site's counts (`this_mac` `badge`): the badge, and a bounce when more waits than before.
pub fn set_badge(app: &AppHandle, waiting: u32, unread: u32) {
    let Some(window) = app.get_window(main_window::LABEL).or_else(|| app.get_window("popover")) else { return };
    let _ = window.set_badge_label(label(waiting, unread));
    let more = {
        let mut last = app.state::<Dock>().last_waiting.lock().unwrap_or_else(|e| e.into_inner());
        let more = waiting > *last;
        *last = waiting;
        more
    };
    let in_front = app
        .get_window(main_window::LABEL)
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);
    if more && !in_front {
        let _ = window.request_user_attention(Some(UserAttentionType::Informational));
    }
}

/// Preferências → Geral → "Mostrar no Dock".
#[tauri::command]
pub fn dock_set(app: AppHandle, window: tauri::Window, show: bool) -> Result<(), String> {
    if !matches!(window.label(), "popover" | "prefs") {
        return Err("only the app's own windows set this".into());
    }
    app.state::<Dock>().show.store(show, Ordering::Relaxed);
    crate::sync_dock(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn badge_labels() {
        assert_eq!(label(0, 0), None);
        assert_eq!(label(0, 7), Some("•".into()));
        assert_eq!(label(3, 7), Some("3".into()));
        assert_eq!(label(120, 0), Some("99+".into()));
    }
}
