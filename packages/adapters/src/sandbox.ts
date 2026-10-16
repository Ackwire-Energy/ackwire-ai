/**
 * Isolated environments where agents run code (D30). Core talks to this
 * interface only; Cloud uses Daytona (REST API), tests use the fake. Nothing
 * secret of ours ever goes in: no environment variables are passed, at
 * creation or per command, and the network is blocked unless the org allows
 * domains. The only secrets a computer holds are those a person sealed to it
 * (ADR 0027), which we relay without being able to read.
 */
import { createHash } from "node:crypto";
import type { MachineReplies, SecretRequest } from "./machine-protocol";

export interface SandboxResources {
  cpu: number;
  /** GiB. */
  memoryGiB: number;
  /** GiB. */
  diskGiB: number;
}

export type SandboxState = "creating" | "starting" | "started" | "stopped" | "archived" | "error" | "destroyed";

/** The organization's choice: no internet, only some domains, or open egress (never secrets either way). */
export type NetworkMode = "blocked" | "allowlist" | "open";

/** The mode a spec asks for (`allowDomains` alone means allowlist when it has entries). */
export const networkModeOf = (spec: { network?: NetworkMode; allowDomains: string[] }): NetworkMode =>
  spec.network ?? (spec.allowDomains.length > 0 ? "allowlist" : "blocked");

export interface SandboxSpec {
  /** Our key ("org:…:thread:…"), kept as a label for support; never a secret. */
  key: string;
  labels: Record<string, string>;
  /** Domains the sandbox may reach (`pypi.org`, `*.npmjs.org`), for `allowlist`. */
  allowDomains: string[];
  /** Default: `allowlist` when there are domains, else `blocked`. */
  network?: NetworkMode;
  /** Stop after this many idle minutes. */
  autoStopMinutes: number;
  /** Archive (files kept, cheaper storage) this many minutes after stopping. Never deleted automatically. */
  autoArchiveMinutes: number;
}

export interface SandboxInfo {
  id: string;
  state: SandboxState;
  resources: SandboxResources;
  /** How the network ended up: `blocked`, `allowlist`, `open`, or `provider-default` (the provider refused a per-sandbox policy). */
  network: NetworkMode | "provider-default";
}

export interface ExecRequest {
  command: string;
  /** Relative to the workspace (default: the workspace). */
  cwd?: string;
  timeoutSeconds: number;
  /** Stops the command (killed when the provider can; else we stop waiting): the run was canceled. */
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Stopped by `signal`. `killed` false: the provider couldn't kill it, we only stopped waiting. */
  canceled?: { killed: boolean };
}

/** Exit code of a canceled command (like Ctrl+C). */
export const CANCELED_EXIT_CODE = 130;

class ExecCanceledError extends Error {}

export const canceledResult = (stdout: string, stderr: string, killed: boolean): ExecResult => ({
  exitCode: CANCELED_EXIT_CODE,
  stdout,
  stderr,
  timedOut: false,
  canceled: { killed },
});

export interface SandboxFile {
  /** Relative to the workspace. */
  path: string;
  isDir: boolean;
  size: number;
}

/** Where a computer sends a file (`pushFile`): our one-time upload URL, authenticated by the computer's own token. */
export interface PushTarget {
  /** Absolute URL of our upload endpoint (`PUT`). */
  url: string;
  uploadId: string;
  maxBytes: number;
}

/** What a computer sent: the uploaded name (`report.pdf`, or `folder.zip`), size, SHA-256 (hex) and type. */
export type PushReceipt = MachineReplies["push"];

/** Turning a computer on and off (ADR 0025). Connected machines have none: they are on while their runner is. */
export interface ComputerLifecycle {
  /** Creates a sandbox and waits until it runs. */
  create(spec: SandboxSpec): Promise<SandboxInfo>;
  /** Null when it no longer exists. */
  get(id: string): Promise<SandboxInfo | null>;
  /** Starts a stopped or archived sandbox and waits; throws SandboxGoneError when it can't come back. */
  ensureStarted(id: string): Promise<SandboxInfo>;
  stop(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  /** Changes the network of an existing (running) sandbox in place; returns what applies now. */
  setNetwork(id: string, mode: NetworkMode, allowDomains: string[]): Promise<SandboxInfo["network"]>;
}

/** Talking to a running computer: commands and files (ADR 0025). */
export interface ComputerChannel {
  /** Runs a shell command in the workspace. No environment variables are passed. */
  exec(id: string, request: ExecRequest): Promise<ExecResult>;
  /**
   * The same, telling `onOutput` what it prints while it runs (new text only,
   * stdout and stderr apart). Providers without streaming report it all at the end.
   */
  execStream?(
    id: string,
    request: ExecRequest,
    onOutput: (stream: "stdout" | "stderr", chunk: string) => void,
  ): Promise<ExecResult>;
  /** Paths are relative to the workspace; parents are created. */
  writeFile(id: string, path: string, data: Uint8Array): Promise<void>;
  /** Null when the file doesn't exist. */
  readFile(id: string, path: string): Promise<Uint8Array | null>;
  listFiles(id: string, path: string, depth?: number): Promise<SandboxFile[]>;
  /**
   * The computer sends a file (a folder: zipped) straight to `target`, so the
   * bytes never pass through the model. Channels without it: the server reads
   * the file itself (`readFile`).
   */
  pushFile?(id: string, path: string, target: PushTarget): Promise<PushReceipt>;
  /**
   * Secrets for the agent (ADR 0027), kept by the computer itself. Channels
   * without it (cloud computers) run the secrets helper through `exec`.
   */
  secret?(id: string, request: SecretRequest): Promise<{ publicKey?: string; size?: number }>;
}

export type SandboxProvider = ComputerLifecycle & ComputerChannel & { readonly id: string };

/** The sandbox was deleted or broke for good: the caller makes a new one. */
export class SandboxGoneError extends Error {
  constructor(message = "the sandbox no longer exists") {
    super(message);
    this.name = "SandboxGoneError";
  }
}

/** The provider failed (network, 5xx, refused request). */
export class SandboxProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SandboxProviderError";
  }
}

/** Where agents' files live inside every computer (as agents and people see it). */
export const WORKSPACE = "/workspace";

/**
 * Finds (and makes) the workspace on an image that isn't ours: `/workspace`
 * when it exists or passwordless sudo can create it for this user, else
 * `$HOME/workspace`. Prints the path on its last line.
 */
export const WORKSPACE_PROBE = [
  "if [ -d /workspace ] && [ -w /workspace ]; then echo /workspace;",
  'elif sudo -n mkdir -p /workspace 2>/dev/null && sudo -n chown "$(id -u):$(id -g)" /workspace 2>/dev/null; then echo /workspace;',
  'else mkdir -p "$HOME/workspace" && echo "$HOME/workspace"; fi',
].join(" ");

/**
 * Hides the provider from what agents and people read: its home paths become
 * `/workspace` or `~`, and its name becomes "computador".
 */
export function maskProvider(text: string) {
  return text
    .replace(/\/home\/daytona\/workspace/g, WORKSPACE)
    .replace(/\/home\/daytona/g, "~")
    .replace(/daytona/gi, "computador");
}

/** A workspace-relative path, cleaned: no `..`, no absolute paths outside it. */
export function workspacePath(path: string) {
  const trimmed = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/workspace(\/|$)/, "");
  const parts = trimmed.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) throw new Error(`invalid path: ${path}`);
  return parts.join("/");
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Wraps a command so stdout and stderr come back apart from a provider that
 * returns them combined: stderr goes to a file, printed after a random marker.
 */
export function splitOutputScript(command: string, marker: string) {
  const err = `/tmp/.agentes-stderr-${marker}`;
  return `{ ${command}\n} 2>${err}; ec=$?; printf '\\n%s\\n' ${shellQuote(marker)}; cat ${err} 2>/dev/null; rm -f ${err}; exit $ec`;
}

export function parseSplitOutput(result: string, marker: string) {
  const at = result.lastIndexOf(`\n${marker}\n`);
  if (at < 0) return { stdout: result, stderr: "" };
  return { stdout: result.slice(0, at), stderr: result.slice(at + marker.length + 2) };
}

type DaytonaSandbox = {
  id: string;
  state?: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  toolboxProxyUrl?: string;
  errorReason?: string;
};

const STATES: Record<string, SandboxState> = {
  creating: "creating",
  restoring: "starting",
  starting: "starting",
  pulling_snapshot: "creating",
  pending_build: "creating",
  building_snapshot: "creating",
  resizing: "starting",
  started: "started",
  stopping: "stopped",
  stopped: "stopped",
  pausing: "stopped",
  paused: "stopped",
  resuming: "starting",
  archiving: "archived",
  archived: "archived",
  destroying: "destroyed",
  destroyed: "destroyed",
  error: "error",
  build_failed: "error",
};

/**
 * Daytona over its REST API (main API for lifecycle, toolbox proxy for
 * commands and files), bearer API key. Created sandboxes get an empty `env`,
 * `public: false`, block-all network or a domain allowlist, auto-stop,
 * auto-archive and never auto-delete. On Daytona tiers that refuse a per-sandbox network policy,
 * creation is retried once without it (the org-level policy then applies:
 * essential services only) and the sandbox is marked `provider-default`.
 */
export function createDaytonaSandboxProvider(options: {
  apiKey: string;
  apiUrl?: string;
  target?: string;
  /**
   * Our snapshot (infra/sandbox/Dockerfile: user `agente`, `/workspace`).
   * Unset: the provider's default image, where `/workspace` is created on first start.
   */
  snapshot?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Tests: no waiting between polls. */
  pollMs?: number;
  readyTimeoutMs?: number;
}): SandboxProvider {
  const http = options.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const api = (options.apiUrl ?? "https://app.daytona.io/api").replace(/\/$/, "");
  // Agents and people always see `/workspace`. With our snapshot it is the real path; on the
  // provider's default image it may have to live in the user's home (no root to create it).
  const roots = new Map<string, string>();
  const pollMs = options.pollMs ?? 1000;
  const streamPollMs = options.pollMs ?? 500;
  const readyTimeoutMs = options.readyTimeoutMs ?? 90_000;
  const toolbox = new Map<string, string>();
  const networks = new Map<string, SandboxInfo["network"]>();
  const auth = { authorization: `Bearer ${options.apiKey}` };

  async function call(url: string, init: RequestInit & { timeoutMs?: number; cancel?: AbortSignal } = {}) {
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(init.timeoutMs ?? 30_000);
      res = await http(url, {
        ...init,
        headers: { ...auth, ...(init.headers as Record<string, string> | undefined) },
        signal: init.cancel ? AbortSignal.any([timeout, init.cancel]) : timeout,
      });
    } catch (error) {
      if (init.cancel?.aborted) throw new ExecCanceledError();
      throw new SandboxProviderError(
        `could not reach the computer service: ${maskProvider(error instanceof Error ? error.message : String(error))}`,
      );
    }
    return res;
  }

  async function fail(res: Response, what: string): Promise<never> {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status === 404) throw new SandboxGoneError(`${what}: not found`);
    throw new SandboxProviderError(
      `the computer service refused ${what} (${res.status}): ${maskProvider(text)}`,
      res.status,
    );
  }

  const info = (s: DaytonaSandbox): SandboxInfo => {
    if (s.toolboxProxyUrl) toolbox.set(s.id, s.toolboxProxyUrl.replace(/\/$/, ""));
    return {
      id: s.id,
      state: STATES[s.state ?? ""] ?? "starting",
      resources: { cpu: s.cpu ?? 1, memoryGiB: s.memory ?? 1, diskGiB: s.disk ?? 3 },
      network: networks.get(s.id) ?? "blocked",
    };
  };

  async function getRaw(id: string): Promise<DaytonaSandbox | null> {
    const res = await call(`${api}/sandbox/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) return fail(res, "get sandbox");
    return (await res.json()) as DaytonaSandbox;
  }

  async function waitStarted(id: string): Promise<SandboxInfo> {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      const raw = await getRaw(id);
      if (!raw) throw new SandboxGoneError();
      const s = info(raw);
      if (s.state === "started") return s;
      if (s.state === "error" || s.state === "destroyed") {
        throw new SandboxGoneError(
          `the computer is ${raw.state}${raw.errorReason ? `: ${maskProvider(raw.errorReason)}` : ""}`,
        );
      }
      if (Date.now() > deadline) throw new SandboxProviderError("the sandbox took too long to start");
      await Bun.sleep(pollMs);
    }
  }

  const toolboxUrl = async (id: string, path: string) => {
    let base = toolbox.get(id);
    if (!base) {
      const raw = await getRaw(id);
      if (!raw) throw new SandboxGoneError();
      info(raw);
      base = toolbox.get(id) ?? "https://proxy.app.daytona.io/toolbox";
    }
    return `${base}/${encodeURIComponent(id)}${path}`;
  };

  /** Runs a shell script as is (base64 through `sh`), in `cwd`. No `envs`, ever. */
  async function run(id: string, script: string, cwd: string, timeoutSeconds: number, cancel?: AbortSignal) {
    const encoded = Buffer.from(script, "utf8").toString("base64");
    const res = await call(await toolboxUrl(id, "/process/execute"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: `sh -c "echo ${encoded} | base64 -d | sh"`, cwd, timeout: timeoutSeconds }),
      timeoutMs: (timeoutSeconds + 30) * 1000,
      cancel,
    });
    return res;
  }

  /**
   * The real workspace of a sandbox: `/workspace` (our snapshot, or created
   * with passwordless sudo), else `$HOME/workspace`. Found once per sandbox;
   * never fails a command (falls back to `/workspace`).
   */
  async function rootOf(id: string): Promise<string> {
    if (options.snapshot) return WORKSPACE;
    const known = roots.get(id);
    if (known) return known;
    let root = WORKSPACE;
    try {
      const res = await run(id, WORKSPACE_PROBE, "/", 20);
      if (res.ok) {
        const body = (await res.json()) as { result?: string };
        const last = (body.result ?? "").trim().split("\n").at(-1)?.trim() ?? "";
        if (/^\/[\w./-]+$/.test(last)) root = last;
      }
    } catch {
      // Keep /workspace.
    }
    roots.set(id, root);
    return root;
  }

  const absIn = (root: string, path: string) => {
    const rel = workspacePath(path);
    return rel ? `${root}/${rel}` : root;
  };
  const abs = async (id: string, path: string) => absIn(await rootOf(id), path);
  /** What agents read: the real root shown as `/workspace`, and no provider name. */
  const mask = (text: string, root: string) =>
    maskProvider(root === WORKSPACE ? text : text.split(root).join(WORKSPACE));

  async function exec(id: string, request: ExecRequest): Promise<ExecResult> {
    const root = await rootOf(id);
    const marker = `__agentes_${crypto.randomUUID().replace(/-/g, "")}__`;
    let res: Response;
    try {
      res = await run(
        id,
        splitOutputScript(request.command, marker),
        request.cwd ? absIn(root, request.cwd) : root,
        request.timeoutSeconds,
        request.signal,
      );
    } catch (error) {
      // A blocking call can't be killed: we stop waiting, the command may still finish on the machine.
      if (error instanceof ExecCanceledError) return canceledResult("", "", false);
      throw error;
    }
    if (res.status === 408) return { exitCode: 124, stdout: "", stderr: "", timedOut: true };
    if (!res.ok) return fail(res, "the command");
    const body = (await res.json()) as { exitCode?: number; result?: string };
    const { stdout, stderr } = parseSplitOutput(body.result ?? "", marker);
    const exitCode = body.exitCode ?? 0;
    return { exitCode, stdout: mask(stdout, root), stderr: mask(stderr, root), timedOut: exitCode === 124 };
  }

  /**
   * A command in its own shell session, run in the background: we poll its
   * logs (stdout and stderr apart) and pass on what's new, until it ends or
   * the timeout passes. Falls back to the blocking `exec` when sessions fail.
   */
  async function execStream(
    id: string,
    request: ExecRequest,
    onOutput: (stream: "stdout" | "stderr", chunk: string) => void,
  ): Promise<ExecResult> {
    const root = await rootOf(id);
    const sessionId = `agentes-${crypto.randomUUID()}`;
    const base = await toolboxUrl(id, "/process/session");
    const json = { "content-type": "application/json", accept: "application/json" };
    const created = await call(base, { method: "POST", headers: json, body: JSON.stringify({ sessionId }) });
    if (!created.ok) return exec(id, request);
    try {
      const cwd = request.cwd ? absIn(root, request.cwd) : root;
      const started = await call(`${base}/${sessionId}/exec`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ command: `cd ${shellQuote(cwd)} && ${request.command}`, runAsync: true }),
      });
      if (!started.ok) return exec(id, request);
      const { cmdId } = (await started.json()) as { cmdId?: string };
      if (!cmdId) return exec(id, request);
      const sent = { stdout: 0, stderr: 0 };
      let out = { stdout: "", stderr: "" };
      const deadline = Date.now() + (request.timeoutSeconds + 5) * 1000;
      const pull = async () => {
        const res = await call(`${base}/${sessionId}/command/${cmdId}/logs`, {
          headers: { accept: "application/json" },
        });
        if (!res.ok) return;
        const text = await res.text();
        let logs: { stdout?: string; stderr?: string };
        try {
          logs = JSON.parse(text) as { stdout?: string; stderr?: string };
        } catch {
          logs = { stdout: text };
        }
        out = { stdout: mask(logs.stdout ?? "", root), stderr: mask(logs.stderr ?? "", root) };
        for (const stream of ["stdout", "stderr"] as const) {
          if (out[stream].length > sent[stream]) {
            onOutput(stream, out[stream].slice(sent[stream]));
            sent[stream] = out[stream].length;
          }
        }
      };
      for (;;) {
        await Bun.sleep(streamPollMs);
        // Canceled: deleting the session (finally) kills the command.
        if (request.signal?.aborted) return canceledResult(out.stdout, out.stderr, true);
        await pull();
        const res = await call(`${base}/${sessionId}/command/${cmdId}`, { headers: { accept: "application/json" } });
        const cmd = res.ok ? ((await res.json()) as { exitCode?: number | null }) : null;
        if (cmd && typeof cmd.exitCode === "number") {
          await pull();
          return { exitCode: cmd.exitCode, stdout: out.stdout, stderr: out.stderr, timedOut: cmd.exitCode === 124 };
        }
        if (Date.now() > deadline) return { ...out, exitCode: 124, timedOut: true };
      }
    } finally {
      await call(`${base}/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
    }
  }

  return {
    id: "daytona",
    execStream,
    async create(spec) {
      const base = {
        labels: spec.labels,
        env: {},
        public: false,
        autoStopInterval: spec.autoStopMinutes,
        autoArchiveInterval: spec.autoArchiveMinutes,
        // Negative = never deleted on its own: the agent's files stay until a person deletes the computer.
        autoDeleteInterval: -1,
        ...(options.target ? { target: options.target } : {}),
        ...(options.snapshot ? { snapshot: options.snapshot, user: "agente" } : {}),
      };
      const wanted = networkModeOf(spec);
      const network = networkBody(wanted, spec.allowDomains);
      let mode: SandboxInfo["network"] = wanted;
      let res = await call(`${api}/sandbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...base, ...network }),
        timeoutMs: 60_000,
      });
      if ((res.status === 400 || res.status === 403) && /network|tier/i.test(await res.clone().text())) {
        mode = "provider-default";
        res = await call(`${api}/sandbox`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(base),
          timeoutMs: 60_000,
        });
      }
      if (!res.ok) return fail(res, "create sandbox");
      const created = (await res.json()) as DaytonaSandbox;
      networks.set(created.id, mode);
      info(created);
      const ready = await waitStarted(created.id);
      // The default image has no /workspace: make it now (or settle on the home fallback).
      if (!options.snapshot) await rootOf(created.id).catch(() => undefined);
      return ready;
    },
    async get(id) {
      const raw = await getRaw(id);
      return raw ? info(raw) : null;
    },
    async ensureStarted(id) {
      const raw = await getRaw(id);
      if (!raw) throw new SandboxGoneError();
      const s = info(raw);
      if (s.state === "started") return s;
      if (s.state === "error" || s.state === "destroyed") throw new SandboxGoneError(`the sandbox is ${raw.state}`);
      if (s.state === "stopped" || s.state === "archived") {
        const res = await call(`${api}/sandbox/${encodeURIComponent(id)}/start`, { method: "POST", timeoutMs: 60_000 });
        if (!res.ok && res.status !== 409) return fail(res, "start sandbox");
      }
      return waitStarted(id);
    },
    exec,
    async writeFile(id, path, data) {
      const rel = workspacePath(path);
      if (!rel) throw new Error("a file path is required");
      const target = await abs(id, rel);
      const res = await call(`${await toolboxUrl(id, "/files/upload-v2")}?path=${encodeURIComponent(target)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: data,
        timeoutMs: 60_000,
      });
      if (!res.ok) return fail(res, "the upload");
    },
    async readFile(id, path) {
      const target = await abs(id, path);
      const res = await call(`${await toolboxUrl(id, "/files/download")}?path=${encodeURIComponent(target)}`, {
        timeoutMs: 60_000,
      });
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) return fail(res, "the download");
      return new Uint8Array(await res.arrayBuffer());
    },
    async listFiles(id, path, depth = 1) {
      const root = await rootOf(id);
      const dir = absIn(root, path);
      const res = await call(
        `${await toolboxUrl(id, "/files")}?path=${encodeURIComponent(dir)}&depth=${Math.max(1, Math.min(depth, 5))}`,
      );
      if (res.status === 404) return [];
      if (!res.ok) return fail(res, "the file listing");
      const rows = (await res.json()) as { path?: string; name: string; isDir: boolean; size: number }[];
      return rows.map((r) => {
        const full = r.path ?? `${dir}/${r.name}`;
        const rel = full.startsWith(`${root}/`) ? full.slice(root.length + 1) : r.name;
        return { path: rel, isDir: r.isDir, size: r.size };
      });
    },
    async stop(id) {
      const res = await call(`${api}/sandbox/${encodeURIComponent(id)}/stop`, { method: "POST", timeoutMs: 60_000 });
      if (!res.ok && res.status !== 404 && res.status !== 409) return fail(res, "stop sandbox");
    },
    async destroy(id) {
      const res = await call(`${api}/sandbox/${encodeURIComponent(id)}`, { method: "DELETE", timeoutMs: 60_000 });
      toolbox.delete(id);
      networks.delete(id);
      roots.delete(id);
      if (!res.ok && res.status !== 404) return fail(res, "delete sandbox");
    },
    async setNetwork(id, mode, allowDomains) {
      // `networkBlockAll: false` lifts the block and clears the lists (open); one setting at a time.
      const body = mode === "open" ? { networkBlockAll: false } : networkBody(mode, allowDomains);
      const res = await call(`${api}/sandbox/${encodeURIComponent(id)}/network-settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 30_000,
      });
      if ((res.status === 400 || res.status === 403) && /network|tier/i.test(await res.clone().text())) {
        networks.set(id, "provider-default");
        return "provider-default";
      }
      if (!res.ok) return fail(res, "the network settings");
      networks.set(id, mode);
      return mode;
    },
  };
}

/** The create/update body of a network mode (Daytona takes at most one of these). */
function networkBody(mode: NetworkMode, allowDomains: string[]): Record<string, unknown> {
  if (mode === "open") return {};
  if (mode === "allowlist" && allowDomains.length > 0) {
    return { domainAllowList: allowDomains.slice(0, 100).join(",") };
  }
  return { networkBlockAll: true };
}

/** What the fake saw, for tests. */
export interface FakeSandboxCall {
  op: "create" | "exec" | "write" | "read" | "list" | "stop" | "destroy" | "start" | "network" | "kill" | "push";
  id?: string;
  spec?: SandboxSpec;
  request?: ExecRequest;
  path?: string;
  network?: { mode: NetworkMode; allowDomains: string[] };
}

/** What the fake's `pushFile` hands the test: the bytes it would PUT to `target.url`. */
export interface FakePush {
  target: PushTarget;
  name: string;
  bytes: Uint8Array;
  sha256: string;
  contentType: string;
}

/**
 * In-memory sandboxes for tests (no network). `exec` runs a handler the test
 * gives (default: echo-like results); files live in a map per sandbox. With
 * `push`, the fake also has `pushFile` (like a connected machine): it hands
 * the file (a folder: a stand-in `.zip` listing its files) to `push`, which
 * the test forwards to the upload endpoint; without it there is no `pushFile`.
 */
export function createFakeSandboxProvider(
  options: {
    exec?(
      request: ExecRequest,
      files: Map<string, Uint8Array>,
    ): ExecResult | Promise<ExecResult> | { delayMs: number; result: ExecResult };
    resources?: SandboxResources;
    push?(upload: FakePush): void | Promise<void>;
  } = {},
) {
  const boxes = new Map<
    string,
    { state: SandboxState; files: Map<string, Uint8Array>; spec: SandboxSpec; network: NetworkMode }
  >();
  const calls: FakeSandboxCall[] = [];
  const resources = options.resources ?? { cpu: 1, memoryGiB: 1, diskGiB: 3 };
  const box = (id: string) => {
    const b = boxes.get(id);
    if (!b || b.state === "destroyed") throw new SandboxGoneError();
    return b;
  };
  const view = (id: string): SandboxInfo => {
    const b = box(id);
    return { id, state: b.state, resources, network: b.network };
  };
  const provider: SandboxProvider & {
    calls: FakeSandboxCall[];
    boxes: typeof boxes;
    /** Simulate the provider's auto-stop or deletion. */
    setState(id: string, state: SandboxState): void;
  } = {
    id: "fake",
    calls,
    boxes,
    setState(id, state) {
      const b = boxes.get(id);
      if (b) b.state = state;
    },
    async create(spec) {
      const id = `sbx_${boxes.size + 1}_${crypto.randomUUID().slice(0, 6)}`;
      boxes.set(id, { state: "started", files: new Map(), spec, network: networkModeOf(spec) });
      calls.push({ op: "create", id, spec });
      return view(id);
    },
    async get(id) {
      const b = boxes.get(id);
      return b && b.state !== "destroyed" ? view(id) : null;
    },
    async ensureStarted(id) {
      const b = box(id);
      if (b.state !== "started") {
        calls.push({ op: "start", id });
        b.state = "started";
      }
      return view(id);
    },
    async execStream(id, request, onOutput) {
      const r = await provider.exec(id, request);
      if (r.canceled) return r;
      // Like a real stream: the output arrives in pieces.
      for (const stream of ["stdout", "stderr"] as const) {
        const text = r[stream];
        for (let i = 0; i < text.length; i += 1000) onOutput(stream, text.slice(i, i + 1000));
      }
      return r;
    },
    async exec(id, request) {
      const b = box(id);
      if (b.state !== "started") throw new SandboxProviderError("not running");
      calls.push({ op: "exec", id, request });
      const out = options.exec
        ? await options.exec(request, b.files)
        : { exitCode: 0, stdout: `ran: ${request.command}`, stderr: "", timedOut: false };
      if ("delayMs" in out) {
        // A canceled run kills the command at once (like the session delete on Daytona).
        const signal = request.signal;
        const aborted = signal
          ? new Promise<"canceled">((resolve) => {
              if (signal.aborted) resolve("canceled");
              signal.addEventListener("abort", () => resolve("canceled"), { once: true });
            })
          : null;
        const done = await Promise.race([
          Bun.sleep(out.delayMs).then(() => "done" as const),
          ...(aborted ? [aborted] : []),
        ]);
        if (done === "canceled") {
          calls.push({ op: "kill", id });
          return canceledResult("", "", true);
        }
        return out.result;
      }
      return out;
    },
    async writeFile(id, path, data) {
      calls.push({ op: "write", id, path });
      box(id).files.set(workspacePath(path), data);
    },
    async readFile(id, path) {
      calls.push({ op: "read", id, path });
      return box(id).files.get(workspacePath(path)) ?? null;
    },
    async listFiles(id, path) {
      calls.push({ op: "list", id, path });
      const prefix = workspacePath(path);
      return [...box(id).files.entries()]
        .filter(([p]) => !prefix || p.startsWith(`${prefix}/`))
        .map(([p, data]) => ({ path: p, isDir: false, size: data.byteLength }));
    },
    async stop(id) {
      calls.push({ op: "stop", id });
      const b = boxes.get(id);
      if (b && b.state !== "destroyed") b.state = "stopped";
    },
    async destroy(id) {
      calls.push({ op: "destroy", id });
      const b = boxes.get(id);
      if (b) b.state = "destroyed";
    },
    async setNetwork(id, mode, allowDomains) {
      calls.push({ op: "network", id, network: { mode, allowDomains } });
      box(id).network = mode;
      return mode;
    },
  };
  const push = options.push;
  if (push) {
    provider.pushFile = async (id, path, target) => {
      calls.push({ op: "push", id, path });
      const files = box(id).files;
      const rel = workspacePath(path);
      let name = rel.split("/").at(-1) ?? rel;
      let bytes = files.get(rel);
      if (!bytes) {
        const inside = [...files.keys()].filter((p) => p.startsWith(`${rel}/`));
        if (!rel || inside.length === 0) throw new SandboxProviderError(`not_found: ${path}`);
        name = `${name}.zip`;
        bytes = new TextEncoder().encode(`fake zip\n${inside.sort().join("\n")}\n`);
      }
      if (bytes.byteLength > target.maxBytes) throw new SandboxProviderError(`too_large: ${path}`);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const contentType = "application/octet-stream";
      await push({ target, name, bytes, sha256, contentType });
      return { name, size: bytes.byteLength, sha256, contentType };
    };
  }
  return provider;
}

export type FakeSandboxProvider = ReturnType<typeof createFakeSandboxProvider>;
