import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import type { Writable } from "node:stream";

/**
 * System mode under systemd: an agent's Chrome and its AI CLIs run in slices
 * of their own inside the agent's (`agents-<uid>-browser.slice`,
 * `agents-<uid>-cli.slice`), so the Cloud's guard can tell their traffic
 * apart by the cgroup of each socket. Root moves the process (`scope.enter`),
 * and it must be there before its first byte: `/bin/sh` waits on fd 3, then
 * becomes the program (`exec`), with the pid, process group, stdin and stdout
 * the caller already holds. A move that fails or never comes leaves it where
 * it is, in the agent's own slice: nothing waits more than `ENTER_MS` and
 * nothing fails because of the gate.
 */
export type ScopeKind = "browser" | "cli";

/** `spawn`'s shape, for the call sites that start the agent's Chrome and AI CLIs. */
export type Spawn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** How long a held process waits to be moved before it starts where it is. */
export const ENTER_MS = 5000;

const HOLD = 'read -r _ <&3; exec 3<&-; exec "$0" "$@"';

/** Starts `file` held until `enter(pid, kind)` settles (`waitMs` at most). */
export function spawnGated(
  kind: ScopeKind,
  file: string,
  args: readonly string[],
  options: SpawnOptions,
  enter: (pid: number, kind: ScopeKind) => Promise<unknown>,
  waitMs = ENTER_MS,
): ChildProcess {
  const io = options.stdio ?? "pipe";
  let runnable = true;
  try {
    accessSync(file, constants.X_OK);
  } catch {
    runnable = false;
  }
  // A program that can't run fails exactly as it did, and fd 3 may already be the caller's.
  if (!runnable || options.shell || (Array.isArray(io) && io.length > 3)) return spawn(file, args, options);
  const stdio = typeof io === "string" ? [io, io, io] : [0, 1, 2].map((fd) => io[fd] ?? "pipe");
  const child = spawn("/bin/sh", ["-c", HOLD, file, ...args], { ...options, stdio: [...stdio, "pipe"] });
  const gate = child.stdio[3] as Writable | null | undefined;
  gate?.on("error", () => {});
  const release = () => gate?.end("\n");
  const pid = child.pid;
  if (!pid) {
    release();
    return child;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  void Promise.race([
    enter(pid, kind).catch(() => undefined),
    new Promise((resolve) => {
      timer = setTimeout(resolve, waitMs);
      timer.unref?.();
    }),
  ]).then(() => {
    clearTimeout(timer);
    release();
  });
  return child;
}
