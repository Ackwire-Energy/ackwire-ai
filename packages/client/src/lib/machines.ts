import type {
  AccountLoginStatus,
  DeviceLocation,
  Machine,
  MachineAccess,
  MachineAccount,
  MachineAccountKind,
  MachineFolderGrant,
  MachineToolName,
} from "../api/types";
import { errorCode } from "./errors";

/**
 * Connected computers (ADR 0025, ADR 0036): the device code, the commands the
 * site shows, and what a machine allows. Platform-neutral (web and phone).
 */

/** The alphabet of device codes (no 0/O, 1/I/L). */
const CODE_RE = /[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g;

/** "k7q·4zp", "K7Q-4ZP " → "K7Q4ZP" (what the API takes). */
export const normalizeUserCode = (raw: string) => raw.toUpperCase().replace(CODE_RE, "").slice(0, 12);

/** "K7Q4ZP" → "K7Q·4ZP", shown on both sides only to compare. */
export function formatUserCode(raw: string): string {
  const code = normalizeUserCode(raw);
  if (code.length < 4) return code;
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)}·${code.slice(half)}`;
}

/** "Curitiba, PR, Brasil" from the server's best-effort location; null when there is nothing to say. */
export function locationText(loc: DeviceLocation | null | undefined): string | null {
  if (!loc) return null;
  if (typeof loc === "string") return loc.trim() || null;
  const parts = [loc.city, loc.region, loc.country].map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** Quotes a path for a POSIX shell only when it needs it. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./~-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The terminal installer (servers, Linux): no code; it prints one to confirm in the browser. */
export const installCommand = (origin: string) =>
  `curl -fsSL ${origin.replace(/\/+$/, "")}/api/machines/install.sh | sh`;

/** Granting happens on the machine: the fallback command for people without the app. */
export const allowFolderCommand = (path: string, handle?: string) =>
  `agentes-runner folders allow ${shellQuote(path)}${handle ? ` --agent ${handle}` : ""}`;

/** The first command in a runner's own words ("…run `agentes-runner browser install --with-deps`"), to copy. */
export function commandInReason(reason: string | null | undefined): string | null {
  const m = reason ? /`([^`]+)`/.exec(reason) : null;
  return m?.[1] ?? null;
}

/**
 * Turns a tool on at the computer (`desktop`: the agents' screens): its runner's settings, which are root's in system
 * mode (ADR 0057).
 */
export const toolOnCommand = (m: Pick<Machine, "mode">, tool: keyof MachineAccess["tools"]) =>
  `${m.mode === "system" ? "sudo " : ""}agentes-runner tools enable ${tool}`;

/** A Mac or a PC: folders and tools are allowed in the agentes.chat app there. Any other may be a server without it. */
export const allowsInApp = (os: string | null | undefined) => os === "darwin" || os === "windows";

/**
 * `brain.reasons.tool_off`'s line for a brain whose tool is off on `m`: the app's Preferences on a Mac or a PC, and on
 * any other computer the command too.
 */
export function toolOffReason(m: Pick<Machine, "os" | "mode"> | null | undefined, kind: "claude_code" | "codex") {
  if (!m || allowsInApp(m.os)) return { key: "brain.reasons.tool_off" as const, command: "" };
  return {
    key: "brain.reasons.tool_offLinux" as const,
    command: toolOnCommand(m, kind === "codex" ? "codex" : "claude"),
  };
}

/** The last part of a path: "/Users/you/Projects/loja-v5" → "loja-v5". */
export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export const MACHINE_TOOLS: MachineToolName[] = ["claude", "codex", "commands"];

/** The folders of a machine an agent may use (beyond its own folder). */
export const foldersOfAgent = (access: MachineAccess | null | undefined, agentId: string): MachineFolderGrant[] =>
  (access?.folders ?? []).filter((f) => f.agents.includes(agentId));

/** Paused now: `until` absent or still ahead. */
export function isPaused(m: Pick<Machine, "paused">, now = Date.now()): boolean {
  const p = m.paused;
  // The server sends `{ until }` while paused and null otherwise; `paused: false` means not paused too.
  if (!p || p.paused === false) return false;
  if (!p.until) return true;
  const end = Date.parse(p.until);
  return Number.isNaN(end) || end > now;
}

/** The download link as given, or on `origin` when the server sends a path. */
export const downloadHref = (url: string, origin = "") => (/^https?:\/\//.test(url) ? url : `${origin}${url}`);

/** The systems the desktop app runs on (`window.__agentesDesktop.platform` on the site, `{{device}}` in the copy). */
export type Platform = "mac" | "windows" | "linux";

/** From a user agent: WKWebView or a Mac's browser, WebView2 or a Windows browser, and everything else as Linux. */
export function platformOf(userAgent: string): Platform {
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "mac";
  return "linux";
}

/** A phone or a tablet, from its browser's user agent: the app is for computers. */
export const isHandheld = (userAgent: string) => /Android|iPhone|iPad|iPod/i.test(userAgent);

/**
 * The app's build for the computer a browser runs on, as `/api/desktop/latest` names it: one build for both Mac
 * chips, x64 on Windows and Linux. Null where none fits: a phone or a tablet, or a Linux on another chip.
 */
export function desktopTargetOf(userAgent: string) {
  const platform = platformOf(userAgent);
  if (isHandheld(userAgent) || (platform === "linux" && !/x86_64|x64|amd64/i.test(userAgent))) return null;
  return platform === "mac"
    ? ({ target: "darwin", arch: "aarch64" } as const)
    : ({ target: platform, arch: "x86_64" } as const);
}

/** Which portrait a computer gets; same names as `ComputerKind` in @agenteschat/ui. */
export type ComputerKind = "mac" | "windows" | "linux";
export type ComputerState = "online" | "paused" | "offline";

/** A machine's `os` → its portrait: Macs, Windows PCs, and everything else drawn as a Linux server. */
export function computerKind(os: string | null | undefined): ComputerKind {
  const v = (os ?? "").toLowerCase();
  if (v === "darwin" || v === "macos" || v === "mac") return "mac";
  if (v === "windows" || v === "win32") return "windows";
  return "linux";
}

/**
 * Who may turn a tool off or take a folder away here: an admin or whoever connected it, never on the
 * workspace's own computer, where nobody in the workspace could turn them back on (ADR 0056 §10).
 */
export const canReduceAccess = (m: Pick<Machine, "canManage" | "kind">) => m.canManage && m.kind !== "managed";

/** Paused wins over online (a paused machine is still connected); otherwise online or offline. */
export function computerState(m: Pick<Machine, "online" | "paused">, now = Date.now()): ComputerState {
  if (isPaused(m, now)) return "paused";
  return m.online ? "online" : "offline";
}

/**
 * Which `machines.host.*` line says what the server's own computer is: one
 * user per agent on Linux (the runner's system mode there), the installer's
 * own user on a Mac, neither said until it first connects.
 */
export function hostDescKey(os: string): "descUsers" | "descShared" | "desc" {
  if (os === "linux") return "descUsers";
  return os === "darwin" ? "descShared" : "desc";
}

/** What a computer is called on screen: its name, or `hostLabel` for the server's own until its runner names it. */
export const machineTitle = (m: Pick<Machine, "name" | "kind">, hostLabel: string) =>
  m.name || (m.kind === "host" ? hostLabel : "");

/**
 * A code pasted for a Claude sign-in is this sign-in's when it ends with `#<state>` of its link (what
 * Claude's page shows). Only then does a paste go to the computer without a tap: anything else from the
 * clipboard (a password) waits for the person.
 */
export function isSignInCode(text: string, signInUrl: string): boolean {
  let state: string | null = null;
  try {
    state = new URL(signInUrl).searchParams.get("state");
  } catch {
    return false;
  }
  const code = text.trim();
  return Boolean(state) && code.length > (state?.length ?? 0) + 1 && code.endsWith(`#${state}`) && !/\s/.test(code);
}

/** What starts a sign-in on the computer (`beginAccountLogin`'s options). */
export interface AccountLoginInput {
  accountId?: string;
  email?: string;
  provider?: string;
}

/**
 * Starts a sign-in on the computer: again to `again` (signed out), or a coding plan's key account (`provider`). Claude
 * takes `hint`, the email of the account it should be, as its CLI's login hint: the account's own when it signs in
 * again, never asked of the person. A hint the server refuses only steered Claude's page, so it starts without one.
 */
export async function beginLogin<T>(
  begin: (input: AccountLoginInput) => Promise<T>,
  kind: MachineAccountKind,
  { again, provider, hint }: { again?: string | undefined; provider?: string | undefined; hint?: string | null },
): Promise<T> {
  const input: AccountLoginInput = { ...(again ? { accountId: again } : {}), ...(provider ? { provider } : {}) };
  if (kind !== "claude_code" || provider || !hint) return begin(input);
  try {
    return await begin({ ...input, email: hint });
  } catch (error) {
    if (errorCode(error) !== "account.invalid_email") throw error;
    return begin(input);
  }
}

/**
 * The account a sign-in came back as when its person already has it on that computer (the new sign-in is removed
 * there): theirs to think with instead, while it is signed in and no agent thinks with it, or it thinks for all of
 * their agents there (`shared`).
 */
export function freeDuplicate(status: AccountLoginStatus | undefined): MachineAccount | null {
  const account = status?.duplicate?.account;
  return account?.status === "active" && (account.usedBy.length === 0 || account.shared === true) ? account : null;
}

/**
 * A new sign-in came back as another account than its hint (Claude's login hint only steers Claude's page): the
 * person's to use or not, never thought with on its own.
 */
export const otherThanHint = (hint: string | null | undefined, account: Pick<MachineAccount, "email">): boolean =>
  Boolean(hint && account.email && account.email.toLowerCase() !== hint.toLowerCase());
