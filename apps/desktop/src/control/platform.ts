/** The systems the app runs on (`window.__agentesDesktop.platform` on the site, `{{device}}` in the copy). */
export type Platform = "mac" | "windows" | "linux";

/** From the web view's user agent: WKWebView on a Mac, WebView2 on Windows, WebKitGTK on Linux. */
export function platformOf(userAgent: string): Platform {
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "mac";
  return "linux";
}
