import type { AppNotification, SignInProvider } from "@agenteschat/client";
import type { i18n as I18n, TFunction } from "i18next";
import { useEffect } from "react";

/**
 * The site inside the agentes.chat desktop app (ADR 0036, ADR 0066): the app's main window loads it and
 * sets `window.__agentesDesktop` before it starts. The site gets nothing of the computer; it draws its own
 * title bar and sends Google/Apple sign-in to the browser (`apps/desktop/src-tauri/src/main_window.rs`).
 */
export const inDesktopApp = () =>
  typeof window !== "undefined" && Boolean((window as { __agentesDesktop?: unknown }).__agentesDesktop);

export type DesktopPlatform = "mac" | "windows" | "linux";

/** The system the app runs on; apps from before Windows and Linux say nothing, and were Macs. */
export function desktopPlatform(): DesktopPlatform | null {
  if (!inDesktopApp()) return null;
  const platform = (window as { __agentesDesktop?: { platform?: unknown } }).__agentesDesktop?.platform;
  return platform === "windows" || platform === "linux" ? platform : "mac";
}

/**
 * `{{device}}` in the site's words about this computer ("Use this Mac", "Use this computer"), in the
 * page's language, kept right when the language changes.
 */
export function applyDesktopDevice(i18n: I18n, platform: DesktopPlatform) {
  const apply = () => {
    const interpolation = i18n.options.interpolation ?? {};
    interpolation.defaultVariables = {
      ...interpolation.defaultVariables,
      device: i18n.t(`machines.thisMac.device.${platform}`),
    };
    i18n.options.interpolation = interpolation;
  };
  apply();
  i18n.on("languageChanged", apply);
}

/** What a phone gets pushed (apps/server push.ts), and so what the desktop app shows while in the background. */
const NOTICE_KINDS = [
  "mention",
  "dm",
  "agent_question",
  "approval",
  "forum_turn",
  "mission_stopped",
  "routine_failed",
  "routine_paused",
  "browser_handoff",
] as const;
type NoticeKind = (typeof NOTICE_KINDS)[number];
const isNoticeKind = (kind: string): kind is NoticeKind => (NOTICE_KINDS as readonly string[]).includes(kind);
/** Kinds whose own title says what it is (the approval's action, the mission's name); the rest say their text. */
const TITLED = new Set(["approval", "forum_turn", "mission_stopped", "routine_failed", "routine_paused"]);
const NOTICE_TITLE_MAX = 80;
const NOTICE_BODY_MAX = 180;

const oneLine = (text: string, max: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/**
 * The desktop app's notification for one that just arrived (`notification.upserted`): new and unread, of a
 * kind a phone would get pushed, or waiting on the person. Its page is the inbox, where it is on top. Merged
 * into one already there, read, or done: none.
 */
export function desktopNotice(
  t: TFunction,
  orgId: string,
  n: Pick<AppNotification, "kind" | "waiting" | "count" | "readAt" | "doneAt" | "latest">,
): { title: string; body: string; path: string } | null {
  if (n.readAt || n.doneAt || n.count > 1) return null;
  const kind = isNoticeKind(n.kind) ? n.kind : n.waiting ? "waiting" : null;
  if (!kind) return null;
  const [first, second] = TITLED.has(kind) ? [n.latest.title, n.latest.text] : [n.latest.text, n.latest.title];
  return {
    title: oneLine(t(`desktopNotice.${kind}`), NOTICE_TITLE_MAX),
    body: oneLine(first ?? second ?? "", NOTICE_BODY_MAX),
    path: `/org/${encodeURIComponent(orgId)}/notifications`,
  };
}

/**
 * A one-time secret in this page's fragment (`#token=…`), taken out of the address and the history at once;
 * null when there is none, or it isn't one.
 */
export function takeFragmentSecret(key: "token" | "claim"): string | null {
  const value = new URLSearchParams(window.location.hash.slice(1)).get(key);
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  return value && /^[A-Za-z0-9_-]{20,200}$/.test(value) ? value : null;
}

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

/**
 * What the site may ask of this computer (ADR 0036, `this_mac` in main_window.rs): which of this server's
 * organizations it works for, pairing it with one (the app asks the person in its own dialog first; the site
 * then confirms the runner's code with its own session), reconnecting it, the app's Preferences on a tab, its
 * access requests, the badge and notifications. Nothing else reaches the computer.
 */
export interface ThisMacStatus {
  orgs: { orgId: string; machineId: string | null; connection: string }[];
  /** False where agents can't work on this computer for this server (agentes.chat, a server on it, Windows). */
  agentsHere?: boolean;
}

type Invoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
const invoke = <T>(request: Record<string, unknown>): Promise<T> => {
  const tauri = (window as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  if (!inDesktopApp() || typeof tauri?.invoke !== "function") return Promise.reject(new Error("not in the app"));
  return tauri.invoke("this_mac", { request }) as Promise<T>;
};

/**
 * The site painted its first screen: the app's cover over the window goes (apps/desktop cover.rs). Older apps
 * don't have it; nothing happens there.
 */
export function pageReady() {
  const tauri = (window as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  if (!inDesktopApp() || typeof tauri?.invoke !== "function") return;
  void tauri.invoke("page_ready", {}).catch(() => {});
}

export const thisMac = {
  status: () => invoke<ThisMacStatus>({ kind: "status" }),
  /**
   * The runner's code for the site to confirm; null when this computer is already in `orgId`. `orgName` is
   * what the app's own dialog names (display only).
   */
  connect: (orgId: string, orgName?: string) =>
    invoke<{ userCode: string | null }>({ kind: "connect", orgId, ...(orgName ? { orgName } : {}) }),
  /** The socket again (this Mac went offline for `orgId`). */
  reconnect: (orgId: string) => invoke<unknown>({ kind: "reconnect", orgId }),
  openPrefs: (tab: "folders" | "tools" | "updates") => invoke<unknown>({ kind: "prefs", tab }),
  /** The menu bar's popover, where access requests are answered. */
  showRequests: () => invoke<unknown>({ kind: "requests" }),
  /** The Dock's badge: how many wait on the person, and unread (a dot when nothing waits). */
  badge: (waiting: number, unread: number) => invoke<unknown>({ kind: "badge", waiting, unread }),
  /** The Mac's Go menu: the person's organizations (⌘⌥1–9). */
  orgs: (orgs: { id: string; name: string }[]) => invoke<unknown>({ kind: "orgs", orgs }),
  /** A notification while the app is in the background (the app limits how many); `path` opens on a click. */
  notify: (title: string, body: string, path: string) => invoke<unknown>({ kind: "notify", title, body, path }),
};

/** The window's title in the app (and the tab's in a browser) while a screen shows; back when it goes. */
export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    if (!title) return;
    const before = document.title;
    document.title = title;
    return () => {
      document.title = before;
    };
  }, [title]);
}
