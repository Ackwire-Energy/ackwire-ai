/**
 * Isolated environments where agents run code (D30). Core talks to this
 * interface only; Cloud uses Daytona (REST API), tests use the fake. Nothing
 * secret ever goes in: no environment variables are passed, at creation or
 * per command, and the network is blocked unless the org allows domains.
 */
export interface SandboxResources {
  cpu: number;
  /** GiB. */
  memoryGiB: number;
  /** GiB. */
  diskGiB: number;
}

export type SandboxState = "creating" | "starting" | "started" | "stopped" | "archived" | "error" | "destroyed";

export interface SandboxSpec {
  /** Our key ("org:…:thread:…"), kept as a label for support; never a secret. */
  key: string;
  labels: Record<string, string>;
  /** Domains the sandbox may reach (`pypi.org`, `*.npmjs.org`). Empty = no network at all. */
  allowDomains: string[];
  /** Stop after this many idle minutes. */
  autoStopMinutes: number;
  /** Archive (files kept, cheaper storage) this many minutes after stopping. Never deleted automatically. */
  autoArchiveMinutes: number;
}

export interface SandboxInfo {
  id: string;
  state: SandboxState;
  resources: SandboxResources;
  /** How the network ended up: `blocked`, `allowlist`, or `provider-default` (the provider refused a per-sandbox policy). */
  network: "blocked" | "allowlist" | "provider-default";
}

export interface ExecRequest {
  command: string;
  /** Relative to the workspace (default: the workspace). */
  cwd?: string;
  timeoutSeconds: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SandboxFile {
  /** Relative to the workspace. */
  path: string;
  isDir: boolean;
  size: number;
}

export interface SandboxProvider {
  readonly id: string;
  /** Creates a sandbox and waits until it runs. */
  create(spec: SandboxSpec): Promise<SandboxInfo>;
  /** Null when it no longer exists. */
  get(id: string): Promise<SandboxInfo | null>;
  /** Starts a stopped or archived sandbox and waits; throws SandboxGoneError when it can't come back. */
  ensureStarted(id: string): Promise<SandboxInfo>;
  /** Runs a shell command in the workspace. No environment variables are passed. */
  exec(id: string, request: ExecRequest): Promise<ExecResult>;
  /** Paths are relative to the workspace; parents are created. */
  writeFile(id: string, path: string, data: Uint8Array): Promise<void>;
  /** Null when the file doesn't exist. */
  readFile(id: string, path: string): Promise<Uint8Array | null>;
  listFiles(id: string, path: string, depth?: number): Promise<SandboxFile[]>;
  stop(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
}

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
  /** Where the workspace lives inside the sandbox (the default user's home). */
  workspaceDir?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Tests: no waiting between polls. */
  pollMs?: number;
  readyTimeoutMs?: number;
}): SandboxProvider {
  const http = options.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const api = (options.apiUrl ?? "https://app.daytona.io/api").replace(/\/$/, "");
  const root = (options.workspaceDir ?? "/home/daytona/workspace").replace(/\/$/, "");
  const pollMs = options.pollMs ?? 1000;
  const readyTimeoutMs = options.readyTimeoutMs ?? 90_000;
  const toolbox = new Map<string, string>();
  const networks = new Map<string, SandboxInfo["network"]>();
  const auth = { authorization: `Bearer ${options.apiKey}` };

  async function call(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
    let res: Response;
    try {
      res = await http(url, {
        ...init,
        headers: { ...auth, ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new SandboxProviderError(`could not reach Daytona: ${error instanceof Error ? error.message : error}`);
    }
    return res;
  }

  async function fail(res: Response, what: string): Promise<never> {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status === 404) throw new SandboxGoneError(`${what}: not found`);
    throw new SandboxProviderError(`Daytona refused ${what} (${res.status}): ${text}`, res.status);
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
        throw new SandboxGoneError(`the sandbox is ${raw.state}${raw.errorReason ? `: ${raw.errorReason}` : ""}`);
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

  const abs = (path: string) => {
    const rel = workspacePath(path);
    return rel ? `${root}/${rel}` : root;
  };

  async function exec(id: string, request: ExecRequest): Promise<ExecResult> {
    const marker = `__agentes_${crypto.randomUUID().replace(/-/g, "")}__`;
    const script = splitOutputScript(request.command, marker);
    const encoded = Buffer.from(script, "utf8").toString("base64");
    const res = await call(await toolboxUrl(id, "/process/execute"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // No `envs`: nothing from our side reaches the command's environment.
      body: JSON.stringify({
        command: `sh -c "echo ${encoded} | base64 -d | sh"`,
        cwd: request.cwd ? abs(request.cwd) : root,
        timeout: request.timeoutSeconds,
      }),
      timeoutMs: (request.timeoutSeconds + 30) * 1000,
    });
    if (res.status === 408) return { exitCode: 124, stdout: "", stderr: "", timedOut: true };
    if (!res.ok) return fail(res, "the command");
    const body = (await res.json()) as { exitCode?: number; result?: string };
    const { stdout, stderr } = parseSplitOutput(body.result ?? "", marker);
    const exitCode = body.exitCode ?? 0;
    return { exitCode, stdout, stderr, timedOut: exitCode === 124 };
  }

  return {
    id: "daytona",
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
      };
      const network =
        spec.allowDomains.length > 0
          ? { domainAllowList: spec.allowDomains.slice(0, 100).join(",") }
          : { networkBlockAll: true };
      let mode: SandboxInfo["network"] = spec.allowDomains.length > 0 ? "allowlist" : "blocked";
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
      await exec(created.id, { command: `mkdir -p ${shellQuote(root)}`, timeoutSeconds: 15 }).catch(() => undefined);
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
      const res = await call(`${await toolboxUrl(id, "/files/upload-v2")}?path=${encodeURIComponent(abs(rel))}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: data,
        timeoutMs: 60_000,
      });
      if (!res.ok) return fail(res, "the upload");
    },
    async readFile(id, path) {
      const res = await call(`${await toolboxUrl(id, "/files/download")}?path=${encodeURIComponent(abs(path))}`, {
        timeoutMs: 60_000,
      });
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) return fail(res, "the download");
      return new Uint8Array(await res.arrayBuffer());
    },
    async listFiles(id, path, depth = 1) {
      const dir = abs(path);
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
      if (!res.ok && res.status !== 404) return fail(res, "delete sandbox");
    },
  };
}

/** What the fake saw, for tests. */
export interface FakeSandboxCall {
  op: "create" | "exec" | "write" | "read" | "list" | "stop" | "destroy" | "start";
  id?: string;
  spec?: SandboxSpec;
  request?: ExecRequest;
  path?: string;
}

/**
 * In-memory sandboxes for tests (no network). `exec` runs a handler the test
 * gives (default: echo-like results); files live in a map per sandbox.
 */
export function createFakeSandboxProvider(
  options: {
    exec?(
      request: ExecRequest,
      files: Map<string, Uint8Array>,
    ): ExecResult | Promise<ExecResult> | { delayMs: number; result: ExecResult };
    resources?: SandboxResources;
  } = {},
) {
  const boxes = new Map<string, { state: SandboxState; files: Map<string, Uint8Array>; spec: SandboxSpec }>();
  const calls: FakeSandboxCall[] = [];
  const resources = options.resources ?? { cpu: 1, memoryGiB: 1, diskGiB: 3 };
  const box = (id: string) => {
    const b = boxes.get(id);
    if (!b || b.state === "destroyed") throw new SandboxGoneError();
    return b;
  };
  const view = (id: string): SandboxInfo => {
    const b = box(id);
    return { id, state: b.state, resources, network: b.spec.allowDomains.length ? "allowlist" : "blocked" };
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
      boxes.set(id, { state: "started", files: new Map(), spec });
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
    async exec(id, request) {
      const b = box(id);
      if (b.state !== "started") throw new SandboxProviderError("not running");
      calls.push({ op: "exec", id, request });
      const out = options.exec
        ? await options.exec(request, b.files)
        : { exitCode: 0, stdout: `ran: ${request.command}`, stderr: "", timedOut: false };
      if ("delayMs" in out) {
        await Bun.sleep(out.delayMs);
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
  };
  return provider;
}

export type FakeSandboxProvider = ReturnType<typeof createFakeSandboxProvider>;
