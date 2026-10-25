/** A provider's sign-in or key page: its own window beside the app. */
const FEATURES = "popup,width=520,height=760";

/**
 * Opens `url` (none: a blank window to send there once the address is known) as a popup. Called from the
 * click itself (browsers block popups opened later). Null when the browser refused it; the caller then
 * offers a link. The page it opens can't reach back into the app (`opener`).
 */
export function openPopup(url = ""): Window | null {
  let w: Window | null = null;
  try {
    w = window.open(url || "about:blank", "_blank", FEATURES);
  } catch {
    return null;
  }
  try {
    if (w) w.opener = null;
  } catch {
    // already another site's
  }
  return w;
}

/** Sends a popup opened blank to `url` (closed meanwhile: nothing). */
export function sendPopup(w: Window | null, url: string) {
  try {
    if (w && !w.closed) w.location.href = url;
  } catch {
    // gone, or not ours any more
  }
}
