//! The servers this app opens and the one open now (`servers.json` in the app's config folder): agentes.chat,
//! a server of the person's own (an https address, or plain http on this computer), or several. The main
//! window loads the current one. agentes.chat's pages get the capability of `capabilities/main.json`; any
//! other server's get the same one, added at runtime for that origin only.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, Url};

/// agentes.chat Cloud.
pub const CLOUD: &str = "https://agentes.chat";
const FILE: &str = "servers.json";
/// Servers kept in the list; choosing another past this drops the oldest that isn't open.
const MAX_SERVERS: usize = 20;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ServerFile {
    /// The origin the main window opens; None until the first run chose one.
    pub current: Option<String>,
    pub servers: Vec<String>,
}

impl ServerFile {
    /// `origin` joins the list (once) and becomes the current one.
    pub fn choose(&mut self, origin: &str) {
        if !self.servers.iter().any(|s| s == origin) {
            self.servers.push(origin.to_string());
        }
        while self.servers.len() > MAX_SERVERS {
            let Some(pos) = self.servers.iter().position(|s| s != origin) else { break };
            self.servers.remove(pos);
        }
        self.current = Some(origin.to_string());
    }

    /// `old` is known by `new` now, in its place (the server here's address moves with reach).
    pub fn replace(&mut self, old: &str, new: &str) {
        let Some(pos) = self.servers.iter().position(|s| s == old) else { return };
        self.servers[pos] = new.to_string();
        // Already in the list too: it stays once, in its first place.
        let mut seen = false;
        self.servers.retain(|s| s != new || !std::mem::replace(&mut seen, true));
        if self.current.as_deref() == Some(old) {
            self.current = Some(new.to_string());
        }
    }

    /// `origin` leaves the list; when it was open, the first one left opens instead (or none: the first run).
    pub fn remove(&mut self, origin: &str) {
        self.servers.retain(|s| s != origin);
        if self.current.as_deref() == Some(origin) {
            self.current = self.servers.first().cloned();
        }
    }
}

#[derive(Default)]
pub struct Servers {
    file: Mutex<ServerFile>,
    /// Origins whose pages already got the main window's capability (it can be added only once).
    granted: Mutex<BTreeSet<String>>,
}

/// The origin of an address the app may open: https with a host, or plain http on this computer's own
/// loopback (nothing on the network sees it there); never with a user or password. None for anything else.
pub fn origin_of(url: &str) -> Option<String> {
    if url.len() > 2048 || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let parsed = Url::parse(url).ok()?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let host = parsed.host_str()?;
    let loopback = matches!(host, "localhost" | "[::1]") || host.starts_with("127.");
    match parsed.scheme() {
        "https" => Some(parsed.origin().ascii_serialization()),
        "http" if loopback => Some(parsed.origin().ascii_serialization()),
        _ => None,
    }
}

/// A server on this computer (`http://127.0.0.1:…`, `localhost`): `origin_of` takes plain http only there.
pub fn is_loopback(origin: &str) -> bool {
    origin.starts_with("http://")
}

/// What may follow a chosen server's origin: its sign-in or sign-up page, or a link's one-time sign-in
/// (`/desktop/handover#token=`) or owner claim (`/owner#claim=`), whose secrets the page takes out at once.
pub fn page_path(page: &str) -> bool {
    let secret = |s: &str| (20..=200).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    match page {
        "/login" | "/signup" => true,
        _ => page
            .strip_prefix("/desktop/handover#token=")
            .or_else(|| page.strip_prefix("/owner#claim="))
            .is_some_and(secret),
    }
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(FILE))
}

/// The list on disk; None the first time this version starts (nothing written yet).
pub fn read(app: &AppHandle) -> Option<ServerFile> {
    let text = fs::read_to_string(path(app)?).ok()?;
    let mut file: ServerFile = serde_json::from_str(&text).ok()?;
    // Anything that isn't an address the app may open is dropped, whoever wrote it.
    file.servers.retain(|s| origin_of(s).as_deref() == Some(s.as_str()));
    if file.current.as_ref().is_some_and(|c| !file.servers.contains(c)) {
        file.current = None;
    }
    Some(file)
}

fn write(app: &AppHandle, file: &ServerFile) {
    let Some(path) = path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    if let Ok(text) = serde_json::to_string_pretty(file) {
        if fs::write(&tmp, text).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }
}

fn lock(app: &AppHandle) -> std::sync::MutexGuard<'_, ServerFile> {
    app.state::<Servers>().inner().file.lock().unwrap_or_else(|e| e.into_inner())
}

/// At start: the list as it was, or the one the move from the menu bar app made (`runners::migrate`).
pub fn load(app: &AppHandle, file: ServerFile) {
    *lock(app) = file.clone();
    write(app, &file);
    for origin in &file.servers {
        grant(app, origin);
    }
}

pub fn get(app: &AppHandle) -> ServerFile {
    lock(app).clone()
}

pub fn current(app: &AppHandle) -> Option<Url> {
    lock(app).current.as_deref().and_then(|c| c.parse().ok())
}

/// `origin` becomes the server the main window opens.
pub fn choose(app: &AppHandle, origin: &str) {
    grant(app, origin);
    let file = {
        let mut file = lock(app);
        file.choose(origin);
        file.clone()
    };
    write(app, &file);
    crate::menus::servers_changed(app);
}

pub fn replace(app: &AppHandle, old: &str, new: &str) {
    grant(app, new);
    let file = {
        let mut file = lock(app);
        file.replace(old, new);
        file.clone()
    };
    write(app, &file);
    crate::menus::servers_changed(app);
}

pub fn remove(app: &AppHandle, origin: &str) {
    let file = {
        let mut file = lock(app);
        file.remove(origin);
        file.clone()
    };
    write(app, &file);
    crate::menus::servers_changed(app);
}

/// The main window's capability for a server other than agentes.chat, for its own origin only.
fn grant(app: &AppHandle, origin: &str) {
    if origin == CLOUD {
        return;
    }
    let state = app.state::<Servers>();
    let mut granted = state.inner().granted.lock().unwrap_or_else(|e| e.into_inner());
    if !granted.insert(origin.to_string()) {
        return;
    }
    let id: String = origin.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let capability = CapabilityBuilder::new(format!("main-{id}"))
        .remote(format!("{origin}/*"))
        .webview(crate::main_window::LABEL)
        .permission("core:window:allow-start-dragging")
        .permission("core:window:allow-internal-toggle-maximize")
        .permission("allow-this-mac")
        .permission("allow-context-menu")
        .permission("allow-page-ready");
    if let Err(err) = app.add_capability(capability) {
        eprintln!("agentes.chat: no capability for {origin}: {err}");
        granted.remove(origin);
    }
}

#[tauri::command]
pub fn servers_get(app: AppHandle) -> ServerFile {
    get(&app)
}

/// The welcome window, the popover or Preferences chose a server (the person confirmed it there): the main
/// window opens on it, on `page` when given.
#[tauri::command]
pub fn server_choose(app: AppHandle, server: String, page: Option<String>) -> Result<(), String> {
    let origin = origin_of(&server).filter(|o| *o == server).ok_or("not a server address")?;
    if page.as_deref().is_some_and(|p| !page_path(p)) {
        return Err("not a page to open".into());
    }
    choose(&app, &origin);
    let url: Url = format!("{origin}{}", page.as_deref().unwrap_or("")).parse().map_err(|_| "not a URL")?;
    crate::main_window::show_url(&app, url)
}

#[tauri::command]
pub fn server_remove(app: AppHandle, server: String) -> Result<(), String> {
    remove(&app, &server);
    if get(&app).current.is_none() {
        if let Some(window) = app.get_window(crate::main_window::LABEL) {
            let _ = window.hide();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_the_app_may_open() {
        assert_eq!(origin_of("https://agentes.tail1234.ts.net/login?x=1").as_deref(), Some("https://agentes.tail1234.ts.net"));
        assert_eq!(origin_of("https://chat.example.com:8443").as_deref(), Some("https://chat.example.com:8443"));
        assert_eq!(origin_of("http://127.0.0.1:4310").as_deref(), Some("http://127.0.0.1:4310"));
        assert_eq!(origin_of("http://localhost:3000/").as_deref(), Some("http://localhost:3000"));
        assert_eq!(origin_of("http://[::1]:4310").as_deref(), Some("http://[::1]:4310"));
        for bad in [
            "http://192.168.1.20:3000",
            "http://chat.example.com",
            "https://ana:secret@chat.example.com",
            "ftp://files.example.com",
            "agenteschat://connect?server=x",
            "https://agentes.chat/ x",
            "",
        ] {
            assert_eq!(origin_of(bad), None, "{bad}");
        }
        assert!(is_loopback("http://127.0.0.1:4310"));
        assert!(!is_loopback(CLOUD));
    }

    #[test]
    fn pages_that_may_follow_a_server() {
        let token = "Ab0-_".repeat(8);
        assert!(page_path("/login"));
        assert!(page_path("/signup"));
        assert!(page_path(&format!("/desktop/handover#token={token}")));
        assert!(page_path(&format!("/owner#claim={token}")));
        assert!(!page_path("/desktop/handover#token=short"));
        assert!(!page_path(&format!("/owner#claim={token}&x=<script>")));
        assert!(!page_path("/org/x"));
        assert!(!page_path("//evil.example/login"));
        assert!(!page_path(""));
    }

    #[test]
    fn choosing_and_removing() {
        let mut file = ServerFile::default();
        file.choose(CLOUD);
        file.choose("https://agentes.tail1234.ts.net");
        file.choose(CLOUD);
        assert_eq!(file.servers, vec![CLOUD.to_string(), "https://agentes.tail1234.ts.net".to_string()]);
        assert_eq!(file.current.as_deref(), Some(CLOUD));
        file.remove(CLOUD);
        assert_eq!(file.current.as_deref(), Some("https://agentes.tail1234.ts.net"));
        file.remove("https://agentes.tail1234.ts.net");
        assert_eq!(file, ServerFile::default());
        for n in 0..30 {
            file.choose(&format!("https://s{n}.example.com"));
        }
        assert_eq!(file.servers.len(), MAX_SERVERS);
        assert_eq!(file.current.as_deref(), Some("https://s29.example.com"));
    }

    #[test]
    fn the_server_here_moves_with_reach() {
        let here = "http://127.0.0.1:4310";
        let tailnet = "https://ana-mac.tail1234.ts.net";
        let mut file = ServerFile { current: Some(here.into()), servers: vec![CLOUD.into(), here.into()] };
        file.replace(here, tailnet);
        assert_eq!(file, ServerFile { current: Some(tailnet.into()), servers: vec![CLOUD.into(), tailnet.into()] });
        file.replace(tailnet, here);
        assert_eq!(file.servers, vec![CLOUD.to_string(), here.to_string()]);
        file.current = Some(CLOUD.into());
        file.replace("https://unknown.example.com", tailnet);
        assert_eq!(file.servers, vec![CLOUD.to_string(), here.to_string()], "only a server of the list moves");
    }
}
