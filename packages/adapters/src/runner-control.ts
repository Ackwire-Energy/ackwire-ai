/**
 * The control protocol between the desktop app and the runner it spawns
 * (ADR 0036). The app starts `agentes-runner app --home <dir>` as a child
 * process; stdin carries one `ControlIn` JSON object per line, stdout one
 * `ControlOut` per line. Nothing else is ever written to stdout in this mode
 * (logs go to `<home>/logs/`). Only the parent can talk to the runner: no
 * socket, no port. The machine token never crosses this channel.
 *
 * Shared by the runner and the desktop app, so this file imports nothing but
 * types from the machine protocol.
 */
import type { RunnerAccess, RunnerExecutorInfo, RunnerPause, RunnerTools } from "./machine-protocol";

/** Bumped on breaking changes; the app refuses a runner whose `hello.control` it doesn't know. */
export const CONTROL_PROTOCOL_VERSION = 1;

/** Largest line either side accepts (characters). */
export const CONTROL_MAX_LINE = 1024 * 1024;

/** An agent as the machine knows it (from the server's `agents` frame). */
export interface ControlAgent {
  id: string;
  handle: string;
  name: string;
  /** The agent's look, for drawing it with the shared engine; absent: the default look. */
  look?: { color?: string; eyes?: string; accessory?: string };
}

/** Where the runner stands. */
export interface ControlStatus {
  paired: boolean;
  /** Our server, e.g. `https://agentes.chat`. */
  server?: string;
  /**
   * `logoEtag`: the organization's logo cached on this computer (absent: none);
   * when it changes the app asks `org.logo` again.
   */
  org?: { id: string; name: string; logoEtag?: string };
  machine?: { id: string; name: string };
  /**
   * `unpaired`: no config yet; `connecting`/`online`/`offline`: the socket;
   * `refused`: the server closed it for good (`refusedReason`); `outdated`:
   * the server needs a newer runner (the app says "Atualize").
   */
  connection: "unpaired" | "connecting" | "online" | "offline" | "refused" | "outdated";
  refusedReason?: "invalid_token" | "revoked" | "replaced";
  /** The runner's version and machine protocol. */
  version: string;
  protocol: number;
  paused: RunnerPause;
  executors: { claude?: RunnerExecutorInfo; codex?: RunnerExecutorInfo };
  /** Absolute path of the workspace (the agents' folders live inside it). */
  workspace?: string;
  /** Agents of the organization that use this computer. */
  agents: ControlAgent[];
  /** Protocol 10: folders and tools allowed on this machine. */
  access?: RunnerAccess;
}

/** Something running now on behalf of an agent. */
export interface ControlJob {
  id: string;
  agent?: { id: string; name: string };
  kind: "exec" | "read" | "write" | "list" | "push" | "task" | "brain";
  /** Short, human, English-free when possible: the app shows it as is, e.g. a command or a file name. */
  summary: string;
  /** Folder name it works in (last part of the cwd), when known. */
  where?: string;
  /** The command line (redacted), for `exec` and shell tasks. */
  command?: string;
  startedAt: string;
  /** A background task (survives runner restarts). */
  background?: boolean;
}

/** One line of the local activity log (`<home>/activity.jsonl`). */
export interface ActivityEntry {
  at: string;
  agent?: { id: string; name: string };
  kind: "file" | "command" | "task" | "brain" | "access" | "pause" | "pair" | "update";
  /** What happened, short (`read src/app.ts`, `bun test`, `paused until 16:24`). */
  summary: string;
  /** The command line with secrets redacted. */
  command?: string;
  /** Folder name it happened in. */
  where?: string;
  result?: "ok" | "failed" | "refused" | "running";
}

/** A folder an agent asked for, waiting for the person (protocol 10). */
export interface ControlAccessRequest {
  requestId: string;
  agent: { id: string; name: string };
  path: string;
  reason: string;
  at: string;
  expiresAt: string;
}

/** Settings the app may change (never the token, server, machine id). */
export interface ControlConfigPatch {
  name?: string;
  maxConcurrentTasks?: number;
  taskMaxSeconds?: number;
  brainIdleMinutes?: number;
  brainMaxProcesses?: number;
}

/** Settings as `config.get` returns them. */
export interface ControlConfig extends Required<ControlConfigPatch> {
  workspace: string;
  managedBy?: "desktop";
}

/** App → runner requests. Every request is answered by exactly one `reply` with the same `id`. */
export type ControlRequest =
  | { type: "status" }
  | { type: "jobs" }
  | { type: "pause"; until: string | null }
  | { type: "resume" }
  /** Newest first; `before`: an `at` from the previous page. */
  | { type: "activity"; before?: string; limit?: number; agentId?: string }
  | { type: "config.get" }
  | { type: "config.set"; patch: ControlConfigPatch }
  /**
   * Starts the device-code sign-in against `server` (ADR 0036 §5). The reply
   * comes at once; progress comes as `pair.code`, then `pair.done` or
   * `pair.failed` events.
   */
  | {
      type: "pair.start";
      server: string;
      name?: string;
      /**
       * Which coding CLIs the person chose at first run (ADR 0036 §8: off
       * unless chosen). Commands always start off from the app. Absent: both off.
       */
      tools?: { claude?: boolean; codex?: boolean };
    }
  | { type: "pair.cancel" }
  /** Forgets the pairing (the token is deleted; the server side is the site's "Desconectar"). */
  | { type: "unpair" }
  | { type: "diagnostics" }
  /** The organization's logo, fetched by the runner with its token (the app never sees the token). */
  | { type: "org.logo" }
  /** Protocol 10. */
  | { type: "access.get" }
  | { type: "folders.add"; path: string; agents: string[] }
  | { type: "folders.remove"; path: string; agentId?: string }
  | { type: "folders.setAgents"; path: string; agents: string[] }
  | { type: "tools.set"; tool: keyof RunnerTools; on: boolean }
  | { type: "access.pending" }
  | { type: "access.answer"; requestId: string; decision: "granted" | "denied"; scope: "agent" | "all" }
  /** Finish what's running briefly, then exit 0 (the app quits). */
  | { type: "shutdown" };

export type ControlIn = { id: string } & ControlRequest;

/** What each request answers with `ok: true`. */
export interface ControlReplies {
  status: ControlStatus;
  jobs: { jobs: ControlJob[] };
  pause: { paused: RunnerPause };
  resume: { paused: RunnerPause };
  activity: { entries: ActivityEntry[]; more: boolean };
  "config.get": ControlConfig;
  "config.set": ControlConfig;
  "pair.start": { started: true };
  "pair.cancel": { canceled: boolean };
  unpair: { unpaired: true };
  /** Redacted: versions, OS, recent log lines with secrets removed. Safe to paste in a support chat. */
  diagnostics: { text: string };
  /** A `data:image/png|jpeg|webp;base64,…` URL; null without a logo (the app draws the initial). */
  "org.logo": { logo: string | null };
  "access.get": RunnerAccess;
  "folders.add": RunnerAccess;
  "folders.remove": RunnerAccess;
  "folders.setAgents": RunnerAccess;
  "tools.set": RunnerAccess;
  "access.pending": { requests: ControlAccessRequest[] };
  "access.answer": { access: RunnerAccess };
  shutdown: { stopping: true };
}

export type ControlErrorCode =
  | "bad_request"
  | "not_paired"
  | "already_paired"
  | "not_found"
  /** A folder that doesn't exist, isn't a directory, or is a system folder we refuse (`/`, the home itself). */
  | "invalid_path"
  | "internal";

/** Something happened; the app updates its view. */
export type ControlEvent =
  | { kind: "status"; status: ControlStatus }
  | { kind: "job.started"; job: ControlJob }
  | { kind: "job.finished"; jobId: string; result: "ok" | "failed" | "refused" }
  | { kind: "activity"; entry: ActivityEntry }
  | { kind: "pair.code"; userCode: string; verificationUrl: string; expiresAt: string }
  | { kind: "pair.done"; org: { id: string; name: string }; machine: { id: string; name: string } }
  | { kind: "pair.failed"; code: "expired" | "denied" | "network" | "internal"; message: string }
  | { kind: "access.requested"; request: ControlAccessRequest }
  | { kind: "access.resolved"; requestId: string; decision: "granted" | "denied" | "expired" }
  | { kind: "access.changed"; access: RunnerAccess };

/** Runner → app. */
export type ControlOut =
  /** First line after start. */
  | { type: "hello"; control: number; version: string; protocol: number; home: string }
  | { type: "reply"; id: string; ok: true; data: unknown }
  | { type: "reply"; id: string; ok: false; error: { code: ControlErrorCode; message: string } }
  | { type: "event"; event: ControlEvent };

/** Parses one stdin line; null when it isn't a request we know. */
export function parseControlIn(line: string): ControlIn | null {
  if (line.length > CONTROL_MAX_LINE) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id || o.id.length > 100 || typeof o.type !== "string") return null;
  return o as unknown as ControlIn;
}
