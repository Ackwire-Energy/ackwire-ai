import type { FetchLike } from "../api/http";
import type { Instance } from "../api/types";

/**
 * Choosing a server in the phone and desktop apps ("Seu servidor"): the address a person types, the connect
 * link that the web app's QR code and the self-host setup print, and the check that an address is an
 * agentes.chat server these apps can talk to.
 */

export const CLOUD_SERVER = "https://agentes.chat";

/** The app API contract these apps speak; a server serves its `minApi` up to its `api` (`GET /api/instance`). */
export const APP_API = 1;

/**
 * `agenteschat://connect?server=<origin>[&token=<one-time sign-in>][&claim=<owner claim>]` opens the phone or
 * the desktop app on that server.
 */
const CONNECT_LINK = /^agenteschat:\/\/\/?connect\/?(?:\?(.*))?$/i;
/** A one-time sign-in or an owner claim inside a connect link. */
const LINK_SECRET = /^[A-Za-z0-9_-]{20,200}$/;
const MAX_LINK = 2048;

/** localhost and private IPv4 addresses: the only hosts a development build may reach over http. */
const LOCAL_HOST =
  /^(localhost|127(\.\d+){3}|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|[\w-]+\.local)$/i;
/** This computer itself: nothing on the network sees plain http there. */
const LOOPBACK_HOST = /^(localhost|127(\.\d+){3}|\[::1\])$/i;

/**
 * "agentes.tail1234.ts.net" or "https://chat.example.com/login" → the server's origin. Null when it can't be
 * one: not http(s), a user or password in it, or http where it isn't allowed. `allowHttp: true` (a development
 * build) allows the local network; `"loopback"` (the desktop app) only this computer.
 */
export function normalizeServer(input: string, opts: { allowHttp?: boolean | "loopback" } = {}): string | null {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][\w+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.username || url.password || !url.hostname) return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol !== "http:") return null;
  const allowed = opts.allowHttp === "loopback" ? LOOPBACK_HOST : opts.allowHttp === true ? LOCAL_HOST : null;
  return allowed?.test(url.hostname) ? url.origin : null;
}

/** A server on this computer itself (`http://127.0.0.1:4310`, `localhost`, `[::1]`). */
export function isLoopback(server: string): boolean {
  try {
    return LOOPBACK_HOST.test(new URL(server).hostname);
  } catch {
    return false;
  }
}

/** "https://box.tail1234.ts.net" → "box.tail1234.ts.net" (with the port, when it isn't the default). */
export function serverHost(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

/** On a Tailscale network: only devices signed in to the same tailnet reach it. */
export function isTailnet(server: string): boolean {
  try {
    return new URL(server).hostname.toLowerCase().endsWith(".ts.net");
  } catch {
    return false;
  }
}

// A type, not an interface: routers take it as route params, which need an index signature.
export type ConnectLink = {
  server: string;
  /** A one-time sign-in from another device (the web app's "Open on your phone"). */
  token?: string;
  /** The owner claim the setup printed, while the server waits for its first account. */
  claim?: string;
};

export function connectLink(server: string, { token, claim }: Omit<ConnectLink, "server"> = {}): string {
  const query = new URLSearchParams({ server });
  if (token) query.set("token", token);
  if (claim) query.set("claim", claim);
  return `agenteschat://connect?${query}`;
}

/**
 * The server, one-time sign-in and owner claim of a connect link; null for any other text or code, a link over
 * 2 KB, or a token or claim that isn't one. Other parameters are ignored.
 */
export function parseConnectLink(raw: string, opts: { allowHttp?: boolean | "loopback" } = {}): ConnectLink | null {
  const text = raw.trim();
  if (text.length > MAX_LINK) return null;
  const match = CONNECT_LINK.exec(text);
  if (!match) return null;
  const query = new URLSearchParams(match[1] ?? "");
  const server = normalizeServer(query.get("server") ?? "", opts);
  if (!server) return null;
  const link: ConnectLink = { server };
  for (const key of ["token", "claim"] as const) {
    const value = query.get(key)?.trim();
    if (!value) continue;
    if (!LINK_SECRET.test(value)) return null;
    link[key] = value;
  }
  return link;
}

export type ServerProblem = "unreachable" | "certificate" | "not-agentes" | "server-too-old" | "app-too-old";
/** `server`: the address to use, or the one that failed (a server's own address can differ from the one typed). */
export type ServerCheck =
  | { ok: true; server: string; instance: Instance }
  | { ok: false; server: string; problem: ServerProblem };

/** What `GET /api/instance` answered: an agentes.chat server these apps can use, or why not. */
export function readInstance(server: string, body: unknown): ServerCheck {
  const instance = (body ?? {}) as Partial<Instance>;
  if (instance.name !== "agentes.chat" || typeof instance.api !== "number")
    return { ok: false, server, problem: "not-agentes" };
  if (instance.api < APP_API) return { ok: false, server, problem: "server-too-old" };
  if ((instance.minApi ?? 1) > APP_API) return { ok: false, server, problem: "app-too-old" };
  return { ok: true, server, instance: instance as Instance };
}

// ponytail: a failed request reaches JavaScript only as text (localized on iOS), so a certificate problem is
// told apart by its words and everything else, a name not found included, reads as "unreachable".
const CERTIFICATE = /certific|zertifikat|ssl|tls|trust anchor/i;

async function askInstance(server: string, fetchFn: FetchLike, timeoutMs: number): Promise<ServerCheck> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${server}/api/instance`, {
      headers: { accept: "application/json" },
      signal: abort.signal,
    });
    if (res.status >= 500) return { ok: false, server, problem: "unreachable" };
    return readInstance(server, res.ok ? await res.json().catch(() => null) : null);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { ok: false, server, problem: CERTIFICATE.test(text) ? "certificate" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks a server (an origin from `normalizeServer`) whether these apps can use it. A server that names
 * another https address as its own (`PUBLIC_URL`) is used there or not at all: its realtime and its
 * computer-pairing page accept only that address.
 */
export async function checkServer(server: string, fetchFn: FetchLike = fetch, timeoutMs = 8000): Promise<ServerCheck> {
  const here = await askInstance(server, fetchFn, timeoutMs);
  if (!here.ok) return here;
  const own = normalizeServer(here.instance.url ?? "");
  return own && own !== server ? askInstance(own, fetchFn, timeoutMs) : here;
}
