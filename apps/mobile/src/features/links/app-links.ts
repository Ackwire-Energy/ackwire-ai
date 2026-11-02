import type { ApiClient } from "@agenteschat/client";
import { isSafeId } from "../shared/logic";
import { chatHref, notificationHref } from "./logic";

/**
 * The web's addresses as the app's screens (iOS universal links, Android App Links): a link to the website that
 * opens the app lands where the website would. Which paths open the app at all is listed twice, for each store's
 * build: the server's `APP_LINK_PATHS` (apps/server/src/app-links.ts, read by iOS) and the Android intent filters
 * (`APP_LINK_PATTERNS` in app.config.ts). Keep the three in step.
 *
 * A workspace's page goes through `/link` (app/(app)/link.tsx), which switches to that workspace first and finds
 * what a web address names but the app's screen needs (a thread's conversation, a DM's channel). A page the app has
 * no screen for opens in the browser.
 */

/** Where a web address opens: an app path, the web page in the browser, or null when it isn't the web's. */
export type AppLink = { href: string } | { web: string } | null;

/** Settings sections the app has, by the web's section id (apps/web/src/pages/settings-sections.ts). */
const SETTINGS_SCREENS: Record<string, string> = {
  account: "/me/account",
  notifications: "/me/notifications",
  apps: "/settings/apps",
  general: "/settings/general",
  members: "/me/members",
  audit: "/settings/audit",
  access: "/settings/access",
  connectors: "/connectors",
  skills: "/settings/skills",
  keys: "/ai-accounts",
  storage: "/settings/storage",
  computers: "/settings/computers",
  usage: "/usage",
  import: "/settings/import",
  media: "/settings/media",
};

/** Paths outside a workspace the app has its own screen for, under the same path (expo-router opens them). */
const OWN_PATHS = /^\/(invite\/[^/]+|reset-password|signup)\/?$/;

/** `/link?…`: what the link screen needs, encoded. */
const linkHref = (params: Record<string, string | null | undefined>) =>
  `/link?${Object.entries(params)
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&")}`;

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return "";
  }
};

/** The query's values (React Native's URLSearchParams lacks `get`). */
function queryOf(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of query.split("&")) {
    const [k, v = ""] = pair.split("=");
    if (k) out[decode(k)] = decode(v.replace(/\+/g, " "));
  }
  return out;
}

/** Inside a workspace (`/org/<id>/…`): the app's screen, or null when the app has none. */
function workspaceScreen(rest: string[], q: Record<string, string>): Record<string, string | null> | string | null {
  const [page = "", id, sub] = rest;
  const m = isSafeId(q.m) ? q.m : null;
  const open = isSafeId(q.open) ? q.open : null;
  switch (page) {
    case "":
    case "home":
      return "/";
    case "c":
      return isSafeId(id) ? { to: m ? `/chat/${id}?m=${m}` : `/chat/${id}` } : null;
    case "dm":
      if (!isSafeId(sub)) return null;
      return id === "agent" ? { agent: sub, m } : id === "person" ? { person: sub, m } : null;
    case "threads":
      if (id === undefined) return open ? { thread: open } : "/threads";
      return isSafeId(id) ? { thread: id, m } : null;
    case "agents":
      if (id === "new") return "/new-agent";
      return isSafeId(id) ? `/agent/${id}` : null;
    case "approvals":
      return open ? `/approval/${open}` : "/activity";
    case "notifications":
      return open ? { notification: open } : "/activity";
    case "issues": {
      const number = id ?? open;
      if (number === undefined || number === null) return "/issues";
      return /^\d{1,9}$/.test(number) ? `/issues/${number}` : null;
    }
    case "routines":
      return open ? `/routines/${open}` : "/routines";
    case "search":
      return "/search";
    case "drive":
      return "/drive";
    case "wiki":
      if (id === undefined) return "/wiki";
      return id && id.length <= 200 ? `/wiki/${encodeURIComponent(id)}` : null;
    case "members":
      return "/me/members";
    case "settings":
      if (id === undefined) return "/settings";
      if (id === "computers" && sub !== undefined) return isSafeId(sub) ? `/settings/computers/${sub}` : null;
      return SETTINGS_SCREENS[id] ?? null;
    default:
      return null;
  }
}

/**
 * A URL the app was opened with → where it goes. Only the web's addresses (`https://<host>/…`) change: the app's own
 * scheme (`agenteschat://chat/…`) and paths stay as they are (null).
 */
export function appLinkFromUrl(url: string): AppLink {
  const match = /^https?:\/\/[^/?#]+(\/[^?#]*)?(?:\?([^#]*))?/i.exec(url.trim());
  if (!match) return null;
  const path = match[1] || "/";
  const query = match[2] ?? "";
  if (OWN_PATHS.test(path)) return { href: query ? `${path}?${query}` : path };
  const web = { web: query ? `${path}?${query}` : path };
  const parts = path.split("/").filter(Boolean).map(decode);
  if (parts[0] !== "org" || !isSafeId(parts[1])) return web;
  const screen = workspaceScreen(parts.slice(2), queryOf(query));
  if (screen === null) return web;
  return { href: linkHref(typeof screen === "string" ? { org: parts[1], to: screen } : { org: parts[1], ...screen }) };
}

/** What `/link` was opened with (`appLinkFromUrl`), unchecked. */
export interface LinkParams {
  to?: unknown;
  thread?: unknown;
  agent?: unknown;
  person?: unknown;
  notification?: unknown;
  m?: unknown;
}

/**
 * The app path a `/link` opens, in the workspace already switched to: a path as it came, or the conversation a
 * thread, a DM or a notification is in (asked of the server). `/` when it names nothing the app can open.
 */
export async function resolveLink(
  api: { threads: Pick<ApiClient["threads"], "get">; dms: Pick<ApiClient["dms"], "open"> } & {
    notifications: Pick<ApiClient["notifications"], "read">;
  },
  orgId: string,
  p: LinkParams,
): Promise<string> {
  if (typeof p.to === "string" && p.to.startsWith("/") && !p.to.startsWith("//")) return p.to;
  const m = isSafeId(p.m) ? p.m : null;
  if (isSafeId(p.thread)) {
    const thread = await api.threads.get(orgId, p.thread);
    return chatHref(thread.channelId, thread.id, m);
  }
  const dm = isSafeId(p.agent) ? { agentId: p.agent } : isSafeId(p.person) ? { userId: p.person } : null;
  if (dm) return chatHref((await api.dms.open(orgId, dm)).channelId, null, m);
  // Opening a notification reads it, as the web's inbox does with `?open=`.
  if (isSafeId(p.notification))
    return notificationHref(await api.notifications.read(orgId, p.notification, true)) ?? "/activity";
  return "/";
}
