import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { errnoCode } from "./errors";

/**
 * One runner per home (ADR 0036 §4): `<home>/runner.lock` holds the PID of
 * the runner that took it (`start` or `app`). A second runner on the same
 * home finds a live PID and stops with a clear message; a lock whose PID is
 * gone (a crash, a reboot) is stale and taken over.
 */

export const LOCK_FILE = "runner.lock";

export interface LockInfo {
  pid: number;
  mode: string;
  startedAt: string;
}

export type LockResult = { ok: true; release: () => void } | { ok: false; holder: LockInfo };

/** Whether a process with this PID exists (EPERM: it exists, it just isn't ours). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) === "EPERM";
  }
}

export function readLock(home: string): LockInfo | null {
  try {
    const v = JSON.parse(readFileSync(path.join(home, LOCK_FILE), "utf8")) as Partial<LockInfo>;
    if (typeof v.pid !== "number") return null;
    return {
      pid: v.pid,
      mode: typeof v.mode === "string" ? v.mode : "",
      startedAt: typeof v.startedAt === "string" ? v.startedAt : "",
    };
  } catch {
    return null;
  }
}

/** Takes the home's lock for this process, or says who holds it. */
export function acquireLock(
  home: string,
  mode: string,
  opts: { pid?: number; alive?: (pid: number) => boolean } = {},
): LockResult {
  const pid = opts.pid ?? process.pid;
  const alive = opts.alive ?? pidAlive;
  const file = path.join(home, LOCK_FILE);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const info: LockInfo = { pid, mode, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(info));
      } finally {
        closeSync(fd);
      }
      return {
        ok: true,
        release: () => {
          // Only our own lock: a runner that took over a lock we thought stale keeps its own.
          if (readLock(home)?.pid === pid) rmSync(file, { force: true });
        },
      };
    } catch (err) {
      if (errnoCode(err) !== "EEXIST") throw err;
    }
    const holder = readLock(home);
    if (holder && holder.pid !== pid && alive(holder.pid)) return { ok: false, holder };
    // Stale (its process is gone), unreadable, or our own PID from before a restart: take it over.
    rmSync(file, { force: true });
  }
  const holder = readLock(home);
  return { ok: false, holder: holder ?? { pid: 0, mode: "", startedAt: "" } };
}

/** The message a second runner prints. */
export function lockedMessage(home: string, holder: LockInfo) {
  return `Another agentes runner is already running with this home (${home}, pid ${holder.pid}${holder.mode ? `, ${holder.mode}` : ""}). Stop it first, or use another home (--home or AGENTES_RUNNER_HOME).`;
}
