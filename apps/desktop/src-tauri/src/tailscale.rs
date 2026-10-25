//! Tailscale on this computer, through its own command-line tool: whether it is connected (Connect's
//! discovery, the reach card), and sharing the server here on the person's tailnet (`tailscale serve`, HTTPS
//! inside the tailnet only; never Funnel). The tool is looked up at the places it installs itself, never at a
//! path from a page.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

/// `status` gets this long to answer.
const STATUS_WAIT: Duration = Duration::from_secs(2);
/// `serve` may wait for the person to allow HTTPS in the tailnet's admin page: it is stopped after this.
const SERVE_WAIT: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Tailnet {
    /// No Tailscale on this computer.
    Missing,
    /// Installed, signed out or turned off.
    Off,
    /// Connected: this device's own name on the tailnet (`ana-mac.tail1234.ts.net`).
    #[serde(rename_all = "camelCase")]
    On { device: String },
}

/// Why sharing the server here on the tailnet didn't work.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "reason", rename_all = "camelCase")]
pub enum ServeError {
    /// HTTPS (or Serve) is off for the tailnet: its admin turns it on at `url`.
    Https { url: Option<String> },
    /// This computer's user may not change what Tailscale shares (Linux, until `tailscale set --operator`).
    Operator,
    /// Tailscale refused or isn't connected (the Mac App Store variant may never share).
    Serve,
}

/// The tool at the places it installs itself.
pub fn cli() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let fixed: &[&str] = &[
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
    ];
    #[cfg(target_os = "windows")]
    let fixed: &[&str] = &[r"C:\Program Files\Tailscale\tailscale.exe"];
    #[cfg(target_os = "linux")]
    let fixed: &[&str] = &["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale"];
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let fixed: &[&str] = &[];
    fixed.iter().map(PathBuf::from).find(|p| p.is_file())
}

/// Runs the tool with `args`; see `run_program`.
fn run(args: &[&str], wait: Duration) -> Option<(bool, String)> {
    run_program(&cli()?, args, wait)
}

/// Runs `program`; its exit status and what it printed (stdout, then stderr, 1 MB each at most), or None when
/// it couldn't start. Taking longer than `wait` stops it (what it printed so far is kept). Its output is read
/// while it runs: a pipe holds 64 KB, and `status --json` on a large tailnet prints more, so a reader after
/// the exit would never see it end.
fn run_program(program: &Path, args: &[&str], wait: Duration) -> Option<(bool, String)> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let reader = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(pipe) = pipe {
                let _ = pipe.take(1024 * 1024).read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let stdout = reader(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = reader(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let started = Instant::now();
    let ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if started.elapsed() <= wait => std::thread::sleep(Duration::from_millis(50)),
            // Too long, or it can't be asked: stopped (the readers then reach the end).
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let mut out = String::from_utf8_lossy(&stdout.join().unwrap_or_default()).into_owned();
    out.push_str(&String::from_utf8_lossy(&stderr.join().unwrap_or_default()));
    Some((ok, out))
}

/// `tailscale status --json`, or None when the tool isn't there, fails or takes too long.
pub fn status_json() -> Option<Value> {
    let (ok, out) = run(&["status", "--json"], STATUS_WAIT)?;
    if !ok {
        return None;
    }
    serde_json::from_str(&out).ok()
}

/// What `status --json` says about this device.
pub fn tailnet_of(status: Option<&Value>, installed: bool) -> Tailnet {
    let Some(status) = status else {
        return if installed { Tailnet::Off } else { Tailnet::Missing };
    };
    let running = status.get("BackendState").and_then(Value::as_str) == Some("Running");
    let device = status
        .pointer("/Self/DNSName")
        .and_then(Value::as_str)
        .map(|n| n.trim_end_matches('.').to_ascii_lowercase())
        .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.'));
    match (running, device) {
        (true, Some(device)) => Tailnet::On { device },
        _ => Tailnet::Off,
    }
}

pub fn tailnet() -> Tailnet {
    tailnet_of(status_json().as_ref(), cli().is_some())
}

/// The HTTPS port to share on: 443, unless this device already shares something else there.
fn https_port(serve: Option<&Value>, device: &str, target: &str) -> u16 {
    let ours = |v: &Value| v.to_string().contains(target);
    let taken = serve
        .and_then(|s| s.pointer(&format!("/Web/{}:443", device.replace('~', "~0").replace('/', "~1"))))
        .is_some_and(|handlers| !ours(handlers));
    if taken {
        8443
    } else {
        443
    }
}

/// Why `serve` failed, from what it printed.
pub fn serve_error(out: &str) -> ServeError {
    let lower = out.to_ascii_lowercase();
    let url = out
        .split_whitespace()
        .find(|w| w.starts_with("https://login.tailscale.com/"))
        .map(|w| w.trim_end_matches(['.', ',', ')']).to_string());
    if url.is_some() || lower.contains("https") && (lower.contains("not enabled") || lower.contains("certificate")) {
        ServeError::Https { url }
    } else if lower.contains("access denied") || lower.contains("operator") {
        ServeError::Operator
    } else {
        ServeError::Serve
    }
}

/// Shares `http://127.0.0.1:<port>` on the tailnet over HTTPS; the address it answers at.
pub fn serve(port: u16) -> Result<String, ServeError> {
    let Tailnet::On { device } = tailnet() else { return Err(ServeError::Serve) };
    let target = format!("http://127.0.0.1:{port}");
    let current = run(&["serve", "status", "--json"], STATUS_WAIT).and_then(|(_, out)| serde_json::from_str(&out).ok());
    let https = https_port(current.as_ref(), &device, &target);
    let flag = format!("--https={https}");
    match run(&["serve", "--bg", &flag, &target], SERVE_WAIT) {
        Some((true, _)) => Ok(if https == 443 { format!("https://{device}") } else { format!("https://{device}:{https}") }),
        Some((false, out)) => Err(serve_error(&out)),
        None => Err(ServeError::Serve),
    }
}

/// Stops sharing `port`'s address (either HTTPS port the app may have used).
pub fn unserve(public_url: &str) {
    let https = if public_url.rsplit_once(':').is_some_and(|(_, p)| p == "8443") { 8443 } else { 443 };
    let _ = run(&["serve", &format!("--https={https}"), "off"], SERVE_WAIT);
}

#[tauri::command]
pub async fn tailscale_status(webview: tauri::Webview) -> Result<Tailnet, String> {
    if !matches!(webview.label(), "welcome" | "prefs") {
        return Err("only the app's own windows ask this".into());
    }
    tauri::async_runtime::spawn_blocking(tailnet).await.map_err(|e| e.to_string())
}

/// "Open Tailscale" (its app, on a Mac only: elsewhere it is connected from the terminal), "Get Tailscale" (its
/// download page), "Turn it on" (the admin page the last `serve` named, or the tailnet's DNS settings, where
/// HTTPS is turned on).
#[tauri::command]
pub fn tailscale_open(app: tauri::AppHandle, webview: tauri::Webview, page: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !matches!(webview.label(), "welcome" | "prefs" | "main-cover") {
        return Err("only the app's own windows open this".into());
    }
    match page.as_str() {
        "app" if cfg!(target_os = "macos") => app
            .opener()
            .open_path("/Applications/Tailscale.app", None::<&str>)
            .map_err(|e| e.to_string()),
        "download" => app.opener().open_url("https://tailscale.com/download", None::<&str>).map_err(|e| e.to_string()),
        "https" => {
            let url = crate::local_server::https_admin_url(&app)
                .unwrap_or_else(|| "https://login.tailscale.com/admin/dns".to_string());
            app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
        }
        _ => Err("unknown page".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn this_device_on_the_tailnet() {
        let on = json!({ "BackendState": "Running", "Self": { "DNSName": "Ana-Mac.tail1234.ts.net." } });
        assert_eq!(tailnet_of(Some(&on), true), Tailnet::On { device: "ana-mac.tail1234.ts.net".into() });
        let off = json!({ "BackendState": "Stopped", "Self": { "DNSName": "ana-mac.tail1234.ts.net." } });
        assert_eq!(tailnet_of(Some(&off), true), Tailnet::Off);
        assert_eq!(tailnet_of(None, true), Tailnet::Off);
        assert_eq!(tailnet_of(None, false), Tailnet::Missing);
        let odd = json!({ "BackendState": "Running", "Self": { "DNSName": "evil name/../x." } });
        assert_eq!(tailnet_of(Some(&odd), true), Tailnet::Off);
    }

    #[test]
    fn https_on_443_unless_something_else_is_there() {
        let target = "http://127.0.0.1:4310";
        let device = "ana-mac.tail1234.ts.net";
        assert_eq!(https_port(None, device, target), 443);
        let ours = json!({ "Web": { "ana-mac.tail1234.ts.net:443": { "Handlers": { "/": { "Proxy": target } } } } });
        assert_eq!(https_port(Some(&ours), device, target), 443);
        let other = json!({ "Web": { "ana-mac.tail1234.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:8080" } } } } });
        assert_eq!(https_port(Some(&other), device, target), 8443);
    }

    #[test]
    fn output_larger_than_a_pipe_is_read_while_the_tool_runs() {
        // About 1.4 KB per device in `status --json`: 200 KB is a tailnet of some 140 devices.
        let script = "head -c 200000 /dev/zero | tr '\\000' a; echo done >&2";
        let started = Instant::now();
        let (ok, out) = run_program(Path::new("/bin/sh"), &["-c", script], Duration::from_secs(5)).unwrap();
        assert!(ok, "it ended on its own, not stopped after the wait");
        assert!(started.elapsed() < Duration::from_secs(4));
        assert_eq!(out.len(), 200_000 + "done\n".len());
        assert!(out.ends_with("adone\n"));
        // Stopped after the wait, what it printed kept.
        let (ok, out) = run_program(Path::new("/bin/sh"), &["-c", "echo early; exec sleep 5"], Duration::from_millis(300)).unwrap();
        assert!(!ok);
        assert_eq!(out, "early\n");
    }

    #[test]
    fn why_serve_failed() {
        assert_eq!(
            serve_error("Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc\n"),
            ServeError::Https { url: Some("https://login.tailscale.com/f/serve?node=abc".into()) }
        );
        assert_eq!(serve_error("HTTPS is not enabled for this tailnet"), ServeError::Https { url: None });
        assert_eq!(serve_error("Access denied: serve config denied"), ServeError::Operator);
        assert_eq!(serve_error("something else"), ServeError::Serve);
    }
}
