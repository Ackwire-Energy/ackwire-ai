//! Workspaces across servers (ADR 0154): every server of the list, read with that server's own session (the
//! cookies the main window keeps for it, `cookies_for_url`), the way the phone app asks (no `Origin`,
//! `X-Agentes-Client: mobile`): its workspaces (`GET /api/app/me`) and their unread counts (`GET /api/app/me/unread`),
//! every minute and when the window comes to the front. The site's workspace menu lists them by server
//! (`this_mac` `workspaces`), Preferences › Servers shows them under each server, and a server not open in the window
//! that has new unread notifications says so with the system's notification, named after the workspace and server.

use std::collections::HashMap;
use std::io::Read;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, Url};

use crate::{main_window, servers};

/// How often every server is asked.
const EVERY: Duration = Duration::from_secs(60);
/// The window coming to the front asks again, at most this often.
const FOCUS_GAP: Duration = Duration::from_secs(15);
/// The site's menu asks for a fresh list when the last one is older than this.
const STALE: Duration = Duration::from_secs(30);
const TIMEOUT: Duration = Duration::from_secs(10);
/// Workspaces kept per server.
const MAX_ORGS: usize = 50;
/// A workspace's logo, as a data URL (larger ones show the workspace's mark instead).
const LOGO_MAX: u64 = 256 * 1024;
/// A JSON answer's size.
const BODY_MAX: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Org {
    pub id: String,
    pub name: String,
    /// A data URL; None shows the workspace's mark.
    pub logo: Option<String>,
    pub unread: u64,
    pub waiting: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerWorkspaces {
    pub server: String,
    /// Its session in the window's cookies still answers; false lists no workspace (sign in there again).
    pub signed_in: bool,
    pub orgs: Vec<Org>,
}

#[derive(Default)]
pub struct Workspaces(Mutex<State>);

#[derive(Default)]
struct State {
    /// The last answer of each server, in the list's order.
    list: Vec<ServerWorkspaces>,
    /// Logos already read, by their address (None: none to show).
    logos: HashMap<String, Option<String>>,
    checked: Option<Instant>,
    asked_on_focus: Option<Instant>,
    wake: Option<mpsc::Sender<()>>,
}

fn lock(app: &AppHandle) -> std::sync::MutexGuard<'_, State> {
    app.state::<Workspaces>().inner().0.lock().unwrap_or_else(|e| e.into_inner())
}

/// The workspaces of every server, as last read (the site's own server included).
pub fn list(app: &AppHandle) -> Vec<ServerWorkspaces> {
    lock(app).list.clone()
}

/// The last list is older than `STALE` (or there's none yet).
pub fn stale(app: &AppHandle) -> bool {
    lock(app).checked.map_or(true, |at| at.elapsed() > STALE)
}

/// Asks every server again now (the loop does it on its own thread).
pub fn trigger(app: &AppHandle) {
    if let Some(wake) = lock(app).wake.as_ref() {
        let _ = wake.send(());
    }
}

/// The window came to the front: the servers are asked again, at most every 15 seconds.
pub fn on_focus(app: &AppHandle) {
    {
        let mut state = lock(app);
        if state.asked_on_focus.is_some_and(|at| at.elapsed() < FOCUS_GAP) {
            return;
        }
        state.asked_on_focus = Some(Instant::now());
    }
    trigger(app);
}

/// The loop: every minute, or when woken. Reading cookies needs a thread of its own (it waits for the web view,
/// and deadlocks on Windows from a command or an event handler).
pub fn start(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    lock(app).wake = Some(tx);
    let app = app.clone();
    std::thread::spawn(move || loop {
        refresh(&app);
        match rx.recv_timeout(EVERY) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {
                // Several wakes at once ask once.
                while rx.try_recv().is_ok() {}
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    });
}

/// Every server of the list asked once; new unread notifications on a server not open in the window are told.
fn refresh(app: &AppHandle) {
    // The cookies are the main window's: before it was ever opened (started at login) there is nothing to read.
    let Some(page) = app.get_webview(main_window::LABEL) else { return };
    let open = page.url().ok().map(|u| u.origin().ascii_serialization());
    let file = servers::get(app);
    let agent = ureq::AgentBuilder::new().timeout(TIMEOUT).redirects(0).build();
    let mut logos = lock(app).logos.clone();
    let before = list(app);
    let mut next = Vec::with_capacity(file.servers.len());
    for server in &file.servers {
        let Ok(url) = server.parse::<Url>() else { continue };
        let cookies = page.cookies_for_url(url).unwrap_or_default();
        let cookie = cookie_header(cookies.iter().map(|c| (c.name(), c.value())));
        match ask(&agent, server, &cookie, &mut logos) {
            Some(answer) => next.push(answer),
            // Not reached (offline, an error): what it said last stays.
            None => {
                if let Some(old) = before.iter().find(|s| &s.server == server) {
                    next.push(old.clone());
                }
            }
        }
    }
    let told = news(&before, &next, open.as_deref());
    {
        let mut state = lock(app);
        state.list = next;
        state.logos = logos;
        state.checked = Some(Instant::now());
    }
    for (server, org, count) in told {
        tell(app, &server, &org, count);
    }
}

/// One server: signed out (no session, or it refused it) lists nothing; None when it couldn't be reached.
fn ask(agent: &ureq::Agent, server: &str, cookie: &str, logos: &mut HashMap<String, Option<String>>) -> Option<ServerWorkspaces> {
    let signed_out = ServerWorkspaces { server: server.to_string(), signed_in: false, orgs: vec![] };
    if cookie.is_empty() {
        return Some(signed_out);
    }
    let me = match get_json(agent, &format!("{server}/api/app/me"), cookie) {
        Ok(Some(me)) => me,
        Ok(None) => return Some(signed_out),
        Err(()) => return None,
    };
    // A server from before ADR 0154 has no `/me/unread`: its workspaces show without counts.
    let unread = get_json(agent, &format!("{server}/api/app/me/unread"), cookie).ok().flatten();
    let counts = unread.as_ref().map(parse_unread).unwrap_or_default();
    let orgs = parse_me(&me)
        .into_iter()
        .map(|(id, name, logo)| {
            let (unread, waiting) = counts.get(&id).copied().unwrap_or((0, 0));
            let logo = logo.and_then(|path| logo_data(agent, server, &path, cookie, logos));
            Org { id, name, logo, unread, waiting }
        })
        .collect();
    Some(ServerWorkspaces { server: server.to_string(), signed_in: true, orgs })
}

/// The answer as JSON; Ok(None) when the session isn't (any longer) signed in there.
fn get_json(agent: &ureq::Agent, url: &str, cookie: &str) -> Result<Option<Value>, ()> {
    match agent.get(url).set("Cookie", cookie).set("X-Agentes-Client", "mobile").set("Accept", "application/json").call() {
        Ok(response) => {
            let mut text = String::new();
            response.into_reader().take(BODY_MAX).read_to_string(&mut text).map_err(|_| ())?;
            serde_json::from_str(&text).map(Some).map_err(|_| ())
        }
        Err(ureq::Error::Status(401 | 403, _)) => Ok(None),
        Err(_) => Err(()),
    }
}

/// A workspace's logo from its own server, as a data URL, read once per address.
fn logo_data(
    agent: &ureq::Agent,
    server: &str,
    path: &str,
    cookie: &str,
    logos: &mut HashMap<String, Option<String>>,
) -> Option<String> {
    let base: Url = server.parse().ok()?;
    let url = base.join(path).ok()?;
    // Only from that server: a logo address never sends its cookies anywhere else.
    if url.origin() != base.origin() {
        return None;
    }
    if let Some(known) = logos.get(url.as_str()) {
        return known.clone();
    }
    let read = || -> Option<String> {
        let response = agent.get(url.as_str()).set("Cookie", cookie).set("X-Agentes-Client", "mobile").call().ok()?;
        let kind = response.content_type().to_string();
        if !kind.starts_with("image/") || kind.contains(';') || kind.contains('"') {
            return None;
        }
        let mut bytes = Vec::new();
        response.into_reader().take(LOGO_MAX + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() as u64 > LOGO_MAX {
            return None;
        }
        Some(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    };
    let logo = read();
    logos.insert(url.to_string(), logo.clone());
    logo
}

/// The `Cookie` header for a server from the window's cookies for it.
pub fn cookie_header<'a>(cookies: impl Iterator<Item = (&'a str, &'a str)>) -> String {
    cookies
        .filter(|(name, value)| !name.is_empty() && !format!("{name}{value}").chars().any(|c| c.is_control() || c == ';'))
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// An id the app passes on (`orgId` in main_window.rs): letters, digits, `-` and `_`.
fn good_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The workspaces of `GET /api/app/me`: id, name and logo address, those still being set up left out.
pub fn parse_me(me: &Value) -> Vec<(String, String, Option<String>)> {
    let Some(orgs) = me.get("organizations").and_then(Value::as_array) else { return vec![] };
    orgs.iter()
        .filter(|o| o.get("onboarding").map_or(true, Value::is_null))
        .filter_map(|o| {
            let id = o.get("id")?.as_str()?;
            let name: String = o.get("name")?.as_str()?.trim().chars().take(80).collect();
            if !good_id(id) || name.is_empty() || name.chars().any(char::is_control) {
                return None;
            }
            let logo = o.get("logo").and_then(Value::as_str).filter(|l| l.len() <= 1024).map(str::to_string);
            Some((id.to_string(), name, logo))
        })
        .take(MAX_ORGS)
        .collect()
}

/// `GET /api/app/me/unread`: unread and waiting by workspace.
pub fn parse_unread(body: &Value) -> HashMap<String, (u64, u64)> {
    body.get("organizations")
        .and_then(Value::as_array)
        .map(|orgs| {
            orgs.iter()
                .filter_map(|o| {
                    let id = o.get("orgId")?.as_str()?;
                    let count = |key: &str| o.get(key).and_then(Value::as_u64).unwrap_or(0).min(100_000);
                    good_id(id).then(|| (id.to_string(), (count("unread"), count("waiting"))))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// What's new since the last check, to tell: on a server other than the one open in the window (`open`; with no
/// page, none is told), each workspace whose unread count grew, with how many more. A workspace or server seen for
/// the first time tells nothing (its count isn't news).
pub fn news(before: &[ServerWorkspaces], after: &[ServerWorkspaces], open: Option<&str>) -> Vec<(String, Org, u64)> {
    let Some(open) = open else { return vec![] };
    let mut told = Vec::new();
    for now in after.iter().filter(|s| s.server != open && s.signed_in) {
        let Some(then) = before.iter().find(|s| s.server == now.server && s.signed_in) else { continue };
        for org in &now.orgs {
            if let Some(old) = then.orgs.iter().find(|o| o.id == org.id) {
                if org.unread > old.unread {
                    told.push((now.server.clone(), org.clone(), org.unread - old.unread));
                }
            }
        }
    }
    told
}

/// How a server is named to people: agentes.chat for the Cloud, its host otherwise.
pub fn server_name(server: &str, cloud_name: &str) -> String {
    if server == servers::CLOUD {
        return cloud_name.to_string();
    }
    server.parse::<Url>().ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| server.to_string())
}

/// The notification's words: "Workspace · server" and "1 new notification" / "3 new notifications" (the
/// popover's labels, in the app's language; nothing is told before they arrived).
pub fn notice_text(labels: &HashMap<String, String>, server: &str, org: &str, count: u64) -> Option<(String, String)> {
    let cloud = labels.get("serversCloud")?;
    let body = if count == 1 { labels.get("workspaceNewsOne")? } else { labels.get("workspaceNewsMany")? };
    let title: String = format!("{org} · {}", server_name(server, cloud)).chars().take(80).collect();
    Some((title, body.replace("{count}", &count.to_string())))
}

fn tell(app: &AppHandle, server: &str, org: &Org, count: u64) {
    let labels = crate::menus::labels(app);
    let Some((title, body)) = notice_text(&labels, server, &org.name, count) else { return };
    let Ok(url) = format!("{server}/org/{}/notifications", org.id).parse::<Url>() else { return };
    main_window::notice(app, &title, &body, url);
}

/// Preferences › Servers: every server's workspaces (the app's own windows only).
#[tauri::command]
pub fn workspaces_get(app: AppHandle, window: tauri::Window) -> Result<Vec<ServerWorkspaces>, String> {
    if !matches!(window.label(), "prefs" | "popover") {
        return Err("only the app's own windows ask this".into());
    }
    if stale(&app) {
        trigger(&app);
    }
    Ok(list(&app))
}

/// How the welcome window opens next, taken once: `add` when the site's "Add a workspace" opened it.
#[derive(Default)]
pub struct WelcomeMode(pub Mutex<Option<&'static str>>);

#[tauri::command]
pub fn welcome_mode_take(app: AppHandle, window: tauri::Window) -> Result<Option<String>, String> {
    if window.label() != "welcome" {
        return Err("only the welcome window asks this".into());
    }
    Ok(app.state::<WelcomeMode>().0.lock().unwrap_or_else(|e| e.into_inner()).take().map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn org(id: &str, unread: u64) -> Org {
        Org { id: id.into(), name: id.to_uppercase(), logo: None, unread, waiting: 0 }
    }
    fn server(s: &str, signed_in: bool, orgs: Vec<Org>) -> ServerWorkspaces {
        ServerWorkspaces { server: s.into(), signed_in, orgs }
    }

    #[test]
    fn workspaces_from_me() {
        let me = json!({ "organizations": [
            { "id": "o-1", "name": "  Acme ", "logo": "/api/app/org-logos/o-1/a.png" },
            { "id": "o-2", "name": "Norte", "logo": null },
            { "id": "o-3", "name": "Setting up", "onboarding": { "step": 1 } },
            { "id": "../x", "name": "Bad" },
            { "id": "o-4", "name": "" },
        ]});
        assert_eq!(
            parse_me(&me),
            vec![
                ("o-1".into(), "Acme".into(), Some("/api/app/org-logos/o-1/a.png".into())),
                ("o-2".into(), "Norte".into(), None),
            ]
        );
        assert!(parse_me(&json!({})).is_empty());
    }

    #[test]
    fn counts_from_me_unread() {
        let counts = parse_unread(&json!({ "organizations": [
            { "orgId": "o-1", "unread": 3, "waiting": 1 },
            { "orgId": "../x", "unread": 9 },
            { "orgId": "o-2" },
        ]}));
        assert_eq!(counts.get("o-1"), Some(&(3, 1)));
        assert_eq!(counts.get("o-2"), Some(&(0, 0)));
        assert_eq!(counts.len(), 2);
    }

    #[test]
    fn the_cookie_header() {
        let header = cookie_header(
            [("__Secure-better-auth.session_token", "abc.def"), ("x", "a;b"), ("", "v"), ("theme", "dark")].into_iter(),
        );
        assert_eq!(header, "__Secure-better-auth.session_token=abc.def; theme=dark");
    }

    #[test]
    fn only_new_unread_elsewhere_is_told() {
        let open = "https://app.agentes.chat";
        let own = "https://agentes.exemplo.com.br";
        let before = vec![server(open, true, vec![org("a", 1)]), server(own, true, vec![org("b", 2), org("c", 5)])];
        let after = vec![
            server(open, true, vec![org("a", 9)]),
            server(own, true, vec![org("b", 4), org("c", 3), org("d", 7)]),
        ];
        let told = news(&before, &after, Some(open));
        assert_eq!(told.len(), 1, "the server open isn't told, nor fewer unread, nor a workspace seen first now");
        assert_eq!((told[0].0.as_str(), told[0].1.id.as_str(), told[0].2), (own, "b", 2));
        assert!(news(&before, &after, None).is_empty(), "no page: nothing told");
        // Signed in again just now: its counts aren't news.
        let signed_out = vec![server(own, false, vec![])];
        assert!(news(&signed_out, &after, Some(open)).is_empty());
    }

    #[test]
    fn notice_words() {
        let labels: HashMap<String, String> = [
            ("serversCloud", "agentes.chat"),
            ("workspaceNewsOne", "1 notificação nova"),
            ("workspaceNewsMany", "{count} notificações novas"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(
            notice_text(&labels, "https://agentes.exemplo.com.br", "Oficina", 3),
            Some(("Oficina · agentes.exemplo.com.br".into(), "3 notificações novas".into()))
        );
        assert_eq!(
            notice_text(&labels, servers::CLOUD, "Acme", 1),
            Some(("Acme · agentes.chat".into(), "1 notificação nova".into()))
        );
        assert_eq!(notice_text(&HashMap::new(), servers::CLOUD, "Acme", 1), None, "before the labels arrived");
    }
}
