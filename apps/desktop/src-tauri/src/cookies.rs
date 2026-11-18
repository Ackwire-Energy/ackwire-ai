//! The main window's cookies, read and removed without stopping the app.
//!
//! On macOS Tauri's own `cookies`, `cookies_for_url` and `delete_cookie` run on the main thread inside the event
//! loop's handler and wait there by running the run loop again until WebKit answers. A window drawn during that
//! wait reaches the event loop's handler a second time, whose lock the first call still holds: the main thread
//! waits for itself and the app stops answering for good (seen as an opening that never paints). Here the
//! question is only handed to WebKit on the main thread; the answer comes back later in WebKit's own block and
//! the thread that asked, never the main one, waits on a channel.
//!
//! Always from a thread of its own: never from a command's or an event's own thread (on Windows Tauri's calls
//! deadlock there, and on macOS the main thread would wait for an answer only it can deliver).

use tauri::webview::Cookie;
use tauri::Webview;

/// Every cookie the window keeps (its name, value, domain, path, secure and HTTP only: what `workspaces::sent_to`
/// and the `Cookie` header read). Empty when the web view didn't answer.
pub fn read(page: &Webview) -> Vec<Cookie<'static>> {
    #[cfg(target_os = "macos")]
    {
        mac::visit(page, |_| false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        page.cookies().unwrap_or_default()
    }
}

/// Removes the window's cookies that `gone` picks.
pub fn remove(page: &Webview, gone: impl Fn(&Cookie<'static>) -> bool + Send + 'static) {
    #[cfg(target_os = "macos")]
    {
        mac::visit(page, gone);
    }
    #[cfg(not(target_os = "macos"))]
    for cookie in page.cookies().unwrap_or_default().into_iter().filter(|c| gone(c)) {
        let _ = page.delete_cookie(cookie);
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use std::ffi::{c_char, CStr};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::webview::Cookie;
    use tauri::Webview;

    /// How long the asking thread waits for WebKit (it answers in milliseconds; this is for a web view going away).
    const WAIT: Duration = Duration::from_secs(3);

    /// Every cookie of the window's store, read once; those `gone` picks are removed from it on the way.
    pub fn visit(page: &Webview, gone: impl Fn(&Cookie<'static>) -> bool + Send + 'static) -> Vec<Cookie<'static>> {
        let (tx, rx) = mpsc::channel();
        let asked = page.with_webview(move |view| {
            // SAFETY: on the main thread (`with_webview`), `view.inner()` is the live WKWebView; its configuration,
            // data store and cookie store are its own objects, the store retained for the answer. WebKit copies
            // the block and calls it on the main thread with an NSArray of NSHTTPCookie that lives for the call.
            unsafe {
                let web_view = view.inner() as *mut AnyObject;
                let configuration: *mut AnyObject = msg_send![web_view, configuration];
                let data: *mut AnyObject = msg_send![configuration, websiteDataStore];
                let store: *mut AnyObject = msg_send![data, httpCookieStore];
                // Kept for the answer, which comes after this call returns (the window may be gone by then).
                let Some(store) = Retained::retain(store) else {
                    let _ = tx.send(Vec::new());
                    return;
                };
                let asking = store.clone();
                let answer = RcBlock::new(move |list: *mut AnyObject| {
                    let count: usize = if list.is_null() { 0 } else { msg_send![list, count] };
                    let mut cookies = Vec::with_capacity(count);
                    for at in 0..count {
                        let native: *mut AnyObject = msg_send![list, objectAtIndex: at];
                        let Some(cookie) = cookie_of(native) else { continue };
                        if gone(&cookie) {
                            let removed = RcBlock::new(|| {});
                            let _: () = msg_send![&*store, deleteCookie: native, completionHandler: &*removed];
                        }
                        cookies.push(cookie);
                    }
                    let _ = tx.send(cookies);
                });
                let _: () = msg_send![&*asking, getAllCookies: &*answer];
            }
        });
        if asked.is_err() {
            return Vec::new();
        }
        rx.recv_timeout(WAIT).unwrap_or_default()
    }

    /// An NSHTTPCookie as the cookie crate's (no expiry or SameSite: nothing here reads them).
    ///
    /// # Safety
    /// `native` is a live NSHTTPCookie or null.
    unsafe fn cookie_of(native: *mut AnyObject) -> Option<Cookie<'static>> {
        if native.is_null() {
            return None;
        }
        let name = text(msg_send![native, name])?;
        let value = text(msg_send![native, value]).unwrap_or_default();
        let secure: bool = msg_send![native, isSecure];
        let http_only: bool = msg_send![native, isHTTPOnly];
        let mut cookie = Cookie::build((name, value)).secure(secure).http_only(http_only);
        if let Some(domain) = text(msg_send![native, domain]) {
            cookie = cookie.domain(domain);
        }
        if let Some(path) = text(msg_send![native, path]) {
            cookie = cookie.path(path);
        }
        Some(cookie.build())
    }

    /// An NSString's text (None for nil).
    ///
    /// # Safety
    /// `string` is a live NSString or null.
    unsafe fn text(string: *mut AnyObject) -> Option<String> {
        if string.is_null() {
            return None;
        }
        let utf8: *const c_char = msg_send![string, UTF8String];
        (!utf8.is_null()).then(|| CStr::from_ptr(utf8).to_string_lossy().into_owned())
    }
}
