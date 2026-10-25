//! "Found" on Connect: where an agentes.chat server may be. This computer first (a server installed from the
//! terminal writes `~/.agentes/server.json`; the usual ports otherwise), then the person's Tailscale network
//! when its command-line tool answers: the setup's default name, `agentes.<the tailnet>`, and online devices
//! whose name starts with "agentes". Only addresses: the welcome window asks each one whether it is a server.
//! No scan of the local network: servers listen on their own machine, and plain http across it is refused.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

/// Devices named agentes… on the tailnet, at most.
const MAX_PEERS: usize = 5;
/// Where the native server and a Docker install answer on this computer, when nothing says otherwise.
const LOCAL: &[&str] = &["http://127.0.0.1:4310", "http://127.0.0.1:3000"];

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Candidate {
    pub server: String,
    #[serde(rename = "where")]
    pub place: &'static str,
}

/// This computer: `server.json`'s own addresses first, then the usual ports.
fn here(home: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(text) = std::fs::read_to_string(home.join(".agentes").join("server.json")) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            for key in ["publicUrl", "url"] {
                if let Some(origin) = v.get(key).and_then(Value::as_str).and_then(crate::servers::origin_of) {
                    out.push(origin);
                }
            }
        }
    }
    out.extend(LOCAL.iter().map(|s| s.to_string()));
    out
}

/// The tailnet, from `tailscale status --json`: `agentes.<suffix>`, then online peers named agentes….
fn tailnet(status: &Value) -> Vec<String> {
    let suffix = status
        .get("MagicDNSSuffix")
        .or_else(|| status.pointer("/CurrentTailnet/MagicDNSSuffix"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_matches('.');
    let mut out = Vec::new();
    if !suffix.is_empty() {
        out.push(format!("https://agentes.{suffix}"));
    }
    if let Some(peers) = status.get("Peer").and_then(Value::as_object) {
        let named = peers.values().filter(|p| {
            p.get("Online").and_then(Value::as_bool).unwrap_or(false)
                && p.get("HostName").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase().starts_with("agentes")
        });
        for peer in named.take(MAX_PEERS) {
            if let Some(name) = peer.get("DNSName").and_then(Value::as_str).map(|n| n.trim_end_matches('.')) {
                out.push(format!("https://{name}"));
            }
        }
    }
    out.retain(|s| crate::servers::origin_of(s).as_deref() == Some(s.as_str()));
    out
}

pub fn find(home: &Path, status: Option<&Value>) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = Vec::new();
    let mut add = |server: String, place: &'static str| {
        if !out.iter().any(|c| c.server == server) {
            out.push(Candidate { server, place });
        }
    };
    for s in here(home) {
        add(s, "here");
    }
    for s in status.map(tailnet).unwrap_or_default() {
        add(s, "tailnet");
    }
    out
}

#[tauri::command]
pub async fn discover(app: AppHandle) -> Vec<Candidate> {
    let Ok(home) = app.path().home_dir() else { return Vec::new() };
    tauri::async_runtime::spawn_blocking(move || find(&home, crate::tailscale::status_json().as_ref()))
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_tailnet_by_its_names() {
        let status = json!({
            "MagicDNSSuffix": "tail1234.ts.net",
            "Peer": {
                "a": { "HostName": "agentes-mini", "DNSName": "agentes-mini.tail1234.ts.net.", "Online": true },
                "b": { "HostName": "agentes-old", "DNSName": "agentes-old.tail1234.ts.net.", "Online": false },
                "c": { "HostName": "ana-phone", "DNSName": "ana-phone.tail1234.ts.net.", "Online": true },
                "d": { "HostName": "Agentes", "DNSName": "evil name.tail1234.ts.net.", "Online": true }
            }
        });
        assert_eq!(
            tailnet(&status),
            vec!["https://agentes.tail1234.ts.net".to_string(), "https://agentes-mini.tail1234.ts.net".to_string()]
        );
        assert_eq!(tailnet(&json!({ "CurrentTailnet": { "MagicDNSSuffix": "x.ts.net" } })), vec!["https://agentes.x.ts.net"]);
        assert!(tailnet(&json!({})).is_empty());
    }

    #[test]
    fn this_computer_first_then_the_tailnet_once_each() {
        let home = std::env::temp_dir().join(format!("agentes-discover-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".agentes")).unwrap();
        std::fs::write(
            home.join(".agentes/server.json"),
            r#"{"url":"http://127.0.0.1:4311","publicUrl":"https://agentes.tail1234.ts.net"}"#,
        )
        .unwrap();
        let found = find(&home, Some(&json!({ "MagicDNSSuffix": "tail1234.ts.net" })));
        let servers: Vec<_> = found.iter().map(|c| (c.server.as_str(), c.place)).collect();
        assert_eq!(
            servers,
            vec![
                ("https://agentes.tail1234.ts.net", "here"),
                ("http://127.0.0.1:4311", "here"),
                ("http://127.0.0.1:4310", "here"),
                ("http://127.0.0.1:3000", "here"),
            ]
        );
        std::fs::remove_dir_all(&home).unwrap();
        assert_eq!(find(&home, None).len(), LOCAL.len());
    }
}
