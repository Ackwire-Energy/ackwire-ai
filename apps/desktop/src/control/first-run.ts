/**
 * The first run's decisions as pure state (FirstRun.tsx draws them): which screen comes next, what
 * discovery found, what a typed address or a connect link leads to. Nothing here changes the server
 * the app opens; the window does that only after the person confirmed (`chooseServer`).
 */
import { type ConnectLink, type ServerCheck, type ServerProblem, serverHost } from "@agenteschat/client/lib/server";
import type { Platform } from "./platform";
import { appServer, serverName } from "./server";

/**
 * "Run agentes.chat on this computer" on a Mac or Linux: off until that screen ships, so "Use your own
 * server" goes straight to Connect there. Windows shows its own card meanwhile (the two ways for now).
 */
export const RUN_HERE = false;

export type FirstScreen = "choose" | "own" | "connect" | "windows" | "link";

/** Where "Use your own server ›" goes: the two ways where both exist, else Connect. */
export const ownServerScreen = (platform: Platform): FirstScreen =>
  platform === "windows" || RUN_HERE ? "own" : "connect";

/** Where the run-here card on "Your own server" goes. */
export const runHereScreen = (platform: Platform): FirstScreen => (platform === "windows" ? "windows" : "connect");

/** The one-command setup, for a server without a screen; on Windows, inside WSL 2 with no network question. */
export const INSTALL_COMMAND = "curl -fsSL https://agentes.chat/install | sh";
export const WSL_INSTALL_COMMAND = `${INSTALL_COMMAND} -s -- --network local`;

/** Discovery looks this long, at most, before it shows what it found (or nothing). */
export const LOOK_MS = 3000;

/** Where discovery found a server: this computer, or the person's Tailscale network (`discover` in Rust). */
export interface Candidate {
  server: string;
  where: "here" | "tailnet";
}

/** The candidates that answered as agentes.chat servers, listed by their own address, once each. */
export function foundServers(candidates: readonly Candidate[], checks: readonly (ServerCheck | null)[]): Candidate[] {
  const out: Candidate[] = [];
  candidates.forEach((c, i) => {
    const check = checks[i];
    if (check?.ok && !out.some((f) => f.server === check.server)) out.push({ server: check.server, where: c.where });
  });
  return out;
}

/** What can go wrong with an address, in the words of `desktop.connect.*`. */
export type ConnectProblem = ServerProblem | "invalid" | "http" | "no-owner";

/** Each problem's sentence (`desktop.connect.*`, each takes `{ host }`). */
export const PROBLEM_TEXT: Record<ConnectProblem, string> = {
  invalid: "desktop.connect.invalid",
  http: "desktop.connect.httpRefused",
  "no-owner": "desktop.connect.noOwner",
  unreachable: "desktop.connect.unreachable",
  certificate: "desktop.connect.certificate",
  "not-agentes": "desktop.connect.notAgentes",
  "server-too-old": "desktop.connect.serverTooOld",
  "app-too-old": "desktop.connect.appTooOld",
};

/** A typed address: the server to check, or why it can't be one (plain http off this computer). */
export function typedServer(
  input: string,
): { ok: true; server: string } | { ok: false; problem: "invalid" | "http"; host: string } {
  const server = appServer(input);
  if (server) return { ok: true, server };
  const raw = input.trim();
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" && url.hostname) return { ok: false, problem: "http", host: url.host };
  } catch {
    // Not a URL at all.
  }
  return { ok: false, problem: "invalid", host: raw };
}

/**
 * After the check of an address the person typed or picked: use it, confirm it in large type first (the
 * server's own address is another host), or say what's wrong.
 */
export type ConnectOutcome =
  | { kind: "use"; server: string }
  | { kind: "confirm"; server: string }
  | { kind: "problem"; problem: ConnectProblem; host: string };

export function connectOutcome(asked: string, check: ServerCheck): ConnectOutcome {
  if (!check.ok) return { kind: "problem", problem: check.problem, host: serverHost(check.server) };
  if (check.instance.ownerClaim) return { kind: "problem", problem: "no-owner", host: serverHost(check.server) };
  return serverHost(check.server) === serverHost(asked)
    ? { kind: "use", server: check.server }
    : { kind: "confirm", server: check.server };
}

/** The page the main window opens on a server for a link's one-time sign-in or owner claim. */
export const handoverPath = (token: string) => `/desktop/handover#token=${token}`;
export const ownerPath = (claim: string) => `/owner#claim=${claim}`;

/**
 * A connect link's sheet. `front`: the server already open, nothing to ask (the main window comes forward).
 * `ask`: the question, the button, the page to open there (`page`), and the server being left, if any.
 */
export type LinkView =
  | { kind: "notALink" }
  | { kind: "checking"; server: string }
  | { kind: "problem"; server: string; problem: ConnectProblem }
  | { kind: "front"; server: string }
  | {
      kind: "ask";
      server: string;
      question: "question" | "questionSignIn" | "questionClaim";
      button: "connect" | "continue";
      page?: string;
      leave: string | null;
    };

export function linkView(link: ConnectLink | null, check: ServerCheck | "checking", current: string | null): LinkView {
  if (!link) return { kind: "notALink" };
  if (check === "checking") return { kind: "checking", server: link.server };
  if (!check.ok) return { kind: "problem", server: check.server, problem: check.problem };
  const server = check.server;
  const leave = current && current !== server ? serverName(current) : null;
  if (check.instance.ownerClaim) {
    return link.claim
      ? { kind: "ask", server, question: "questionClaim", button: "continue", page: ownerPath(link.claim), leave }
      : { kind: "problem", server, problem: "no-owner" };
  }
  if (link.token) {
    return {
      kind: "ask",
      server,
      question: "questionSignIn",
      button: "connect",
      page: handoverPath(link.token),
      leave,
    };
  }
  if (server === current) return { kind: "front", server };
  return { kind: "ask", server, question: "question", button: "connect", leave };
}
