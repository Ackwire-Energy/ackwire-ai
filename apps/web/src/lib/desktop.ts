import type { SignInProvider } from "@agenteschat/client";

/**
 * The site inside agentes for Mac (D79): the app's main window loads it and
 * sets `window.__agentesDesktop` before it starts. The site gets nothing of
 * the Mac; it only draws its own title bar and sends Google/Apple sign-in to
 * the browser (`apps/desktop/src-tauri/src/main_window.rs`).
 */
export const inDesktopApp = () =>
  typeof window !== "undefined" && Boolean((window as { __agentesDesktop?: unknown }).__agentesDesktop);

/** The window opens this in the browser instead of loading it (main_window.rs). */
export const BROWSER_SIGN_IN_PATH = "/desktop/sign-in";
/** Loading this brings the window to the front (main_window.rs), then goes on to `to`. */
export const SIGNED_IN_PATH = "/desktop/signed-in";

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** 32 random bytes (base64url): kept by the window, never sent until it redeems. */
export function newVerifier() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The verifier's SHA-256 (base64url): what travels through the browser. */
export async function challengeOf(verifier: string) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export const browserSignInUrl = (provider: SignInProvider, challenge: string) =>
  `${BROWSER_SIGN_IN_PATH}?${new URLSearchParams({ provider, challenge })}`;

/** The browser keeps the challenge it started with: a link that skips the provider finds none. */
const CHALLENGE_KEY = "agentes.desktopChallenge";
export const browserChallenge = {
  set(challenge: string) {
    try {
      sessionStorage.setItem(CHALLENGE_KEY, challenge);
    } catch {
      // Without storage the handoff is refused; the person signs in again.
    }
  },
  take(): string | null {
    try {
      const value = sessionStorage.getItem(CHALLENGE_KEY);
      sessionStorage.removeItem(CHALLENGE_KEY);
      return value;
    } catch {
      return null;
    }
  },
};
