/**
 * The wire protocol between our server and the runner on a connected
 * computer (ADR 0025). JSON text frames over one WebSocket the runner opens
 * to `/api/machines/connect`. Shared by the server and the runner bundle, so
 * this file imports nothing.
 */

/** Bumped on breaking changes; the server refuses runners older than `MIN_RUNNER_PROTOCOL`. */
export const MACHINE_PROTOCOL_VERSION = 3;
export const MIN_RUNNER_PROTOCOL = 1;
/** From this protocol on, requests carry `agent` and each agent works in its own folder. */
export const AGENT_FOLDERS_PROTOCOL = 2;
/** From this protocol on, the runner keeps secrets for each agent (`op: "secret"`, ADR 0027). */
export const SECRETS_PROTOCOL = 3;

/** No valid `hello` within this time closes the socket. */
export const HELLO_TIMEOUT_MS = 10_000;
/** The server pings this often; the runner reconnects after two missed pings. */
export const HEARTBEAT_MS = 25_000;
/** Largest text frame either side accepts (a `write` of 5 MB is about 6.7 MB in base64). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** `read`/`write` bodies (base64 in JSON); larger files go through `push`. */
export const MAX_INLINE_FILE_BYTES = 5 * 1024 * 1024;

export const MACHINE_TOKEN_PREFIX = "agm_";

/** Same as `SecretBox` and `SecretTarget` in `secret-box.ts` (this file imports nothing). */
export interface WireSecretBox {
  v: number;
  epk: string;
  iv: string;
  ct: string;
}
export type WireSecretTarget = { kind: "env" } | { kind: "file"; path: string };

/**
 * Secrets of the request's agent (ADR 0027): `keypair` makes the key for a
 * request (the private key stays on the machine), `deliver` opens the box and
 * stores the value, `discard` drops a request's key, `remove` forgets a secret.
 */
export type SecretRequest =
  | { action: "keypair"; requestId: string }
  | { action: "deliver"; requestId: string; name: string; target: WireSecretTarget; aad: string; box: WireSecretBox }
  | { action: "discard"; requestId: string }
  | { action: "remove"; name: string };

export type MachineOs = "linux" | "darwin" | "windows" | "other";

export interface RunnerInfo {
  /** The runner's own version (`0.1.0`). */
  version: string;
  protocol: number;
  os: MachineOs;
  arch: string;
  hostname: string;
  /** Absolute path of the workspace on the machine (shown to admins only). */
  workspace: string;
  /** `false` when started with `--no-exec`: files and uploads only. */
  exec: boolean;
}

export interface FileEntry {
  /** Relative to the workspace. */
  path: string;
  isDir: boolean;
  size: number;
}

/**
 * The agent a request is for (protocol 2+). The runner gives each agent its
 * own folder inside the workspace, `<handle>-<first 8 of id>`, and treats it
 * as that request's workspace; a renamed agent keeps its folder (found by id).
 */
export interface AgentScope {
  id: string;
  handle: string;
}

/** What the server asks. Paths are always relative to the workspace (the agent's folder when `agent` is set). */
export type MachineRequest = (
  | {
      op: "exec";
      command: string;
      /** Relative to the workspace (default: the workspace). */
      cwd?: string;
      timeoutSeconds: number;
      /** Send `output` frames while it runs. */
      stream: boolean;
    }
  | { op: "read"; path: string; maxBytes: number }
  | { op: "write"; path: string; base64: string }
  | { op: "list"; path: string; depth: number }
  | ({ op: "secret" } & SecretRequest)
  | {
      op: "push";
      path: string;
      /** Absolute URL of our upload endpoint (`PUT`, machine token as bearer). */
      url: string;
      uploadId: string;
      maxBytes: number;
    }
) & { agent?: AgentScope };

export type MachineOp = MachineRequest["op"];

/** What each op answers with `ok: true`. */
export interface MachineReplies {
  exec: { exitCode: number; stdout: string; stderr: string; timedOut: boolean; canceled?: { killed: boolean } };
  /** `base64: null`: no such file. */
  read: { base64: string | null; size: number };
  write: { size: number };
  list: { entries: FileEntry[] };
  /** What was sent: the uploaded name (`report.pdf`, or `folder.zip`), bytes and SHA-256 (hex). */
  push: { name: string; size: number; sha256: string; contentType: string };
  /** `keypair`: the public key (raw P-256, base64); `deliver`: the value's size in bytes. */
  secret: { publicKey?: string; size?: number };
}

/** Error codes the runner reports; the message is for people. */
export type MachineErrorCode =
  | "not_found"
  | "outside_workspace"
  | "exec_disabled"
  | "too_large"
  | "upload_failed"
  | "bad_request"
  | "internal";

/** Server → runner. */
export type ServerFrame =
  | { type: "welcome"; machineId: string; name: string; heartbeatMs: number }
  | ({ type: "request"; id: string } & MachineRequest)
  | { type: "cancel"; id: string }
  | { type: "ping"; at: number }
  /** The server closes after sending this (bad token, revoked, outdated runner). */
  | { type: "refused"; reason: "invalid_token" | "revoked" | "outdated" | "replaced"; message: string };

/** Runner → server. */
export type RunnerFrame =
  | ({ type: "hello"; token: string } & RunnerInfo)
  | { type: "output"; id: string; stream: "stdout" | "stderr"; chunk: string }
  | { type: "result"; id: string; ok: true; data: unknown }
  | { type: "result"; id: string; ok: false; error: { code: MachineErrorCode; message: string } }
  | { type: "pong"; at: number };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isString = (v: unknown): v is string => typeof v === "string";

/** Parses a runner frame (server side); null when it isn't one. */
export function parseRunnerFrame(raw: string): RunnerFrame | null {
  if (raw.length > MAX_FRAME_BYTES) return null;
  let f: unknown;
  try {
    f = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(f)) return null;
  switch (f.type) {
    case "hello":
      if (!isString(f.token) || !isString(f.version) || typeof f.protocol !== "number") return null;
      return {
        type: "hello",
        token: f.token,
        version: f.version.slice(0, 40),
        protocol: f.protocol,
        os: (["linux", "darwin", "windows"] as const).find((o) => o === f.os) ?? "other",
        arch: isString(f.arch) ? f.arch.slice(0, 40) : "",
        hostname: isString(f.hostname) ? f.hostname.slice(0, 200) : "",
        workspace: isString(f.workspace) ? f.workspace.slice(0, 500) : "",
        exec: f.exec !== false,
      };
    case "output":
      if (!isString(f.id) || !isString(f.chunk) || (f.stream !== "stdout" && f.stream !== "stderr")) return null;
      return { type: "output", id: f.id, stream: f.stream, chunk: f.chunk };
    case "result":
      if (!isString(f.id)) return null;
      if (f.ok === true) return { type: "result", id: f.id, ok: true, data: f.data };
      if (f.ok === false && isObject(f.error) && isString(f.error.code) && isString(f.error.message)) {
        return {
          type: "result",
          id: f.id,
          ok: false,
          error: { code: f.error.code as MachineErrorCode, message: f.error.message.slice(0, 2000) },
        };
      }
      return null;
    case "pong":
      return typeof f.at === "number" ? { type: "pong", at: f.at } : null;
    default:
      return null;
  }
}

/** Parses a server frame (runner side); null when it isn't one. */
export function parseServerFrame(raw: string): ServerFrame | null {
  if (raw.length > MAX_FRAME_BYTES) return null;
  let f: unknown;
  try {
    f = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(f) || !isString(f.type)) return null;
  if (f.type === "request") {
    if (!isString(f.id) || !isString(f.op)) return null;
    if (!["exec", "read", "write", "list", "push", "secret"].includes(f.op)) return null;
  }
  if ((f.type === "cancel" || f.type === "request") && !isString(f.id)) return null;
  if (!["welcome", "request", "cancel", "ping", "refused"].includes(f.type)) return null;
  return f as ServerFrame;
}

/** A pairing code as people type it: 8 letters/digits, dash optional, any case. */
export function normalizePairingCode(code: string) {
  return code.replace(/[\s-]/g, "").toUpperCase();
}
