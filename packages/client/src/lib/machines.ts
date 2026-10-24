import type { DeviceLocation, Machine, MachineAccess, MachineFolderGrant, MachineToolName } from "../api/types";

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

/** Where the browser runs: Apple Silicon or Intel is unknowable from the page, so Macs get the arm build. */
export const DESKTOP_TARGET = { target: "darwin", arch: "aarch64" } as const;

/** Which portrait a computer gets; same names as `ComputerKind` in @agenteschat/ui. */
export type ComputerKind = "mac" | "windows" | "linux" | "cloud";
export type ComputerState = "online" | "paused" | "offline";

/** A machine's `os` → its portrait: Macs, Windows PCs, and everything else drawn as a Linux server. */
export function computerKind(os: string | null | undefined, cloud = false): ComputerKind {
  if (cloud) return "cloud";
  const v = (os ?? "").toLowerCase();
  if (v === "darwin" || v === "macos" || v === "mac") return "mac";
  if (v === "windows" || v === "win32") return "windows";
  return "linux";
}

/** Paused wins over online (a paused machine is still connected); otherwise online or offline. */
export function computerState(m: Pick<Machine, "online" | "paused">, now = Date.now()): ComputerState {
  if (isPaused(m, now)) return "paused";
  return m.online ? "online" : "offline";
}
