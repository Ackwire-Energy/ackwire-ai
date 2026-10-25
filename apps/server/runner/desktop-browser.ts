import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { chmodSync, chownSync, rmSync, statSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { BROWSER_ICON, BROWSER_WM_CLASS } from "./desktop-look";
import { toMachineError } from "./errors";

/**
 * Browser on an agent's desktop (ADR 0058 §7): the dock's and the apps menu's Browser runs
 * `agentes-runner desktop-browser <socket>`, which asks the runner, over that desktop's socket, to bring the
 * agent's own Chrome onto it.
 *
 * - The runner owns that Chrome (its debugging port, its pids, its profile), so the runner starts or moves it:
 *   never a second Chrome on the profile. Its sign-ins are the agent's, so whoever signs in to a site there
 *   signs the agent in.
 * - The socket sits next to the desktop's password file: in system mode in root's folder for that agent, which
 *   only the agent's group may enter, so only the agent's own user reaches it (and it may already run anything as
 *   itself). It takes one word, `open`: no address, no flag, nothing that widens what the browser reaches.
 * - While Chrome for Testing installs (the agent's first browser), a small window on the desktop says so; when
 *   the browser can't open, one says why.
 */

/** The socket's name, in the folder of the desktop's password file. */
export const BROWSER_SOCKET = "browser.sock";
/** The one word the launcher says. */
const OPEN = "open";
/** A connection that hasn't said it by then is dropped. */
const ASK_MS = 5000;
/** Chrome for Testing's download and install, then Chrome's start: the launcher gives up after this. */
const SHOW_MS = 16 * 60_000;
/** A reason the launcher shows, at most. */
const WHY_MAX = 300;

const why = (err: unknown) => toMachineError(err).message.replace(/\s+/g, " ").trim().slice(0, WHY_MAX);

/**
 * Answers the Browser of one agent's desktop on `socket`: `open` in; `installing` while Chrome for Testing
 * installs first, then `ok` or `error <why>`. One click at a time: one while another runs gets that one's answer.
 * The socket takes its folder's group (the agent's, in system mode), and only that group may write to it.
 */
export async function serveBrowser(socket: string, open: (installing: () => void) => Promise<void>): Promise<Server> {
  let current: { done: Promise<void>; installing: boolean; waiting: Set<Socket> } | null = null;
  const say = (conn: Socket, line: string) => {
    if (!conn.destroyed) conn.write(`${line}\n`);
  };
  const end = (conn: Socket, line: string) => {
    if (!conn.destroyed) conn.end(`${line}\n`);
  };
  const show = (conn: Socket) => {
    let c = current;
    if (!c) {
      const next: NonNullable<typeof current> = { installing: false, waiting: new Set(), done: Promise.resolve() };
      next.done = (async () =>
        open(() => {
          next.installing = true;
          for (const waiting of next.waiting) say(waiting, "installing");
        }))();
      const over = () => {
        if (current === next) current = null;
      };
      next.done.then(over, over);
      current = next;
      c = next;
    }
    c.waiting.add(conn);
    if (c.installing) say(conn, "installing");
    c.done.then(
      () => end(conn, "ok"),
      (err: unknown) => end(conn, `error ${why(err)}`),
    );
  };
  rmSync(socket, { force: true });
  const server = createServer((conn) => {
    let heard = "";
    const late = setTimeout(() => conn.destroy(), ASK_MS);
    conn.setEncoding("utf8");
    conn.on("error", () => undefined);
    conn.on("close", () => clearTimeout(late));
    const listen = (chunk: string) => {
      heard += chunk;
      const at = heard.indexOf("\n");
      if (at < 0) {
        if (heard.length > OPEN.length) conn.destroy();
        return;
      }
      clearTimeout(late);
      conn.off("data", listen);
      if (heard.slice(0, at) === OPEN) show(conn);
      else conn.destroy();
    };
    conn.on("data", listen);
  });
  const events = server as unknown as EventEmitter;
  await new Promise<void>((resolve, reject) => {
    events.once("error", reject);
    server.listen(socket, () => {
      events.off("error", reject);
      resolve();
    });
  });
  events.on("error", () => undefined);
  try {
    const { gid } = statSync(path.dirname(socket));
    if (gid !== process.getgid?.()) chownSync(socket, process.getuid?.() ?? 0, gid);
    chmodSync(socket, 0o660);
  } catch (err) {
    closeBrowser(server, socket);
    throw err;
  }
  return server;
}

/** Closes a Browser socket and removes its file. */
export function closeBrowser(server: Server, socket: string) {
  server.close();
  rmSync(socket, { force: true });
}

/** A small window on the desktop: the wait while the browser gets ready, or why it didn't open. */
export type DesktopNote = (kind: "wait" | "error", text: string) => { close(): void };

const WAIT = "Getting the browser ready…\nThe first time takes about a minute. It opens by itself.";
const FAILED = "The browser didn't open.";

/**
 * The note as an xfce4-terminal of its own (every desktop has one), small, with no menu or bars: the text
 * wrapped and indented, the cursor hidden; the wait stays until closed, the reason until Enter. Its window class
 * is Browser's, so the dock shows it there.
 */
export function noteArgs(kind: "wait" | "error", text: string): string[] {
  const end = kind === "wait" ? `exec sleep ${SHOW_MS / 1000}` : "printf '\\n  %s' 'Press Enter to close.'; read -r _";
  return [
    "--disable-server",
    `--class=${BROWSER_WM_CLASS}`,
    "--title=Browser",
    `--icon=${BROWSER_ICON}`,
    "--hide-menubar",
    "--hide-toolbar",
    "--hide-scrollbar",
    `--geometry=${kind === "wait" ? "60x6" : "60x10"}`,
    "-x",
    "/bin/sh",
    "-c",
    `printf '\\033[?25l\\n'; printf '%s\\n' "$1" | fold -s -w 56 | sed 's/^/  /'; ${end}`,
    "sh",
    text,
  ];
}

const terminalNote: DesktopNote = (kind, text) => {
  const child = spawn("xfce4-terminal", noteArgs(kind, text), { stdio: "ignore", detached: kind === "error" });
  (child as unknown as EventEmitter).on("error", () => undefined);
  if (kind === "error") child.unref();
  return { close: () => child.kill() };
};

/** The runner's answer: null once the browser is open, else why it isn't. */
function ask(socket: string, installing: () => void, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let buffer = "";
    let done = false;
    const conn = createConnection(socket);
    const finish = (reason: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(reason);
    };
    const timer = setTimeout(() => finish("It is taking too long. Try again in a minute."), timeoutMs);
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(`${OPEN}\n`));
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line === "installing") installing();
        else if (line === "ok") return finish(null);
        else if (line.startsWith("error ")) return finish(line.slice("error ".length));
      }
    });
    conn.on("error", () => finish("agentes.chat isn't running on this computer right now. Try again in a minute."));
    conn.on("close", () => finish("agentes.chat stopped before it opened. Try again in a minute."));
  });
}

/**
 * `agentes-runner desktop-browser <socket>`, from the desktop (its session's environment): asks for the agent's
 * browser on it, with the wait shown while Chrome for Testing installs and the reason when it doesn't open.
 */
export async function runDesktopBrowser(
  socket: string,
  o: { note?: DesktopNote; timeoutMs?: number } = {},
): Promise<number> {
  const note = o.note ?? terminalNote;
  let wait: ReturnType<DesktopNote> | null = null;
  const reason = await ask(
    socket,
    () => {
      wait ??= note("wait", WAIT);
    },
    o.timeoutMs ?? SHOW_MS,
  );
  (wait as ReturnType<DesktopNote> | null)?.close();
  if (reason === null) return 0;
  note("error", `${FAILED}\n${reason}`);
  return 1;
}
